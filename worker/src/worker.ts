import { createPublicClient, decodeFunctionData, encodeFunctionData, http, parseAbiItem, type AbiEvent, type Address, type Chain, type Hex } from 'viem';
import { sendRawTransaction } from 'viem/actions';
import { privateKeyToAccount } from 'viem/accounts';
import { composeFulfillment, coordinatorAbi } from './coordinator.ts';
import type { ProvingKey } from './proving-key.ts';

/** Local copy of a drand beacon. Chain config is used only after it matches this pin. */
export interface DrandPin {
  publicKey: readonly [bigint, bigint, bigint, bigint];
  genesis: bigint;
  period: bigint;
}

export interface WorkerConfig {
  rpcUrl: string;
  coordinator: Address;
  chain: Chain;
  fulfillerPrivateKey: Hex;
  provingKey: ProvingKey;
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
const KEY_STATE = { NONE: 0 } as const;
// One-try verification headroom plus the callback's post-call reserve.
const VERIFICATION_AND_RESERVE_GAS = 652_000n;
const ADDITIONAL_HASH_TO_CURVE_GAS = 20_000n; // Spec measurement is about 15k.
// Reconciliation runs before proofs are available. Its balance floor covers
// twenty maximum-cap callbacks; a proof above this allowance raises the floor.
const RESERVE_FULFILL_GAS = VERIFICATION_AND_RESERVE_GAS + 2_500_000n;
const MAX_IN_FLIGHT = 8;
const REPLACEMENT_DELAY = 3n;
const SELF_GAS = 21_000n;
const RESERVE_FULFILLS = 20n;

const requestedEvent = parseAbiItem('event RandomnessRequested(bytes32 indexed requestId, address indexed requester, bytes32 tag, uint32 keyId, uint64 targetRound, uint48 requestBlock, uint48 deadline, uint96 fee, uint32 callbackGasCap)');
const fulfilledEvent = parseAbiItem('event Fulfilled(bytes32 indexed requestId, bytes32 beta, address indexed fulfiller)');
const refundedEvent = parseAbiItem('event Refunded(bytes32 indexed requestId, uint8 reason)');

type OutcomeLog = { blockNumber: bigint | null; args: { requestId: Hex } };
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
  const relays = (config.relayUrls && config.relayUrls.length > 0 ? config.relayUrls : config.relayUrl ? [config.relayUrl] : []).map(url => url.replace(/\/$/, ''));
  const reportedPin = new Set<number>();
  const stalled = new Set<Hex>();

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
    if (balance - reserved < reserveCost || balance - reserved < candidateReserve) return null;
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
        parsed.push({ blockNumber: log.blockNumber, args: { requestId: requestId as Hex } });
      }
      return parsed;
    } catch (error) {
      if (span <= 1n || !isLogCapError(error)) throw error;
      const mid = fromBlock + (toBlock - fromBlock) / 2n;
      return [...await logsFor(event, fromBlock, mid), ...await logsFor(event, mid + 1n, toBlock)];
    }
  }

  return {
    async pollOnce(): Promise<PollResult[]> {
      const latest = await publicClient.getBlockNumber({ cacheTime: 0 });
      const quoted = startPrice(await publicClient.getGasPrice(), await blockMinimum());
      balance = await publicClient.getBalance({ address: account.address });
      reserveCost = RESERVE_FULFILLS * RESERVE_FULFILL_GAS * quoted.price;
      await reconcile(latest, quoted.price, quoted.cap);
      const fromBlock = latest > BACKFILL_BLOCKS ? latest - BACKFILL_BLOCKS : 0n;
      const [requestedLogs, fulfilledLogs, refundedLogs] = await Promise.all([
        logsFor(requestedEvent, fromBlock, latest),
        logsFor(fulfilledEvent, fromBlock, latest),
        logsFor(refundedEvent, fromBlock, latest),
      ]);
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
          if (latest > BigInt(request.deadline)) {
            results.push({ requestId, status: 'skipped' });
            continue;
          }
          const [keyHash, , keyState] = await publicClient.readContract({ address: config.coordinator, abi: coordinatorAbi, functionName: 'getProvingKey', args: [request.keyId], blockTag: 'latest' });
          if (keyState === KEY_STATE.NONE || keyHash.toLowerCase() !== config.provingKey.keyHash.toLowerCase()) {
            results.push({ requestId, status: 'skipped' });
            continue;
          }
          const beacon = await publicClient.readContract({ address: config.coordinator, abi: coordinatorAbi, functionName: 'getDrandConfig', args: [request.drandConfigId], blockTag: 'latest' });
          if (!pinMatches(beacon)) {
            if (!reportedPin.has(request.drandConfigId)) {
              reportedPin.add(request.drandConfigId);
              report(`worker: drand config ${request.drandConfigId} pin mismatched`);
            }
            results.push({ requestId, status: 'skipped' });
            continue;
          }
          const confirmations = BigInt(request.confirmations);
          const grace = BigInt(config.graceBlocks ?? 0);
          if (latest < BigInt(request.requestBlock) + confirmations + grace) {
            results.push({ requestId, status: 'waiting' });
            continue;
          }
          const roundTime = config.drandPin.genesis + (request.targetRound - 1n) * config.drandPin.period;
          if (now() < roundTime) {
            results.push({ requestId, status: 'waiting' });
            continue;
          }
          if (inflightFor(requestId) != null) {
            results.push({ requestId, status: 'waiting' });
            continue;
          }
          fulfillable.push({ requestId, requester: request.requester, targetRound: request.targetRound, deadline: BigInt(request.deadline), drandConfigId: request.drandConfigId, roundTime, callbackGasCap: request.callbackGasCap });
        } catch (error) {
          if (error instanceof NonceSyncError) throw error;
          results.push({ requestId, status: 'retry' });
        }
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
            signature = await fetchSignature(item.targetRound);
          } catch (error) {
            if (!(error instanceof BeaconUnavailable)) throw error;
            if (now() < item.roundTime + 30n) {
              results.push({ requestId: item.requestId, status: 'retry' });
              continue;
            }
            if (!stalled.has(item.requestId)) {
              stalled.add(item.requestId);
              await probeHealth(error.relays);
              report(`worker: drand config ${item.drandConfigId} round ${item.targetRound} stalled`);
            }
            results.push({ requestId: item.requestId, status: 'stalled' });
            continue;
          }
          stalled.delete(item.requestId);
          const composed = composeFulfillment({ chainId: BigInt(config.chain.id), coordinator: config.coordinator, requester: item.requester, requestId: item.requestId, targetRound: item.targetRound, signature }, config.provingKey);
          // Preserve the full frozen cap even when simulation sees a cheap path.
          const gas = VERIFICATION_AND_RESERVE_GAS + ADDITIONAL_HASH_TO_CURVE_GAS * BigInt(composed.hashToCurveTries - 1) + BigInt(item.callbackGasCap);
          if (effective < RESERVE_FULFILLS * gas * quoted.price) {
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
      return results;
    },
  };
}
