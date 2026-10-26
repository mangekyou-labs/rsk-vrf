import { createPublicClient, decodeFunctionData, encodeFunctionData, http, parseAbiItem, type AbiEvent, type Address, type Chain, type Hex } from 'viem';
import { sendRawTransaction } from 'viem/actions';
import { privateKeyToAccount } from 'viem/accounts';
import { composeFulfillment, coordinatorAbi, KeyState, servesKey } from './coordinator.ts';
import type { ProvingKey } from './proving-key.ts';
import { createWatchdog, type WatchdogConfig } from './watchdog.ts';

/** Local copy of a drand beacon. Chain config is used only after it matches this pin. */
export interface DrandPin {
  publicKey: readonly [bigint, bigint, bigint, bigint];
  genesis: bigint;
  period: bigint;
}

export interface WorkerConfig {
  rpcUrl: string;
  watchdog?: WatchdogConfig;
  coordinator: Address;
  chain: Chain;
  fulfillerPrivateKey: Hex;
  /** Loads the Proving Key for a registered keyHash from the secret store. Resolves
   * undefined if the store does not hold it; rejects on any other failure. */
  loadProvingKey: (keyHash: Hex) => Promise<ProvingKey | undefined>;
  /** Required. Public key, genesis, and period pinned for this process. */
  drandPin: DrandPin;
  /** One relay. Ignored when `relayUrls` is non-empty. */
  relayUrl?: string;
  /** Tried in order. The first well-formed `/public/<round>` wins. */
  relayUrls?: readonly string[];
  /** Blocks after the request's confirmations before a fulfill. Primary is 0; backup is 100. */
  graceBlocks?: number;
  nowSeconds?: () => bigint;
  fetch?: typeof globalThis.fetch;
  /** Operator line. Defaults to stderr. Must not receive key material. */
  report?: (line: string) => void;
}
/** One Active or Draining key after syncKeys. `error` is the load failure's message; it never carries a secret. */
export type KeySync = { keyId: number; keyHash: Hex; held: boolean; error?: string };
export type PollResult = { requestId: Hex; status: 'waiting' | 'skipped' | 'retry' | 'submitted' | 'stalled'; transactionHash?: Hex };

/** Every relay failed to serve this round. Distinct from a failed simulation. */
class BeaconUnavailable extends Error {
  readonly relays: readonly string[];
  constructor(relays: readonly string[]) {
    super('Beacon unavailable');
    this.relays = relays;
  }
}

/** Account nonce could not be read. The poll aborts without a send. */
class NonceSyncError extends Error {
  constructor() {
    super('worker: nonce resync failed');
  }
}

const BACKFILL_BLOCKS = 2_400n + 100n;
const MAX_LOG_SPAN = 5_000n;
const OUTCOME_DEPTH = 12n;
const REQUEST_STATUS = { NONE: 0, PENDING: 1, FULFILLED: 2, REFUNDED: 3 } as const;
// One-try verification headroom plus the callback's post-call reserve.
const VERIFICATION_AND_RESERVE_GAS = 652_000n;
const ADDITIONAL_HASH_TO_CURVE_GAS = 20_000n; // Spec measurement is about 15k.
// Reconciliation runs before proofs are available. Its balance floor covers
// twenty maximum-cap callbacks; a proof above this allowance raises the floor.
const RESERVE_FULFILL_GAS = VERIFICATION_AND_RESERVE_GAS + 2_500_000n;
const MAX_IN_FLIGHT = 8;
const REPLACEMENT_DELAY = 3n;
const SELF_GAS = 21_000n;
export const RESERVE_FULFILLS = 20n;

const requestedEvent = parseAbiItem('event RandomnessRequested(bytes32 indexed requestId, address indexed requester, bytes32 tag, uint32 keyId, uint64 targetRound, uint48 requestBlock, uint48 deadline, uint96 fee, uint32 callbackGasCap)');
const fulfilledEvent = parseAbiItem('event Fulfilled(bytes32 indexed requestId, bytes32 beta, address indexed fulfiller)');
const refundedEvent = parseAbiItem('event Refunded(bytes32 indexed requestId, uint8 reason)');
const keyRegisteredEvent = parseAbiItem('event KeyRegistered(uint32 keyId, bytes32 keyHash, address payee)');
const keyStateChangedEvent = parseAbiItem('event KeyStateChanged(uint32 keyId, uint8 state)');

type OutcomeLog = { blockNumber: bigint | null; blockHash: Hex | null; logIndex: number | null; args: { requestId: Hex; fulfiller?: Address; reason?: number } };
type Inflight = {
  nonce: number;
  requestId: Hex | null;
  hash: Hex;
  serialized: Hex | null;
  gasPrice: bigint;
  gas: bigint;
  submittedBlock: bigint;
  to: Address | null;
  data: Hex;
  value: bigint;
  canResign: boolean;
};
type Fulfillable = {
  requestId: Hex;
  requester: Address;
  targetRound: bigint;
  deadline: bigint;
  drandConfigId: number;
  roundTime: bigint;
  callbackGasCap: number;
  provingKey: ProvingKey;
};

