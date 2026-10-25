import { createPublicClient, createWalletClient, http, parseAbiItem, type Address, type Chain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { composeFulfillment, coordinatorAbi } from './coordinator.ts';
import type { ProvingKey } from './proving-key.ts';

export interface WorkerConfig {
  rpcUrl: string;
  coordinator: Address;
  chain: Chain;
  fulfillerPrivateKey: Hex;
  provingKey: ProvingKey;
  relayUrl: string;
  fromBlock: bigint;
  nowSeconds?: () => bigint;
  fetch?: typeof globalThis.fetch;
}
export type PollResult = { requestId: Hex; status: 'waiting' | 'skipped' | 'retry' | 'submitted'; transactionHash?: Hex };

/** Pending IDs survive round waits and failed simulations. Durable restart,
 * backfill and reorg handling belong to the production follow-up (#35). */
export function createWorker(config: WorkerConfig) {
  const publicClient = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) });
  const wallet = createWalletClient({ account: privateKeyToAccount(config.fulfillerPrivateKey), chain: config.chain, transport: http(config.rpcUrl) });
  const pending = new Set<Hex>();
  let cursor = config.fromBlock;
  const fetchRelay = config.fetch ?? globalThis.fetch;
  const now = config.nowSeconds ?? (() => BigInt(Math.floor(Date.now() / 1000)));
  return {
    async pollOnce(): Promise<PollResult[]> {
      const latest = await publicClient.getBlockNumber({ cacheTime: 0 });
      if (cursor <= latest) {
        const logs = await publicClient.getLogs({ address: config.coordinator, event: parseAbiItem('event RandomnessRequested(bytes32 indexed requestId, address indexed requester, bytes32 tag, uint32 keyId, uint64 targetRound, uint48 requestBlock, uint48 deadline, uint96 fee, uint32 callbackGasCap)'), fromBlock: cursor, toBlock: latest, strict: true });
        for (const log of logs) pending.add(log.args.requestId);
        cursor = latest + 1n;
      }
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
          if (state === 0 || keyHash.toLowerCase() !== config.provingKey.keyHash.toLowerCase()) {
            pending.delete(requestId); results.push({ requestId, status: 'skipped' }); continue;
          }
          const response = await fetchRelay(`${config.relayUrl.replace(/\/$/, '')}/public/${request.targetRound}`, { signal: AbortSignal.timeout(10_000) });
          if (!response.ok) throw new Error('Beacon unavailable');
          const body: unknown = await response.json();
          if (typeof body !== 'object' || body === null || !('round' in body) || BigInt(String(body.round)) !== request.targetRound || !('signature' in body) || typeof body.signature !== 'string') throw new Error('Invalid beacon response');
          const signature = (body.signature.startsWith('0x') ? body.signature : `0x${body.signature}`) as Hex;
          const composed = composeFulfillment({ chainId: BigInt(config.chain.id), coordinator: config.coordinator, requester: request.requester, requestId, targetRound: request.targetRound, signature }, config.provingKey);
          // Budget verification at its measured worst case (642k) plus the 10k
          // callback reserve and the entire frozen Callback Gas Cap. Estimation
          // sees only today's callback path and can underfund a later path.
          const { request: simulated } = await publicClient.simulateContract({ address: config.coordinator, abi: coordinatorAbi, functionName: 'fulfill', args: [requestId, composed.proof, composed.drandSignature], account: wallet.account, type: 'legacy', gas: 652_000n + BigInt(request.callbackGasCap), gasPrice: (await publicClient.getGasPrice()) || 1n });
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
