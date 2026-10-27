import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { it } from 'node:test';
import { decodeFunctionData, defineChain, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256, parseTransaction, recoverTransactionAddress, toHex, type Hex, type TransactionSerializedLegacy } from 'viem';
import { privateKeyToAccount, type LocalAccount } from 'viem/accounts';
import { coordinatorAbi } from '../src/coordinator.ts';
import { ProvingKey } from '../src/proving-key.ts';
import { createWorker } from '../src/worker.ts';
const golden = JSON.parse(readFileSync(new URL('../../tools/vrf-vectors-go/coordinator-vectors.json', import.meta.url), 'utf8'));
const key = ProvingKey.fromHex(golden.vectors[0].vrf.secretKey);
const address = `0x${'11'.repeat(20)}` as const;
const requestId = `0x${'24'.repeat(32)}` as const;
const zero = `0x${'00'.repeat(32)}` as const;
const pin = { publicKey: [1n, 2n, 3n, 4n] as const, genesis: 1n, period: 1n };
const signature = `0x${golden.vectors[0].drandSignature.map((word: string) => word.slice(2)).join('')}`;
// JSON-RPC boundary double: tests poll decisions and signed bytes, not chain verification.
async function scenario(body: (s: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const s = await setup(); try { await body(s); } finally { await new Promise<void>(resolve => s.server.close(() => resolve())); }
}
async function setup() {
  const state = { latest: 100n, gasPrice: 100n, balance: 10n ** 18n, pendingNonce: 0, minedNonce: 0, outcome: null as bigint | null, status: 1, requestBlock: 90n, callbackGasCap: 0, simulationGas: [] as bigint[], simulationFails: false, hashMissing: false, pool: null as Record<string, unknown> | null, sent: [] as Hex[], requestReads: 0, nonceReads: 0, receiptReads: 0 };
  function log(eventName: 'RandomnessRequested' | 'Fulfilled', block: bigint) {
    const topics = encodeEventTopics({ abi: coordinatorAbi, eventName, args: { requestId, requester: address, fulfiller: address } as never });
    const data = eventName === 'Fulfilled' ? encodeAbiParameters([{ type: 'bytes32' }], [zero]) : encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint32' }, { type: 'uint64' }, { type: 'uint48' }, { type: 'uint48' }, { type: 'uint96' }, { type: 'uint32' }], [zero, 1, 1n, 90, 5000, 0n, 0]);
    return { address, topics, data, blockNumber: toHex(block), transactionHash: zero, transactionIndex: '0x0', blockHash: zero, logIndex: '0x0', removed: false };
  }
  const server = createServer(async (req, res) => {
    let input = ''; for await (const chunk of req) input += chunk;
    const call = JSON.parse(input);
    try {
      let result: unknown;
      switch (call.method) {
        case 'eth_blockNumber': result = toHex(state.latest); break;
        case 'eth_gasPrice': result = toHex(state.gasPrice); break;
        case 'eth_getBlockByNumber': result = { minimumGasPrice: '0x64' }; break;
        case 'eth_getBalance': result = toHex(state.balance); break;
        case 'txpool_content': if (state.pool == null) throw Error('unsupported'); result = { pending: state.pool }; break;
        case 'eth_getTransactionCount': state.nonceReads++; result = toHex(call.params[1] === 'pending' ? state.pendingNonce : state.minedNonce); break;
        case 'eth_getTransactionReceipt': state.receiptReads++; result = null; break;
        case 'eth_getTransactionByHash': result = state.hashMissing ? null : { hash: call.params[0], nonce: '0x0', blockHash: null, blockNumber: null, transactionIndex: null, from: address, to: address, gas: '0x7bc78', gasPrice: '0x6e', input: '0x', value: '0x0', type: '0x0', v: '0x25', r: zero, s: zero }; break;
        case 'eth_getLogs': {
          const filter = call.params[0];
          result = [log('RandomnessRequested', state.requestBlock), ...(state.outcome == null ? [] : [log('Fulfilled', state.outcome)])].filter(event => event.topics[0] === filter.topics[0] && BigInt(event.blockNumber) >= BigInt(filter.fromBlock) && BigInt(event.blockNumber) <= BigInt(filter.toBlock)); break;
        }
        case 'eth_call': {
          const decoded = decodeFunctionData({ abi: coordinatorAbi, data: call.params[0].data });
          if (decoded.functionName === 'getRequest') { state.requestReads++; result = encodeFunctionResult({ abi: coordinatorAbi, functionName: 'getRequest', result: { requester: address, status: state.status, callbackGasCap: state.callbackGasCap, requestBlock: Number(state.requestBlock), drandConfigId: 0, fee: 0n, targetRound: 1n, deadline: 5000, confirmations: 2, keyId: 1, beta: zero } }); }
          else if (decoded.functionName === 'getProvingKey') result = encodeFunctionResult({ abi: coordinatorAbi, functionName: 'getProvingKey', result: decoded.args[0] === 1 ? [key.keyHash, address, 1, 0] : [zero, zero.slice(0, 42) as typeof address, 0, 0] });
          else if (decoded.functionName === 'getDrandConfig') result = encodeFunctionResult({ abi: coordinatorAbi, functionName: 'getDrandConfig', result: pin });
          else { state.simulationGas.push(BigInt(call.params[0].gas)); if (state.simulationFails) throw Error('simulation reverted'); result = '0x'; }
          break;
        }
        case 'eth_sendRawTransaction': state.sent.push(call.params[0]); state.pendingNonce = Math.max(state.pendingNonce, Number(parseTransaction(call.params[0]).nonce) + 1); result = keccak256(call.params[0]); break;
        default: throw Error(`unexpected ${call.method}`);
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
    } catch (error) { res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: -32000, message: String(error) } })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const rpcUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const chain = defineChain({ id: 33, name: 'test', nativeCurrency: { name: 'RBTC', symbol: 'RBTC', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const makeWorker = (fulfiller: LocalAccount = privateKeyToAccount(`0x${'34'.repeat(32)}`)) => createWorker({ rpcUrl, coordinator: address, chain, fulfiller, loadProvingKey: async () => key, drandPin: pin, relayUrl: 'http://relay', nowSeconds: () => 10n, fetch: async () => Response.json({ round: 1, signature }) });
  return { state, server, makeWorker };
}
it('signs fulfillments with an injected Fulfiller account such as the KMS one', () => scenario(async ({ state, makeWorker }) => {
  const signer = privateKeyToAccount(`0x${'56'.repeat(32)}`);
  const signed: unknown[] = [];
  const account = { ...signer, signTransaction: (tx: Parameters<typeof signer.signTransaction>[0]) => { signed.push(tx); return signer.signTransaction(tx); } };
  assert.equal((await makeWorker(account).pollOnce())[0]?.status, 'submitted');
  assert.equal(signed.length, 1);
  assert.equal(await recoverTransactionAddress({ serializedTransaction: state.sent[0] as TransactionSerializedLegacy }), signer.address);
}));
it('keeps an outcome pending for twelve blocks regardless of request confirmation wait', () => scenario(async ({ state, makeWorker }) => {
  state.status = 2; state.outcome = 100n;
  const worker = makeWorker(); assert.equal((await worker.pollOnce())[0]?.status, 'waiting');
  state.latest = 111n; assert.equal((await worker.pollOnce())[0]?.status, 'waiting');
  state.latest = 112n; assert.deepEqual(await worker.pollOnce(), []);
}));
it('resubmits after a finished outcome disappears above a rewound chain head', () => scenario(async ({ state, makeWorker }) => {
  state.status = 2; state.outcome = 100n;
  const worker = makeWorker(); await worker.pollOnce();
  state.latest = 112n; assert.deepEqual(await worker.pollOnce(), []);
  state.latest = 99n; state.outcome = null; state.status = 1;
  assert.equal((await worker.pollOnce())[0]?.status, 'submitted');
}));
it('counts outcome depth from the new canonical block after a reorg moves an outcome later', () => scenario(async ({ state, makeWorker }) => {
  state.status = 2; state.outcome = 100n;
  const worker = makeWorker(); await worker.pollOnce();
  state.latest = 112n; state.outcome = 110n;
  assert.equal((await worker.pollOnce())[0]?.status, 'waiting');
  state.latest = 121n; assert.equal((await worker.pollOnce())[0]?.status, 'waiting');
  state.latest = 122n; assert.deepEqual(await worker.pollOnce(), []);
}));
it('tracks a finished request again if its canonical outcome moves within the twelve-block wait', () => scenario(async ({ state, makeWorker }) => {
  state.status = 2; state.outcome = 100n;
  const worker = makeWorker(); await worker.pollOnce();
  state.latest = 112n; assert.deepEqual(await worker.pollOnce(), []);
  state.latest = 113n; state.outcome = 111n;
  assert.equal((await worker.pollOnce())[0]?.status, 'waiting');
  state.latest = 122n; assert.equal((await worker.pollOnce())[0]?.status, 'waiting');
  state.latest = 123n; assert.deepEqual(await worker.pollOnce(), []);
}));
it('rebroadcasts missing bytes without resetting the three-block replacement clock', () => scenario(async ({ state, makeWorker }) => {
  const worker = makeWorker(); assert.equal((await worker.pollOnce())[0]?.status, 'submitted');
  state.hashMissing = true;
  state.latest = 101n; await worker.pollOnce();
  state.latest = 102n; await worker.pollOnce();
  assert.deepEqual(state.sent, [state.sent[0], state.sent[0], state.sent[0]]);
  state.latest = 103n; await worker.pollOnce();
  assert.equal(parseTransaction(state.sent.at(-1)!).gasPrice, 165n);
  assert.equal(parseTransaction(state.sent.at(-1)!).nonce, 0);
}));
it('stops replacements, rebroadcasts and gap fills below reserve while still reconciling nonces and receipts', () => scenario(async ({ state, makeWorker }) => {
  const worker = makeWorker(); await worker.pollOnce();
  state.balance = 6_934_399_999n; state.latest = 103n;
  await worker.pollOnce(); assert.equal(state.sent.length, 1, 'low funds cannot bump');
  state.hashMissing = true; await worker.pollOnce(); assert.equal(state.sent.length, 1, 'low funds cannot rebroadcast');
  state.minedNonce = 1; state.pendingNonce = 2; await worker.pollOnce();
  assert.equal(state.sent.length, 1, 'low funds cannot fill a nonce gap or fulfill');
  assert.ok(state.nonceReads > 3); assert.ok(state.receiptReads > 0);
  state.pendingNonce = 1; state.balance = 10n ** 18n;
  assert.equal((await worker.pollOnce())[0]?.status, 'submitted', 'mined inflight entry was removed while funds were low');
  assert.equal(parseTransaction(state.sent.at(-1)!).nonce, 1);
}));
it('restarts on the same Fulfiller without duplicating an unknown pending transaction when txpool is unavailable', () => scenario(async ({ state, makeWorker }) => {
  await makeWorker().pollOnce(); assert.equal(state.pendingNonce, 1);
  const restarted = makeWorker();
  assert.equal((await restarted.pollOnce())[0]?.status, 'waiting');
  assert.equal(state.sent.length, 1); assert.equal(state.pendingNonce, 1);
  state.pendingNonce = 0; state.sent = [];
  assert.equal((await restarted.pollOnce())[0]?.status, 'submitted');
  assert.equal(state.pendingNonce, 1);
}));
it('does not revive a canonical outcome after it ages out of the log window', () => scenario(async ({ state, makeWorker }) => {
  state.status = 2; state.outcome = 100n;
  const worker = makeWorker(); await worker.pollOnce();
  state.latest = 112n; await worker.pollOnce();
  const reads = state.requestReads;
  state.latest = 2700n; assert.deepEqual(await worker.pollOnce(), []);
  assert.equal(state.requestReads, reads);
}));
it('retains original bytes when replacement simulation fails and bumps only three blocks after a successful replacement', () => scenario(async ({ state, makeWorker }) => {
  const worker = makeWorker(); await worker.pollOnce();
  state.latest = 103n; state.simulationFails = true;
  await worker.pollOnce(); assert.equal(state.sent.length, 1, 'a hash in the pool stays untouched');
  state.hashMissing = true; await worker.pollOnce();
  assert.equal(state.sent.length, 2); assert.equal(state.sent[1], state.sent[0]);
  state.simulationFails = false; await worker.pollOnce();
  assert.equal(parseTransaction(state.sent.at(-1)!).gasPrice, 165n);
  state.hashMissing = false; state.latest = 105n; await worker.pollOnce();
  assert.equal(state.sent.length, 3);
  state.latest = 106n; await worker.pollOnce();
  assert.equal(parseTransaction(state.sent.at(-1)!).gasPrice, 247n);
}));
it('can fulfill at the exact twenty-fulfillment reserve and stops one wei below it', () => scenario(async ({ state, makeWorker }) => {
  state.balance = 6_934_399_999n;
  const worker = makeWorker(); assert.equal((await worker.pollOnce())[0]?.status, 'waiting'); assert.equal(state.sent.length, 0);
  state.balance = 6_934_400_000n;
  assert.equal((await worker.pollOnce())[0]?.status, 'submitted'); assert.equal(state.sent.length, 1);
}));
it('rebroadcasts identical bytes when the gas cap prevents a valid replacement bump', () => scenario(async ({ state, makeWorker }) => {
  state.gasPrice = 7900n;
  const worker = makeWorker(); await worker.pollOnce();
  assert.equal(parseTransaction(state.sent[0]!).gasPrice, 7999n);
  state.latest = 103n; await worker.pollOnce();
  assert.equal(state.sent.length, 2); assert.equal(state.sent[1], state.sent[0]);
}));
it('blocks self-transfer nonce gap fills below reserve and resumes at equality', () => scenario(async ({ state, makeWorker }) => {
  // txpool adopts only this process's Fulfiller; derive its public address.
  const fulfiller = privateKeyToAccount(`0x${'34'.repeat(32)}`).address;
  state.pool = { [fulfiller]: { '2': { nonce: '0x2', hash: requestId, to: fulfiller, input: '0x', gas: '0x5208', gasPrice: '0x6e', value: '0x0' } } };
  state.pendingNonce = 0; state.balance = 6_934_399_999n;
  const worker = makeWorker(); await worker.pollOnce(); assert.equal(state.sent.length, 0);
  // Reserve also accounts for the adopted transaction's 2,310,000 wei cost.
  state.balance = 6_936_710_000n; await worker.pollOnce();
  assert.equal(state.sent.length, 1);
  const tx = parseTransaction(state.sent[0]!);
  assert.equal(tx.nonce, 0); assert.equal(tx.to?.toLowerCase(), fulfiller.toLowerCase()); assert.equal(tx.data ?? '0x', '0x');
}));

it('preserves proof-aware full callback gas through simulation, signing and replacement', () => scenario(async ({ state, makeWorker }) => {
  state.callbackGasCap = 2_500_000;
  const worker = makeWorker();
  assert.equal((await worker.pollOnce())[0]?.status, 'submitted');
  // This fixed domain/round/signature takes two hash-to-curve tries.
  assert.equal(parseTransaction(state.sent[0]!).gas, 3_172_000n);
  assert.equal(state.simulationGas[0], 3_172_000n);
  state.latest = 103n;
  await worker.pollOnce();
  assert.equal(parseTransaction(state.sent.at(-1)!).gas, 3_172_000n);
  assert.equal(state.simulationGas.at(-1), 3_172_000n);
}));

it('raises the twenty-fulfillment reserve for proof work above the maximum-cap floor', () => scenario(async ({ state, makeWorker }) => {
  state.callbackGasCap = 2_500_000;
  state.balance = 6_978_399_999n; // 20 × 3,172,000 gas × 110 wei, less one wei.
  const worker = makeWorker();
  assert.equal((await worker.pollOnce())[0]?.status, 'waiting');
  assert.equal(state.sent.length, 0);
  state.balance = 6_978_400_000n;
  assert.equal((await worker.pollOnce())[0]?.status, 'submitted');
  assert.equal(state.sent.length, 1);
}));
