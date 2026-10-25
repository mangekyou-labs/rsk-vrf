import { createPublicClient, createWalletClient, http, parseAbiItem, type Address, type Chain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { composeFulfillment, coordinatorAbi, KeyState, servesKey } from './coordinator.ts';
import type { ProvingKey } from './proving-key.ts';

export interface WorkerConfig {
  rpcUrl: string;
  coordinator: Address;
  chain: Chain;
  fulfillerPrivateKey: Hex;
  /** Loads the Proving Key for a registered keyHash from the secret store. Resolves
   * undefined if the store does not hold it; rejects on any other failure. */
  loadProvingKey: (keyHash: Hex) => Promise<ProvingKey | undefined>;
  relayUrl: string;
  fromBlock: bigint;
  nowSeconds?: () => bigint;
  fetch?: typeof globalThis.fetch;
}
/** One Active or Draining key after syncKeys. `error` is the load failure's message; it never carries a secret. */
export type KeySync = { keyId: number; keyHash: Hex; held: boolean; error?: string };
export type PollResult = { requestId: Hex; status: 'waiting' | 'skipped' | 'retry' | 'submitted'; transactionHash?: Hex };

/** Pending IDs survive round waits and failed simulations. Durable restart,
 * backfill and reorg handling belong to the production follow-up (#35). */
export function createWorker(config: WorkerConfig) {
  const publicClient = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) });
  const wallet = createWalletClient({ account: privateKeyToAccount(config.fulfillerPrivateKey), chain: config.chain, transport: http(config.rpcUrl) });
  const pending = new Set<Hex>();
  // Every Active or Draining key may still have Fulfillable requests, so each is held.
  const keys = new Map<string, Promise<ProvingKey | undefined>>();
  const keyFor = (keyHash: Hex) => {
    const id = keyHash.toLowerCase();
    let key = keys.get(id);
    if (!key) {
      // A failed load is forgotten so the next use retries; its error propagates unchanged.
      key = config.loadProvingKey(keyHash).then(
        loaded => (loaded && loaded.keyHash.toLowerCase() === id ? loaded : undefined),
        (error: unknown) => {
          keys.delete(id);
          throw error;
        },
      );
      keys.set(id, key);
    }
    return key;
  };
  const held = new Set<string>();
  const evict = (keyHash: Hex) => {
    keys.delete(keyHash.toLowerCase());
    held.delete(keyHash.toLowerCase());
  };
  const readKey = (keyId: number) =>
    publicClient.readContract({ address: config.coordinator, abi: coordinatorAbi, functionName: 'getProvingKey', args: [keyId], blockTag: 'latest' });
  let synced = false;
  /** Loads every Active and Draining key and evicts the rest. Key ids run 1..n with no gaps. */
  async function syncKeys(): Promise<KeySync[]> {
    const report: KeySync[] = [];
    for (let keyId = 1; ; keyId++) {
      const [keyHash, , state] = await readKey(keyId);
      if (state === KeyState.None) break;
      if (!servesKey(state)) {
        evict(keyHash);
        continue;
      }
      try {
        const loaded = await keyFor(keyHash);
        if (loaded) held.add(keyHash.toLowerCase());
        else evict(keyHash);
        report.push({ keyId, keyHash, held: loaded !== undefined });
      } catch (error) {
        held.delete(keyHash.toLowerCase());
        report.push({ keyId, keyHash, held: false, error: error instanceof Error ? error.message : 'Proving Key load failed' });
      }
    }
    synced = true;
    return report;
  }
  let cursor = config.fromBlock;
  const fetchRelay = config.fetch ?? globalThis.fetch;
  const now = config.nowSeconds ?? (() => BigInt(Math.floor(Date.now() / 1000)));
  return {
    syncKeys,
    /** The keyHashes of the Proving Keys currently held in memory. */
    heldKeys: () => [...held] as Hex[],
    async pollOnce(): Promise<PollResult[]> {
      const latest = await publicClient.getBlockNumber({ cacheTime: 0 });
      if (cursor <= latest) {
        const logs = await publicClient.getLogs({ address: config.coordinator, event: parseAbiItem('event RandomnessRequested(bytes32 indexed requestId, address indexed requester, bytes32 tag, uint32 keyId, uint64 targetRound, uint48 requestBlock, uint48 deadline, uint96 fee, uint32 callbackGasCap)'), fromBlock: cursor, toBlock: latest, strict: true });
        for (const log of logs) pending.add(log.args.requestId);
        const changes = await publicClient.getLogs({
          address: config.coordinator,
          event: parseAbiItem('event KeyStateChanged(uint32 keyId, uint8 state)'),
          fromBlock: cursor,
          toBlock: latest,
        });
        if (changes.length > 0) synced = false;
        cursor = latest + 1n;
      }
      if (!synced) await syncKeys();
      const results: PollResult[] = [];
      for (const requestId of pending) {
        try {
          const request = await publicClient.readContract({ address: config.coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [requestId], blockTag: 'latest' });
          if (request.status !== 1 || latest > BigInt(request.deadline)) {
            pending.delete(requestId); results.push({ requestId, status: 'skipped' }); continue;
          }
          const beacon = await publicClient.readContract({ address: config.coordinator, abi: coordinatorAbi, functionName: 'getDrandConfig', args: [request.drandConfigId], blockTag: 'latest' });
          if (latest < BigInt(request.requestBlock) + BigInt(request.confirmations) || now() < beacon.genesis + (request.targetRound - 1n) * beacon.period) {
            results.push({ requestId, status: 'waiting' }); continue;
          }
          const [keyHash, , state] = await publicClient.readContract({ address: config.coordinator, abi: coordinatorAbi, functionName: 'getProvingKey', args: [request.keyId], blockTag: 'latest' });
          // Checked per request too: Retired is derived from block height and emits no event.
          if (!servesKey(state)) evict(keyHash);
          const provingKey = servesKey(state) ? await keyFor(keyHash) : undefined;
          if (provingKey) held.add(keyHash.toLowerCase());
          if (!provingKey) {
            pending.delete(requestId); results.push({ requestId, status: 'skipped' }); continue;
          }
          const response = await fetchRelay(`${config.relayUrl.replace(/\/$/, '')}/public/${request.targetRound}`, { signal: AbortSignal.timeout(10_000) });
          if (!response.ok) throw new Error('Beacon unavailable');
          const body: unknown = await response.json();
          if (typeof body !== 'object' || body === null || !('round' in body) || BigInt(String(body.round)) !== request.targetRound || !('signature' in body) || typeof body.signature !== 'string') throw new Error('Invalid beacon response');
          const signature = (body.signature.startsWith('0x') ? body.signature : `0x${body.signature}`) as Hex;
          const composed = composeFulfillment({ chainId: BigInt(config.chain.id), coordinator: config.coordinator, requester: request.requester, requestId, targetRound: request.targetRound, signature }, provingKey);
          const { request: simulated } = await publicClient.simulateContract({ address: config.coordinator, abi: coordinatorAbi, functionName: 'fulfill', args: [requestId, composed.proof, composed.drandSignature], account: wallet.account, type: 'legacy', gas: 5_000_000n, gasPrice: (await publicClient.getGasPrice()) || 1n });
          const transactionHash = await wallet.writeContract(simulated);
          pending.delete(requestId);
          results.push({ requestId, status: 'submitted', transactionHash });
        } catch {
          // SDK errors can include signing payloads; report only a safe outcome.
          results.push({ requestId, status: 'retry' });
        }
      }
      return results;
    },
  };
}