function isLogCapError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return /limit|too many|exceed|more than|20[,_ ]?000|response size|query returned more/i.test(message);
}

function quantity(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && value !== '' && value !== '0x') {
    try { return BigInt(value); } catch { return 0n; }
  }
  return 0n;
}

function asNonce(value: bigint): number | null {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(value);
}

/** Start price is 1.1× the higher of network and minimum, capped at 80× minimum − 1. */
function startPrice(network: bigint, minimum: bigint): { price: bigint; cap: bigint | null } {
  const cap = minimum > 0n ? 80n * minimum - 1n : null;
  let price = network > minimum ? network : minimum;
  price = (price * 11n) / 10n;
  if (cap != null && price > cap) price = cap;
  if (price === 0n) price = 1n;
  return { price, cap };
}

/** Null means the bump is below the pool's +40% rule, so the same bytes are rebroadcast. */
function replacementPrice(previous: bigint, cap: bigint | null): bigint | null {
  let next = (previous * 3n) / 2n;
  if (cap != null && next > cap) next = cap;
  if (next <= previous || next < (previous * 140n) / 100n) return null;
  return next;
}

/** Stateless backfill. An id stays until Fulfilled or Refunded is 12 blocks deep. */
export function createWorker(config: WorkerConfig) {
  const publicClient = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl), cacheTime: 0 });
  const account = privateKeyToAccount(config.fulfillerPrivateKey);
  const pending = new Map<Hex, { outcomeBlock: bigint | null }>();
  const finished = new Map<Hex, bigint>();
  const reportedGone = new Set<Hex>();
  const inflight = new Map<number, Inflight>();
  let nextNonce: number | null = null;
  let balance = 0n;
  let reserveCost = 0n;
  let unknownPending = false;
  const fetchRelay = config.fetch ?? globalThis.fetch;
  const now = config.nowSeconds ?? (() => BigInt(Math.floor(Date.now() / 1000)));
  const report = config.report ?? ((line: string) => process.stderr.write(`${line}\n`));
  const watchdog = createWatchdog(config.watchdog, report);
  const relays = (config.relayUrls && config.relayUrls.length > 0 ? config.relayUrls : config.relayUrl ? [config.relayUrl] : []).map(url => url.replace(/\/$/, ''));
  const stalled = new Set<Hex>();
  const incidentRefunds = new Set<Hex>();
  const publishedProofs = new Map<string, Record<string, unknown>>();
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
  // KeyStateChanged logs seen in the backfill window. A new or reorged-out log forces a resync.
  let keyChanges = '';
  /** Loads every Active and Draining key and evicts the rest. Key ids run 1..n with no gaps. */
  async function syncKeys(): Promise<KeySync[]> {
    const sync: KeySync[] = [];
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
        sync.push({ keyId, keyHash, held: loaded !== undefined });
      } catch (error) {
        held.delete(keyHash.toLowerCase());
        sync.push({ keyId, keyHash, held: false, error: error instanceof Error ? error.message : 'Proving Key load failed' });
      }
    }
    synced = true;
    return sync;
  }

  function pinMatches(beacon: { publicKey: readonly bigint[]; genesis: bigint; period: bigint }): boolean {
    if (beacon.genesis !== config.drandPin.genesis || beacon.period !== config.drandPin.period) return false;
    if (beacon.publicKey.length !== 4) return false;
    for (let i = 0; i < 4; i++) if (beacon.publicKey[i] !== config.drandPin.publicKey[i]) return false;
    return true;
  }

  function highestNonce(): number | null {
    let high: number | null = null;
    for (const nonce of inflight.keys()) if (high == null || nonce > high) high = nonce;
    return high;
  }

  function inflightFor(requestId: Hex): Inflight | undefined {
    const id = requestId.toLowerCase();
    for (const entry of inflight.values()) {
      if (entry.requestId != null && entry.requestId.toLowerCase() === id) return entry;
    }
    return undefined;
  }

  async function pendingCountOrThrow(): Promise<number> {
    try {
      return await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
    } catch (error) {
      if (error instanceof NonceSyncError) throw error;
      throw new NonceSyncError();
    }
  }

  async function minedCountOrThrow(): Promise<number> {
    try {
      return await publicClient.getTransactionCount({ address: account.address, blockTag: 'latest' });
    } catch (error) {
      if (error instanceof NonceSyncError) throw error;
      throw new NonceSyncError();
    }
  }

  async function blockMinimum(): Promise<bigint> {
    const block: unknown = await publicClient.request({ method: 'eth_getBlockByNumber' as never, params: ['latest', false] as never });
    if (block == null || typeof block !== 'object') return 0n;
    return quantity('minimumGasPrice' in block ? block.minimumGasPrice : undefined);
  }

  async function findReceipt(hash: Hex) {
    try {
      return await publicClient.getTransactionReceipt({ hash });
    } catch {
      return null;
    }
  }

  async function findTransaction(hash: Hex) {
    try {
      return await publicClient.getTransaction({ hash });
    } catch {
      return null;
    }
  }

  /** Assigns the nonce in the local map only after the node accepts the bytes. */
  async function publish(fields: Inflight): Promise<Hex | null> {
    let reserved = 0n;
    for (const entry of inflight.values()) reserved += entry.gas * entry.gasPrice;
    const candidateReserve = RESERVE_FULFILLS * fields.gas * fields.gasPrice;
    if (balance - reserved < reserveCost || balance - reserved < candidateReserve) {
      await watchdog.alert('page', 'low_balance', { balance, available: balance - reserved, required: candidateReserve > reserveCost ? candidateReserve : reserveCost });
      return null;
    }
    if (fields.serialized == null && (!fields.canResign || fields.to == null)) return null;
    try {
      const to = fields.to;
      const signed = fields.serialized ?? (to == null ? null : await account.signTransaction({
        to, data: fields.data, gas: fields.gas, gasPrice: fields.gasPrice, nonce: fields.nonce, value: fields.value, type: 'legacy', chainId: config.chain.id,
      }));
      if (signed == null) return null;
      const serialized = signed as Hex;
      const hash = await sendRawTransaction(publicClient, { serializedTransaction: serialized });
      inflight.set(fields.nonce, {
        nonce: fields.nonce, requestId: fields.requestId, hash, serialized, gasPrice: fields.gasPrice, gas: fields.gas,
        submittedBlock: fields.submittedBlock, to: fields.to, data: fields.data, value: fields.value, canResign: fields.canResign,
      });
      const high = highestNonce();
      nextNonce = Math.max(nextNonce ?? 0, fields.nonce + 1, (high ?? -1) + 1);
      return hash;
    } catch {
      nextNonce = null;
      return null;
    }
  }

  async function republish(entry: Inflight): Promise<Hex | null> {
    if (entry.serialized != null) return publish({ ...entry });
    if (!entry.canResign || entry.to == null) return null;
    return publish({ ...entry, serialized: null });
  }

  async function simulateReplacement(entry: Inflight, gasPrice: bigint): Promise<boolean> {
    if (entry.to == null) return false;
    try {
      const decoded = decodeFunctionData({ abi: coordinatorAbi, data: entry.data });
      if (decoded.functionName !== 'fulfill') return false;
      await publicClient.simulateContract({
        address: config.coordinator, abi: coordinatorAbi, functionName: 'fulfill', args: decoded.args as never,
        account, type: 'legacy', gas: entry.gas, gasPrice,
      });
      return true;
    } catch {
      return false;
    }
  }

  function parsePoolNonce(txNonce: unknown, key: string): number | null {
    if (txNonce != null) return asNonce(quantity(txNonce));
    if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(key)) return null;
    return asNonce(quantity(key));
  }

  /** Optional. A missing txpool leaves the local map unchanged. */
  async function adoptTxpool(latest: bigint): Promise<void> {
    try {
      const content: unknown = await publicClient.request({ method: 'txpool_content' as never, params: [] as never });
      if (content == null || typeof content !== 'object' || !('pending' in content) || content.pending == null || typeof content.pending !== 'object') return;
      const address = account.address.toLowerCase();
      let bucket: Record<string, unknown> | undefined;
      for (const [key, value] of Object.entries(content.pending)) {
        if (key.toLowerCase() === address && value != null && typeof value === 'object') {
          bucket = value as Record<string, unknown>;
          break;
        }
      }
      if (bucket == null) return;
      for (const [key, raw] of Object.entries(bucket)) {
        try {
          if (raw == null || typeof raw !== 'object') continue;
          const tx = raw as Record<string, unknown>;
          const nonce = parsePoolNonce(tx.nonce, key);
          if (nonce == null || inflight.has(nonce)) continue;
          const hashRaw = tx.hash;
          if (typeof hashRaw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(hashRaw)) continue;
          const dataRaw = tx.input ?? tx.data;
          const data: Hex = typeof dataRaw === 'string' && dataRaw.startsWith('0x') ? dataRaw as Hex : '0x';
          const toRaw = tx.to;
          const to: Address | null = typeof toRaw === 'string' && /^0x[0-9a-fA-F]{40}$/.test(toRaw) ? toRaw as Address : null;
          let requestId: Hex | null = null;
          if (to != null && to.toLowerCase() === config.coordinator.toLowerCase() && data !== '0x') {
            try {
              const decoded = decodeFunctionData({ abi: coordinatorAbi, data });
              if (decoded.functionName === 'fulfill') {
                const args = decoded.args as readonly unknown[] | undefined;
                const first = args?.[0];
                if (typeof first === 'string' && /^0x[0-9a-fA-F]{64}$/.test(first) && inflightFor(first as Hex) == null) requestId = first as Hex;
              }
            } catch {
              // Occupy the nonce even when the calldata is not a fulfillment.
            }
          }
          inflight.set(nonce, {
            nonce, requestId, hash: hashRaw as Hex, serialized: null, gasPrice: quantity(tx.gasPrice), gas: quantity(tx.gas ?? tx.gasLimit),
            submittedBlock: latest, to, data, value: quantity(tx.value), canResign: to != null,
          });
        } catch {
          // One malformed pool entry does not drop the rest.
        }
      }
    } catch {
      // txpool_content is optional on regtest.
    }
  }

  async function fillGaps(minedNonce: number, price: bigint, latest: bigint): Promise<void> {
    const high = highestNonce();
    const localNext = nextNonce == null ? (high == null ? minedNonce : high + 1) : Math.max(nextNonce, high == null ? minedNonce : high + 1);
    for (let nonce = minedNonce; nonce < localNext; nonce++) {
      if (inflight.size >= MAX_IN_FLIGHT) break;
      if (inflight.has(nonce)) continue;
      const hash = await publish({
        nonce, requestId: null, hash: '0x', serialized: null, gasPrice: price, gas: SELF_GAS, submittedBlock: latest,
        to: account.address, data: '0x', value: 0n, canResign: true,
      });
      if (hash == null) break;
    }
  }

  async function ensureNonce(): Promise<number> {
    if (nextNonce == null) {
      const pendingCount = await pendingCountOrThrow();
      const high = highestNonce();
      nextNonce = Math.max(pendingCount, high == null ? pendingCount : high + 1);
    }
    let nonce = nextNonce;
    while (inflight.has(nonce)) nonce += 1;
    nextNonce = nonce;
    return nonce;
  }

  async function reconcile(latest: bigint, price: bigint, cap: bigint | null): Promise<void> {
    await adoptTxpool(latest);
    let minedNonce = await minedCountOrThrow();
    for (const entry of [...inflight.values()]) {
      try {
        if (entry.nonce < minedNonce) {
          inflight.delete(entry.nonce);
          continue;
        }
        if (await findReceipt(entry.hash) != null) {
          inflight.delete(entry.nonce);
          continue;
        }
        const missing = await findTransaction(entry.hash) == null;
        if (latest < entry.submittedBlock + REPLACEMENT_DELAY) {
          if (missing) await republish(entry);
          continue;
        }
        const bumped = replacementPrice(entry.gasPrice, cap);
        if (bumped == null || !entry.canResign || entry.to == null) {
          await republish(entry);
          continue;
        }
        if (entry.requestId != null && !(await simulateReplacement(entry, bumped))) {
          if (missing) await republish(entry);
          continue;
        }
        await publish({ ...entry, serialized: null, gasPrice: bumped, submittedBlock: latest });
      } catch (error) {
        if (error instanceof NonceSyncError) throw error;
      }
    }
    minedNonce = await minedCountOrThrow();
    const pendingNonce = await pendingCountOrThrow();
    unknownPending = inflight.size === 0 && pendingNonce > minedNonce;
    if (unknownPending) {
      nextNonce = null;
      return;
    }
    await fillGaps(minedNonce, price, latest);
    if (nextNonce == null) {
      const high = highestNonce();
      nextNonce = Math.max(await pendingCountOrThrow(), high == null ? minedNonce : high + 1);
    }
  }

  /** First well-formed round signature. A bad relay is skipped; a 64-byte signature stops the walk. */
  async function fetchSignature(round: bigint): Promise<Hex> {
    const failed: string[] = [];
    for (const relay of relays) {
      try {
        const response = await fetchRelay(`${relay}/public/${round}`, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) { failed.push(relay); continue; }
        const body: unknown = await response.json();
        if (typeof body !== 'object' || body === null || !('round' in body) || !('signature' in body) || typeof body.signature !== 'string') { failed.push(relay); continue; }
        if (BigInt(String(body.round)) !== round) { failed.push(relay); continue; }
        const signature = body.signature.startsWith('0x') ? body.signature : `0x${body.signature}`;
        if (!/^0x[0-9a-fA-F]{128}$/.test(signature)) { failed.push(relay); continue; }
        return signature as Hex;
      } catch {
        failed.push(relay);
      }
    }
    throw new BeaconUnavailable(failed);
  }

  /** Health on the relays that failed the round. The body is not a signature and is not logged. */
  async function probeHealth(failed: readonly string[]): Promise<void> {
    await Promise.all(failed.map(async relay => {
      try {
        await fetchRelay(`${relay}/v2/beacons/evmnet/health`, { signal: AbortSignal.timeout(10_000) });
      } catch {
        // A dead health route still leaves the request pending.
      }
    }));
  }

  async function logsFor(event: AbiEvent, fromBlock: bigint, toBlock: bigint): Promise<OutcomeLog[]> {
    if (toBlock < fromBlock) return [];
    const span = toBlock - fromBlock + 1n;
    if (span > MAX_LOG_SPAN) {
      const mid = fromBlock + (toBlock - fromBlock) / 2n;
      return [...await logsFor(event, fromBlock, mid), ...await logsFor(event, mid + 1n, toBlock)];
    }
    try {
      const logs = await publicClient.getLogs({ address: config.coordinator, event, fromBlock, toBlock, strict: true });
      const parsed: OutcomeLog[] = [];
      for (const log of logs) {
        if (!('args' in log) || log.args == null || typeof log.args !== 'object' || !('requestId' in log.args)) continue;
        const requestId = log.args.requestId;
        if (typeof requestId !== 'string' || !requestId.startsWith('0x')) continue;
        const fulfiller = 'fulfiller' in log.args && typeof log.args.fulfiller === 'string' ? log.args.fulfiller as Address : undefined;
        const reason = 'reason' in log.args && typeof log.args.reason === 'number' ? log.args.reason : undefined;
        parsed.push({ blockNumber: log.blockNumber, blockHash: log.blockHash, logIndex: log.logIndex, args: { requestId: requestId as Hex, fulfiller, reason } });
      }
      return parsed;
    } catch (error) {
      if (span <= 1n || !isLogCapError(error)) throw error;
      const mid = fromBlock + (toBlock - fromBlock) / 2n;
      return [...await logsFor(event, fromBlock, mid), ...await logsFor(event, mid + 1n, toBlock)];
    }
  }

  /** Validate against the request's final valid block: current-state fulfill must reject after Deadline. */
  async function missedDeadline(requestId: Hex, request: { requester: Address; targetRound: bigint; deadline: number; keyId: number; drandConfigId: number; callbackGasCap: number }, latest: bigint): Promise<boolean> {
    if (!config.watchdog) return true;
    const binding = `${requestId}:${request.keyId}:${request.targetRound}:${request.drandConfigId}:${request.requester.toLowerCase()}`;
    let proof = publishedProofs.get(binding);
    let proofUnavailable = 'proof_validation_unavailable';
    if (!proof) {
      try {
        const [keyHash, , state] = await readKey(request.keyId);
        // Retirement prevents sending, but the withheld proof remains publishable.
        // Revocation still prohibits proving, including incident publication.
        proofUnavailable = 'proving_key_unavailable';
        const provingKey = state !== KeyState.Revoked && state !== KeyState.None ? await keyFor(keyHash) : undefined;
        if (!provingKey) {
          await watchdog.alert('page', 'missing_proving_key', { requestId, keyHash, keyId: request.keyId }, `missing_proving_key:${requestId}`);
          throw new Error('Proving Key unavailable');
        }
        const beacon = await publicClient.readContract({ address: config.coordinator, abi: coordinatorAbi, functionName: 'getDrandConfig', args: [request.drandConfigId], blockTag: 'latest' });
        proofUnavailable = 'drand_config_mismatch';
        if (!pinMatches(beacon)) {
          await watchdog.alert('page', 'drand_config_mismatch', { requestId, drandConfigId: request.drandConfigId }, `drand_config_mismatch:${request.drandConfigId}`);
          throw new Error('Pinned drand config mismatch');
        }
        proofUnavailable = 'drand_unavailable';
        const signature = await fetchSignature(request.targetRound);
        const input = { chainId: BigInt(config.chain.id), coordinator: config.coordinator, requester: request.requester, requestId, targetRound: request.targetRound, signature };
        const composed = composeFulfillment(input, provingKey);
        proofUnavailable = 'proof_validation_unavailable';
        await publicClient.simulateContract({
          address: config.coordinator, abi: coordinatorAbi, functionName: 'fulfill', args: [requestId, composed.proof, composed.drandSignature],
          account, blockNumber: BigInt(request.deadline), gasPrice: 0n,
          gas: VERIFICATION_AND_RESERVE_GAS + ADDITIONAL_HASH_TO_CURVE_GAS * BigInt(composed.hashToCurveTries - 1) + BigInt(request.callbackGasCap),
        });
        proof = { ...input, keyHash, keyId: request.keyId, drandConfigId: request.drandConfigId, ...composed };
        publishedProofs.set(binding, proof);
      } catch (error) {
        if (error instanceof BeaconUnavailable) {
          await watchdog.alert('warn', 'drand_stall', { requestId, drandConfigId: request.drandConfigId, targetRound: request.targetRound }, `drand_stall:${requestId}`);
        }
      }
    }
    const delivered = await watchdog.alert('page', 'missed_deadline', { requestId, deadline: request.deadline, block: latest, proof: proof ?? null, ...(proof ? {} : { proofUnavailable }) }, `missed_deadline:${binding}:${proof ? 'proof' : 'unavailable'}`);
    return proof != null && delivered;
  }

  return {
    syncKeys,
    /** The keyHashes of the Proving Keys currently held in memory. */
    heldKeys: () => [...held] as Hex[],
    async pollOnce(): Promise<PollResult[]> {
      try {
        let rpcFailed = false;
        const latest = await publicClient.getBlockNumber({ cacheTime: 0 });
        if (config.watchdog) {
          const syncing: unknown = await publicClient.request({ method: 'eth_syncing' as never, params: [] as never });
          if (syncing !== false) await watchdog.alert('warn', 'node_unhealthy', { reason: 'syncing' });
          else watchdog.clear('node_unhealthy');
        }
        const quoted = startPrice(await publicClient.getGasPrice(), await blockMinimum());
        balance = await publicClient.getBalance({ address: account.address });
        reserveCost = RESERVE_FULFILLS * RESERVE_FULFILL_GAS * quoted.price;
        let reserved = 0n;
        for (const entry of inflight.values()) reserved += entry.gas * entry.gasPrice;
        const available = balance - reserved;
        if (available < reserveCost) await watchdog.alert('page', 'low_balance', { balance, available, required: reserveCost });
        else watchdog.clear('low_balance');
        const topUpCost = (config.watchdog?.topUpFulfillments ?? 100n) * RESERVE_FULFILL_GAS * quoted.price;
        if (available < topUpCost) await watchdog.alert('warn', 'top_up_balance', { balance, available, required: topUpCost });
        else watchdog.clear('top_up_balance');
        await reconcile(latest, quoted.price, quoted.cap);
        const fromBlock = latest > BACKFILL_BLOCKS ? latest - BACKFILL_BLOCKS : 0n;
        const [requestedLogs, fulfilledLogs, refundedLogs] = await Promise.all([
          logsFor(requestedEvent, fromBlock, latest),
          logsFor(fulfilledEvent, fromBlock, latest),
          logsFor(refundedEvent, fromBlock, latest),
        ]);
        const changes = await publicClient.getLogs({ address: config.coordinator, event: keyStateChangedEvent, fromBlock, toBlock: latest });
        const registrations = await publicClient.getLogs({ address: config.coordinator, event: keyRegisteredEvent, fromBlock, toBlock: latest });
        for (const log of [...registrations, ...changes]) {
          if (log.blockNumber == null) continue;
          await watchdog.alert('page', 'key_registry_changed', { block: log.blockNumber, transactionHash: log.transactionHash, ...log.args }, `key_registry_changed:${log.blockHash}:${log.logIndex}`);
        }
        const changeIds = changes.map(log => `${log.blockHash}:${log.logIndex}`).join(',');
        if (changeIds !== keyChanges) synced = false;
        keyChanges = changeIds;
        if (!synced) await syncKeys();
        const ownedFulfillers = new Set([account.address, ...(config.watchdog?.allowedFulfillers ?? [])].map(address => address.toLowerCase()));
        for (const log of fulfilledLogs) {
          if (log.blockNumber == null || log.args.fulfiller == null || ownedFulfillers.has(log.args.fulfiller.toLowerCase())) continue;
          await watchdog.alert('page', 'foreign_fulfillment', { requestId: log.args.requestId, fulfiller: log.args.fulfiller, block: log.blockNumber }, `foreign_fulfillment:${log.blockHash}:${log.logIndex}`);
        }
        const deadlineRefunds = new Set(refundedLogs.filter(log => log.args.reason === 0).map(log => log.args.requestId));
        const requestInWindow = new Set<Hex>();
        for (const log of requestedLogs) {
          if (log.blockNumber == null) continue;
          requestInWindow.add(log.args.requestId);
          if (!pending.has(log.args.requestId) && !finished.has(log.args.requestId)) pending.set(log.args.requestId, { outcomeBlock: null });
        }
        const outcomeInScan = new Map<Hex, bigint>();
        for (const log of [...fulfilledLogs, ...refundedLogs]) {
          if (log.blockNumber == null) continue;
          const prior = outcomeInScan.get(log.args.requestId);
          if (prior == null || log.blockNumber < prior) outcomeInScan.set(log.args.requestId, log.blockNumber);
        }
        for (const [id, outcomeBlock] of finished) {
          const seen = outcomeInScan.get(id);
          if (seen != null) {
            if (latest < seen + OUTCOME_DEPTH) {
              finished.delete(id);
              pending.set(id, { outcomeBlock: seen });
            } else {
              finished.set(id, seen);
            }
          } else if (outcomeBlock > latest || outcomeBlock >= fromBlock) {
            finished.delete(id);
            pending.set(id, { outcomeBlock: null });
          }
        }
        for (const [id, state] of pending) {
          const seen = outcomeInScan.get(id);
          if (seen != null) state.outcomeBlock = seen;
          else if (state.outcomeBlock != null && (state.outcomeBlock > latest || state.outcomeBlock >= fromBlock)) state.outcomeBlock = null;
        }

        const results: PollResult[] = [];
        const fulfillable: Fulfillable[] = [];
        const signatures = new Map<bigint, Hex>();
        let oldest: { requestId: Hex; requestBlock: bigint; deadline: bigint } | undefined;
        for (const requestId of [...pending.keys()]) {
          const state = pending.get(requestId);
          if (!state) continue;
          try {
            const request = await publicClient.readContract({ address: config.coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [requestId], blockTag: 'latest' });
            if (request.status === REQUEST_STATUS.NONE) {
              pending.delete(requestId);
              if (!reportedGone.has(requestId)) {
                reportedGone.add(requestId);
                results.push({ requestId, status: 'skipped' });
              }
              continue;
            }
            reportedGone.delete(requestId);
            if (request.status === REQUEST_STATUS.REFUNDED && (deadlineRefunds.has(requestId) || incidentRefunds.has(requestId))) {
              incidentRefunds.add(requestId);
              if (!await missedDeadline(requestId, request, latest)) {
                results.push({ requestId, status: 'waiting' });
                continue;
              }
              incidentRefunds.delete(requestId);
            }
            if (request.status === REQUEST_STATUS.FULFILLED || request.status === REQUEST_STATUS.REFUNDED) {
              const depth = OUTCOME_DEPTH;
              const agedOut = state.outcomeBlock == null && !requestInWindow.has(requestId);
              if (agedOut || (state.outcomeBlock != null && latest >= state.outcomeBlock + depth)) {
                if (state.outcomeBlock != null) finished.set(requestId, state.outcomeBlock);
                pending.delete(requestId);
                continue;
              }
              results.push({ requestId, status: 'waiting' });
              continue;
            }
            if (request.status !== REQUEST_STATUS.PENDING) {
              results.push({ requestId, status: 'skipped' });
              continue;
            }
            if (!oldest || BigInt(request.requestBlock) < oldest.requestBlock) oldest = { requestId, requestBlock: BigInt(request.requestBlock), deadline: BigInt(request.deadline) };
            if (latest > BigInt(request.deadline)) {
              await missedDeadline(requestId, request, latest);
              results.push({ requestId, status: 'skipped' });
              continue;
            }
            const [keyHash, , keyState] = await publicClient.readContract({ address: config.coordinator, abi: coordinatorAbi, functionName: 'getProvingKey', args: [request.keyId], blockTag: 'latest' });
            // Checked per request too: Retired is derived from block height and emits no event.
            if (!servesKey(keyState)) evict(keyHash);
            let provingKey: ProvingKey | undefined;
            try { provingKey = servesKey(keyState) ? await keyFor(keyHash) : undefined; } catch { /* Missing key is paged below without exposing store errors. */ }
            if (provingKey) held.add(keyHash.toLowerCase());
            if (!provingKey) {
              if (servesKey(keyState)) await watchdog.alert('page', 'missing_proving_key', { requestId, keyHash, keyId: request.keyId }, `missing_proving_key:${requestId}`);
              results.push({ requestId, status: 'skipped' });
              continue;
            }
            watchdog.clear(`missing_proving_key:${requestId}`);
            const beacon = await publicClient.readContract({ address: config.coordinator, abi: coordinatorAbi, functionName: 'getDrandConfig', args: [request.drandConfigId], blockTag: 'latest' });
            if (!pinMatches(beacon)) {
              await watchdog.alert('page', 'drand_config_mismatch', { requestId, drandConfigId: request.drandConfigId }, `drand_config_mismatch:${request.drandConfigId}`);
              results.push({ requestId, status: 'skipped' });
              continue;
            }
            watchdog.clear(`drand_config_mismatch:${request.drandConfigId}`);
            const roundTime = config.drandPin.genesis + (request.targetRound - 1n) * config.drandPin.period;
            const confirmations = BigInt(request.confirmations);
            if (config.watchdog && latest >= BigInt(request.requestBlock) + confirmations && now() >= roundTime + 30n) {
              try {
                const signature = signatures.get(request.targetRound) ?? await fetchSignature(request.targetRound);
                signatures.set(request.targetRound, signature);
                watchdog.clear(`drand_stall:${requestId}`);
                stalled.delete(requestId);
              } catch (error) {
                if (!(error instanceof BeaconUnavailable)) throw error;
                if (!stalled.has(requestId)) { stalled.add(requestId); await probeHealth(error.relays); }
                await watchdog.alert('warn', 'drand_stall', { requestId, drandConfigId: request.drandConfigId, targetRound: request.targetRound }, `drand_stall:${requestId}`);
              }
            }
            const grace = BigInt(config.graceBlocks ?? 0);
            if (latest < BigInt(request.requestBlock) + confirmations + grace) {
              results.push({ requestId, status: 'waiting' });
              continue;
            }
            if (now() < roundTime) {
              results.push({ requestId, status: 'waiting' });
              continue;
            }
            if (inflightFor(requestId) != null) {
              results.push({ requestId, status: 'waiting' });
              continue;
            }
            fulfillable.push({ requestId, requester: request.requester, targetRound: request.targetRound, deadline: BigInt(request.deadline), drandConfigId: request.drandConfigId, roundTime, callbackGasCap: request.callbackGasCap, provingKey });
          } catch (error) {
            if (error instanceof NonceSyncError) throw error;
            rpcFailed = true;
            await watchdog.alert('warn', 'rpc_unhealthy');
            results.push({ requestId, status: 'retry' });
          }
        }
        if (oldest) {
          const age = latest - oldest.requestBlock;
          const window = oldest.deadline - oldest.requestBlock;
          for (const threshold of [25, 50] as const) {
            const id = `pending_age:${threshold}`;
            if (age * 100n >= window * BigInt(threshold)) await watchdog.alert(threshold === 50 ? 'page' : 'warn', 'pending_age', { ...oldest, age, threshold }, id);
            else watchdog.clear(id);
          }
        } else {
          watchdog.clear('pending_age:25');
          watchdog.clear('pending_age:50');
        }
        fulfillable.sort((a, b) => a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : 0);
        let effective = 0n;
        const cost = RESERVE_FULFILLS * RESERVE_FULFILL_GAS * quoted.price;
        if (fulfillable.length > 0) {
          let reserved = 0n;
          for (const entry of inflight.values()) reserved += entry.gas * entry.gasPrice;
          effective = balance - reserved;
        }
        for (const item of fulfillable) {
          if (unknownPending || inflight.size >= MAX_IN_FLIGHT || effective < cost) {
            results.push({ requestId: item.requestId, status: 'waiting' });
            continue;
          }
          try {
            let signature: Hex;
            try {
              signature = signatures.get(item.targetRound) ?? await fetchSignature(item.targetRound);
            } catch (error) {
              if (!(error instanceof BeaconUnavailable)) throw error;
              if (now() < item.roundTime + 30n) {
                results.push({ requestId: item.requestId, status: 'retry' });
                continue;
              }
              if (!stalled.has(item.requestId)) {
                stalled.add(item.requestId);
                await probeHealth(error.relays);

              }
              await watchdog.alert('warn', 'drand_stall', { requestId: item.requestId, drandConfigId: item.drandConfigId, targetRound: item.targetRound }, `drand_stall:${item.requestId}`);
              results.push({ requestId: item.requestId, status: 'stalled' });
              continue;
            }
            stalled.delete(item.requestId);
            watchdog.clear(`drand_stall:${item.requestId}`);
            const composed = composeFulfillment({ chainId: BigInt(config.chain.id), coordinator: config.coordinator, requester: item.requester, requestId: item.requestId, targetRound: item.targetRound, signature }, item.provingKey);
            // Preserve the full frozen cap even when simulation sees a cheap path.
            const gas = VERIFICATION_AND_RESERVE_GAS + ADDITIONAL_HASH_TO_CURVE_GAS * BigInt(composed.hashToCurveTries - 1) + BigInt(item.callbackGasCap);
            if (effective < RESERVE_FULFILLS * gas * quoted.price) {
              await watchdog.alert('page', 'low_balance', { balance, available: effective, required: RESERVE_FULFILLS * gas * quoted.price });
              results.push({ requestId: item.requestId, status: 'waiting' });
              continue;
            }
            const data = encodeFunctionData({ abi: coordinatorAbi, functionName: 'fulfill', args: [item.requestId, composed.proof, composed.drandSignature] });
            await publicClient.simulateContract({
              address: config.coordinator, abi: coordinatorAbi, functionName: 'fulfill', args: [item.requestId, composed.proof, composed.drandSignature],
              account, type: 'legacy', gas, gasPrice: quoted.price,
            });
            const nonce = await ensureNonce();
            const transactionHash = await publish({
              nonce, requestId: item.requestId, hash: '0x', serialized: null, gasPrice: quoted.price, gas, submittedBlock: latest,
              to: config.coordinator, data, value: 0n, canResign: true,
            });
            if (transactionHash == null) {
              results.push({ requestId: item.requestId, status: 'retry' });
              continue;
            }
            effective -= gas * quoted.price;
            results.push({ requestId: item.requestId, status: 'submitted', transactionHash });
          } catch (error) {
            if (error instanceof NonceSyncError) throw error;
            results.push({ requestId: item.requestId, status: 'retry' });
          }
        }
        if (!rpcFailed) watchdog.clear('rpc_unhealthy');
        return results;
      } catch (error) {
        await watchdog.alert('warn', 'rpc_unhealthy');
        throw error;
      }
    },
  };
}
