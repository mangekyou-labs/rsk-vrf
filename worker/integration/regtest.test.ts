import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { describe, it } from 'node:test';
import { createPublicClient, createWalletClient, decodeFunctionData, defineChain, encodeFunctionData, http, parseAbiItem, parseEventLogs, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { coordinatorAbi } from '../src/coordinator.ts';
import { ProvingKey } from '../src/proving-key.ts';
import { createWorker, type DrandPin, type PollResult } from '../src/worker.ts';

const rpcUrl = process.env.RSK_RPC_URL ?? 'http://127.0.0.1:4449';
const chain = defineChain({ id: 33, name: 'Rootstock regtest', nativeCurrency: { name: 'Test RBTC', symbol: 'tRBTC', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const client = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 50, cacheTime: 0 });
// Public rskj regtest genesis key, never a production credential.
const owner = privateKeyToAccount('0xc85ef7d79691fe79573b1a7064c19c1a9819ebdbd1faaab1a8ec92344438aaf4');
const requester = privateKeyToAccount(`0x${'12'.repeat(32)}`);
const fulfillerKey = `0x${'34'.repeat(32)}` as Hex;
const fulfiller = privateKeyToAccount(fulfillerKey);
const wallet = createWalletClient({ account: owner, chain, transport: http(rpcUrl) });
const fixture = JSON.parse(readFileSync(new URL('../../tools/vrf-vectors-go/coordinator-vectors.json', import.meta.url), 'utf8'));
const artifact = (name: string) => JSON.parse(readFileSync(new URL(`../../contracts/out/${name}.sol/${name}.json`, import.meta.url), 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
const fulfilledEvent = parseAbiItem('event Fulfilled(bytes32 indexed requestId, bytes32 beta, address indexed fulfiller)');

async function mine() { await client.request({ method: 'evm_mine' as never, params: [] as never }); }
async function mineBlocks(count: number) { for (let n = 0; n < count; n++) await mine(); }
async function mineTo(block: bigint) {
  const current = await head();
  assert.ok(current <= block, 'head is already past the target block');
  await mineBlocks(Number(block - current));
  assert.equal(await head(), block);
}
async function receipt(hash: Hex) { await mine(); const found = await client.waitForTransactionReceipt({ hash }); assert.equal(found.status, 'success'); return found; }
async function head() { return client.getBlockNumber({ cacheTime: 0 }); }
async function nonceOf(address: Address) { return client.getTransactionCount({ address, blockTag: 'pending' }); }

async function withRelay(port: number, body: (relayUrl: string) => Promise<void>) {
  const relay = spawn(process.env.TEST_RELAY_BIN ?? '/tmp/rsk-vrf-test-relay', ['-test-relay', `127.0.0.1:${port}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let relayError = '';
  relay.stderr.on('data', chunk => { relayError += String(chunk); });
  try {
    const relayUrl = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let n = 0; n < 100; n++) {
      try { ready = (await fetch(`${relayUrl}/public/1`)).ok; if (ready) break; } catch { /* startup only */ }
      if (relay.exitCode !== null) throw new Error(`Test relay exited: ${relayError}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, 'offline signing relay starts');
    await body(relayUrl);
  } finally {
    relay.kill('SIGTERM');
    if (relay.exitCode === null) await once(relay, 'exit');
  }
}

async function fund(accounts: { address: Address }[]) {
  for (const account of accounts) await receipt(await wallet.sendTransaction({ to: account.address, value: 10n ** 19n, gas: 21_000n, gasPrice: 1n }));
}

async function deployCoordinator() {
  assert.equal(await client.getChainId(), 33, 'must use real rskj regtest');
  const implementation = artifact('VRFCoordinator');
  const deployed = await receipt(await wallet.deployContract({ abi: implementation.abi, bytecode: implementation.bytecode.object, gas: 6_500_000n, gasPrice: 1n }));
  assert.ok(deployed.contractAddress);
  const beacon = { publicKey: (fixture.drand.publicKey as string[]).map(BigInt), genesis: BigInt(fixture.drand.genesis), period: BigInt(fixture.drand.period) };
  const init = encodeFunctionData({ abi: implementation.abi, functionName: 'initialize', args: [owner.address, beacon] });
  const proxy = artifact('ERC1967Proxy');
  const proxyReceipt = await receipt(await wallet.deployContract({ abi: proxy.abi, bytecode: proxy.bytecode.object, args: [deployed.contractAddress, init], gas: 2_000_000n, gasPrice: 1n }));
  assert.ok(proxyReceipt.contractAddress);
  const coordinator = proxyReceipt.contractAddress;
  const key = ProvingKey.fromHex(fixture.vectors[0].vrf.secretKey);
  await receipt(await wallet.writeContract({ address: coordinator, abi: coordinatorAbi, functionName: 'registerProvingKey', args: [key.publicKey, owner.address], gas: 500_000n, gasPrice: 1n }));
  return { coordinator, key, beacon };
}

async function requestRandomness(coordinator: Address, tag: Hex) {
  const requesterWallet = createWalletClient({ account: requester, chain, transport: http(rpcUrl) });
  const fee = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'fee' });
  const requestReceipt = await receipt(await requesterWallet.writeContract({ address: coordinator, abi: coordinatorAbi, functionName: 'request', args: [tag], value: fee, gas: 500_000n, gasPrice: 1n }));
  const event = parseEventLogs({ abi: coordinatorAbi, eventName: 'RandomnessRequested', logs: requestReceipt.logs })[0];
  assert.ok(event);
  const requestId = event.args.requestId;
  const record = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [requestId] });
  return { requestId, requestReceipt, record };
}

function forRequest(results: PollResult[], requestId: Hex) {
  return results.find(item => item.requestId === requestId);
}

function pinOf(beacon: { publicKey: bigint[]; genesis: bigint; period: bigint }): DrandPin {
  assert.equal(beacon.publicKey.length, 4);
  const [a, b, c, d] = beacon.publicKey;
  assert.ok(a !== undefined && b !== undefined && c !== undefined && d !== undefined);
  return { publicKey: [a, b, c, d], genesis: beacon.genesis, period: beacon.period };
}

function countingFetch(bucket: { n: number }): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/public/')) bucket.n += 1;
    return fetch(input, init);
  };
}

function quotedQuantity(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && value !== '' && value !== '0x') {
    try { return BigInt(value); } catch { return 0n; }
  }
  return 0n;
}

/** Same 1.1× quote the worker uses, computed from the chain rather than a worker helper. */
async function quotedStart(): Promise<{ price: bigint; cap: bigint | null; minimum: bigint }> {
  const network = await client.getGasPrice();
  const block: unknown = await client.request({ method: 'eth_getBlockByNumber' as never, params: ['latest', false] as never });
  const minimum = block != null && typeof block === 'object' && 'minimumGasPrice' in block ? quotedQuantity(block.minimumGasPrice) : 0n;
  const cap = minimum > 0n ? 80n * minimum - 1n : null;
  let price = network > minimum ? network : minimum;
  price = (price * 11n) / 10n;
  if (cap != null && price > cap) price = cap;
  if (price === 0n) price = 1n;
  return { price, cap, minimum };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address == null || typeof address === 'string') { reject(new Error('relay port')); return; }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function closeServer(server: Server) {
  if (!server.listening) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
}

describe('worker regtest', { concurrency: 1 }, () => {
  it('real rskj: waits frozen round, rejects simulation without a send, retries and fulfills from separate EOA, derives independent Go expected word, and keeps the id until the outcome is 12 blocks deep', { timeout: 180_000 }, async () => {
    await withRelay(18769, async relayUrl => {
      await fund([requester, fulfiller]);
      const { coordinator, key, beacon } = await deployCoordinator();
      const { requestId, requestReceipt, record } = await requestRandomness(coordinator, `0x${'ab'.repeat(32)}`);
      const confirmations = Number(record.confirmations);
      assert.ok(confirmations > 0);
      const roundTime = beacon.genesis + (record.targetRound - 1n) * beacon.period;
      let now = roundTime - 1n;
      let relayCalls = 0;
      let invalidSignature = true;
      await mineBlocks(confirmations);
      const worker = createWorker({
        rpcUrl, coordinator, chain, fulfillerPrivateKey: fulfillerKey, provingKey: key, relayUrl, drandPin: pinOf(beacon), nowSeconds: () => now,
        fetch: async (input, init) => {
          relayCalls++;
          const response = await fetch(input, init);
          if (!invalidSignature) return response;
          const body = await response.json() as { round: number; signature: string };
          const other = await (await fetch(`${relayUrl}/public/${record.targetRound + 1n}`)).json() as { signature: string };
          return Response.json({ ...body, signature: other.signature });
        },
      });
      assert.deepEqual((await worker.pollOnce()).map(item => item.status), ['waiting']);
      assert.equal(relayCalls, 0, 'future frozen round does not fetch or consume event');
      now = roundTime;
      const before = await nonceOf(fulfiller.address);
      assert.deepEqual((await worker.pollOnce()).map(item => item.status), ['retry']);
      assert.equal(await nonceOf(fulfiller.address), before, 'failed real eth_call must never broadcast');
      invalidSignature = false;
      const submitted = await worker.pollOnce();
      assert.equal(submitted[0]?.status, 'submitted', 'same queued request retries after simulation failure');
      const inflightNonce = await nonceOf(fulfiller.address);
      assert.equal(inflightNonce, before + 1);
      const again = await worker.pollOnce();
      assert.equal(forRequest(again, requestId)?.status, 'waiting');
      assert.equal(await nonceOf(fulfiller.address), inflightNonce, 'a second poll does not send another fulfillment');
      const restartedSameFulfiller = createWorker({ rpcUrl, coordinator, chain, fulfillerPrivateKey: fulfillerKey, provingKey: key, relayUrl, drandPin: pinOf(beacon), nowSeconds: () => now });
      assert.equal(forRequest(await restartedSameFulfiller.pollOnce(), requestId)?.status, 'waiting');
      assert.equal(await nonceOf(fulfiller.address), before + 1, 'restart does not duplicate an unmined fulfill');
      const fulfilledReceipt = await receipt(submitted[0]!.transactionHash!);
      const fulfilled = parseEventLogs({ abi: coordinatorAbi, eventName: 'Fulfilled', logs: fulfilledReceipt.logs })[0];
      assert.ok(fulfilled);
      assert.equal(fulfilled.args.fulfiller.toLowerCase(), fulfiller.address.toLowerCase());
      assert.notEqual(requester.address, fulfiller.address);
      const derivationContext = fixture.vectors[0].derivations[0].context as Hex;
      const expectedUrl = new URL(`${relayUrl}/expected`);
      for (const [name, value] of Object.entries({ chainId: 33, round: record.targetRound, coordinator, requester: requester.address, requestId, context: derivationContext })) expectedUrl.searchParams.set(name, String(value));
      const expected = await (await fetch(expectedUrl)).json() as { beta: Hex; random: Hex };
      const finalRecord = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [requestId] });
      assert.equal(finalRecord.status, 2);
      assert.equal(finalRecord.beta, expected.beta, 'Beta matches independently domain-bound Go prover output');
      assert.equal(await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'deriveRandom', args: [requestId, derivationContext] }), BigInt(expected.random));
      const held = await worker.pollOnce();
      assert.equal(forRequest(held, requestId)?.status, 'waiting', 'an outcome at depth 0 stays pending');
      await mineBlocks(12);
      const released = await worker.pollOnce();
      assert.equal(released.some(item => item.requestId === requestId), false);
    });
  });

  it('does not send or drop a request after its deadline', { timeout: 600_000 }, async () => {
    await withRelay(18770, async relayUrl => {
      await fund([requester, fulfiller]);
      const { coordinator, key, beacon } = await deployCoordinator();
      const { requestId, record } = await requestRandomness(coordinator, `0x${'cd'.repeat(32)}`);
      const beforeHead = await head();
      const blocksUntilPastDeadline = Number(BigInt(record.deadline) - beforeHead) + 1;
      assert.ok(blocksUntilPastDeadline > 1_000, 'deadline comes from the chain record');
      await mineBlocks(blocksUntilPastDeadline);
      assert.ok(await head() > BigInt(record.deadline));
      let relayCalls = 0;
      const before = await nonceOf(fulfiller.address);
      const worker = createWorker({
        rpcUrl, coordinator, chain, fulfillerPrivateKey: fulfillerKey, provingKey: key, relayUrl, drandPin: pinOf(beacon),
        nowSeconds: () => beacon.genesis + (record.targetRound - 1n) * beacon.period,
        fetch: async (input, init) => { relayCalls++; return fetch(input, init); },
      });
      const first = await worker.pollOnce();
      assert.equal(forRequest(first, requestId)?.status, 'skipped');
      assert.equal(forRequest(first, requestId)?.transactionHash, undefined);
      const second = await worker.pollOnce();
      assert.equal(forRequest(second, requestId)?.status, 'skipped');
      assert.equal(relayCalls, 0, 'a past-deadline request does not fetch a round');
      assert.equal(await nonceOf(fulfiller.address), before);
      const still = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [requestId] });
      assert.equal(still.status, 1);
    });
  });

  it('a new fulfiller keeps a mined outcome until it is 12 blocks deep and does not send another', { timeout: 180_000 }, async () => {
    await withRelay(18771, async relayUrl => {
      const backupKey = `0x${'56'.repeat(32)}` as Hex;
      const backup = privateKeyToAccount(backupKey);
      await fund([requester, fulfiller, backup]);
      const { coordinator, key, beacon } = await deployCoordinator();
      const { requestId, requestReceipt, record } = await requestRandomness(coordinator, `0x${'ef'.repeat(32)}`);
      const confirmations = Number(record.confirmations);
      const roundTime = beacon.genesis + (record.targetRound - 1n) * beacon.period;
      await mineBlocks(confirmations);
      const worker = createWorker({ rpcUrl, coordinator, chain, fulfillerPrivateKey: fulfillerKey, provingKey: key, relayUrl, drandPin: pinOf(beacon), nowSeconds: () => roundTime });
      const submitted = await worker.pollOnce();
      assert.equal(forRequest(submitted, requestId)?.status, 'submitted');
      await receipt(forRequest(submitted, requestId)!.transactionHash!);
      const before = await nonceOf(backup.address);
      const restarted = createWorker({ rpcUrl, coordinator, chain, fulfillerPrivateKey: backupKey, provingKey: key, relayUrl, drandPin: pinOf(beacon), nowSeconds: () => roundTime });
      const seen = await restarted.pollOnce();
      assert.equal(forRequest(seen, requestId)?.status, 'waiting');
      assert.equal(seen.some(item => item.status === 'submitted'), false);
      assert.equal(await nonceOf(backup.address), before);
      const logs = await client.getLogs({ address: coordinator, event: fulfilledEvent, args: { requestId }, fromBlock: requestReceipt.blockNumber, toBlock: await head(), strict: true });
      assert.equal(logs.length, 1);
      assert.equal(logs[0]?.args.fulfiller.toLowerCase(), fulfiller.address.toLowerCase());
      await mineBlocks(12);
      const released = await restarted.pollOnce();
      assert.equal(released.some(item => item.requestId === requestId), false);
    });
  });

  it('refuses every request when the drand pin mismatches, with one line and no transaction', { timeout: 180_000 }, async () => {
    await fund([requester, fulfiller]);
    const { coordinator, key, beacon } = await deployCoordinator();
    const { requestId, record } = await requestRandomness(coordinator, `0x${'11'.repeat(32)}`);
    const lines: string[] = [];
    let fetched = 0;
    const before = await nonceOf(fulfiller.address);
    const worker = createWorker({
      rpcUrl, coordinator, chain, fulfillerPrivateKey: fulfillerKey, provingKey: key,
      relayUrls: ['http://127.0.0.1:1', 'http://127.0.0.1:1', 'http://127.0.0.1:1'],
      drandPin: { ...pinOf(beacon), period: beacon.period + 1n },
      nowSeconds: () => beacon.genesis + (record.targetRound - 1n) * beacon.period,
      fetch: async () => { fetched++; throw new Error('pin mismatch must not fetch'); },
      report: line => lines.push(line),
    });
    const first = await worker.pollOnce();
    assert.equal(forRequest(first, requestId)?.status, 'skipped');
    assert.equal(forRequest(first, requestId)?.transactionHash, undefined);
    assert.deepEqual(lines, [`worker: drand config ${record.drandConfigId} pin mismatched`]);
    const line = lines[0] ?? '';
    assert.equal(line.includes('0x'), false);
    for (const word of fixture.drand.publicKey as string[]) assert.equal(line.includes(word.replace(/^0x/, '')), false);
    assert.equal(line.includes(String(fixture.drand.secretKey).replace(/^0x/, '')), false);
    assert.equal(line.includes(String(fixture.vectors[0].vrf.secretKey).replace(/^0x/, '')), false);
    const second = await worker.pollOnce();
    assert.equal(forRequest(second, requestId)?.status, 'skipped');
    assert.equal(lines.length, 1, 'a pin mismatch is reported once per config');
    assert.equal(fetched, 0);
    assert.equal(await nonceOf(fulfiller.address), before);
    const still = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [requestId] });
    assert.equal(still.status, 1);
  });

  it('uses the first good relay and fulfills with the Go signature', { timeout: 180_000 }, async () => {
    await withRelay(18772, async relayUrl => {
      const deadHits = [0, 0];
      const dead = [0, 1].map(index => createServer((_req, res) => { deadHits[index]!++; res.writeHead(503); res.end(); }));
      const urls = [await listen(dead[0]!), await listen(dead[1]!), relayUrl];
      try {
        await fund([requester, fulfiller]);
        const { coordinator, key, beacon } = await deployCoordinator();
        const { requestId, record } = await requestRandomness(coordinator, `0x${'22'.repeat(32)}`);
        await mineBlocks(Number(record.confirmations));
        const worker = createWorker({
          rpcUrl, coordinator, chain, fulfillerPrivateKey: fulfillerKey, provingKey: key,
          relayUrls: urls, drandPin: pinOf(beacon),
          nowSeconds: () => beacon.genesis + (record.targetRound - 1n) * beacon.period,
        });
        const submitted = await worker.pollOnce();
        assert.equal(forRequest(submitted, requestId)?.status, 'submitted');
        assert.deepEqual(deadHits, [1, 1]);
        const fulfilledReceipt = await receipt(forRequest(submitted, requestId)!.transactionHash!);
        const derivationContext = fixture.vectors[0].derivations[0].context as Hex;
        const expectedUrl = new URL(`${relayUrl}/expected`);
        for (const [name, value] of Object.entries({ chainId: 33, round: record.targetRound, coordinator, requester: requester.address, requestId, context: derivationContext })) expectedUrl.searchParams.set(name, String(value));
        const expected = await (await fetch(expectedUrl)).json() as { beta: Hex };
        const finalRecord = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [requestId] });
        assert.equal(finalRecord.status, 2);
        assert.equal(finalRecord.beta, expected.beta);
        assert.equal(parseEventLogs({ abi: coordinatorAbi, eventName: 'Fulfilled', logs: fulfilledReceipt.logs }).length, 1);
      } finally {
        await Promise.all(dead.map(closeServer));
      }
    });
  });

  it('stops at the first well-formed relay and does not call the later ones', { timeout: 180_000 }, async () => {
    await withRelay(18773, async relayUrl => {
      let proxyHits = 0;
      const proxy = createServer((req, res) => {
        proxyHits++;
        fetch(`${relayUrl}${req.url ?? ''}`).then(async response => {
          const body = Buffer.from(await response.arrayBuffer());
          res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' });
          res.end(body);
        }).catch(() => { res.writeHead(502); res.end(); });
      });
      const laterHits = [0, 0];
      const later = [0, 1].map(index => createServer((_req, res) => { laterHits[index]!++; res.writeHead(503); res.end(); }));
      const urls = [await listen(proxy), await listen(later[0]!), await listen(later[1]!)];
      try {
        await fund([requester, fulfiller]);
        const { coordinator, key, beacon } = await deployCoordinator();
        const { requestId, record } = await requestRandomness(coordinator, `0x${'33'.repeat(32)}`);
        await mineBlocks(Number(record.confirmations));
        const worker = createWorker({
          rpcUrl, coordinator, chain, fulfillerPrivateKey: fulfillerKey, provingKey: key,
          relayUrls: urls, drandPin: pinOf(beacon),
          nowSeconds: () => beacon.genesis + (record.targetRound - 1n) * beacon.period,
        });
        const submitted = await worker.pollOnce();
        assert.equal(forRequest(submitted, requestId)?.status, 'submitted');
        assert.equal(proxyHits, 1);
        assert.deepEqual(laterHits, [0, 0]);
        await receipt(forRequest(submitted, requestId)!.transactionHash!);
        const finalRecord = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [requestId] });
        assert.equal(finalRecord.status, 2);
      } finally {
        await Promise.all([proxy, ...later].map(closeServer));
      }
    });
  });

  it('reports a stall 30s after the round with no refund, then fulfills when the relay recovers', { timeout: 180_000 }, async () => {
    await withRelay(18774, async relayUrl => {
      let serve = false;
      const publicHits = [0, 0, 0];
      const healthHits = [0, 0, 0];
      const servers = [0, 1, 2].map(index => createServer((req, res) => {
        const path = req.url ?? '';
        if (path.startsWith('/v2/beacons/evmnet/health')) {
          healthHits[index]!++;
          res.writeHead(503);
          res.end();
          return;
        }
        if (index === 2 && serve && path.startsWith('/public/')) {
          publicHits[index]!++;
          fetch(`${relayUrl}${path}`).then(async response => {
            const body = Buffer.from(await response.arrayBuffer());
            res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' });
            res.end(body);
          }).catch(() => { res.writeHead(502); res.end(); });
          return;
        }
        publicHits[index]!++;
        res.writeHead(503);
        res.end();
      }));
      const urls = await Promise.all(servers.map(listen));
      try {
        await fund([requester, fulfiller]);
        const { coordinator, key, beacon } = await deployCoordinator();
        const { requestId, requestReceipt, record } = await requestRandomness(coordinator, `0x${'44'.repeat(32)}`);
        await mineBlocks(Number(record.confirmations));
        const roundTime = beacon.genesis + (record.targetRound - 1n) * beacon.period;
        let now = roundTime;
        const lines: string[] = [];
        const before = await nonceOf(fulfiller.address);
        const worker = createWorker({
          rpcUrl, coordinator, chain, fulfillerPrivateKey: fulfillerKey, provingKey: key,
          relayUrls: urls, drandPin: pinOf(beacon), nowSeconds: () => now,
          report: line => lines.push(line),
        });
        const early = await worker.pollOnce();
        assert.equal(forRequest(early, requestId)?.status, 'retry');
        assert.equal(forRequest(early, requestId)?.transactionHash, undefined);
        assert.deepEqual(healthHits, [0, 0, 0], 'a round that is not yet 30s late does not check health');
        now = roundTime + 29n;
        const almost = await worker.pollOnce();
        assert.equal(forRequest(almost, requestId)?.status, 'retry');
        assert.deepEqual(healthHits, [0, 0, 0]);
        now = roundTime + 30n;
        const stalled = await worker.pollOnce();
        assert.equal(forRequest(stalled, requestId)?.status, 'stalled');
        assert.equal(forRequest(stalled, requestId)?.transactionHash, undefined);
        assert.deepEqual(healthHits, [1, 1, 1]);
        assert.deepEqual(lines, [`worker: drand config ${record.drandConfigId} round ${record.targetRound} stalled`]);
        const line = lines[0] ?? '';
        assert.equal(line.includes('0x'), false);
        assert.equal(line.includes(String(fixture.vectors[0].vrf.secretKey).replace(/^0x/, '')), false);
        assert.equal(line.includes(String(fixture.drand.secretKey).replace(/^0x/, '')), false);
        const again = await worker.pollOnce();
        assert.equal(forRequest(again, requestId)?.status, 'stalled');
        assert.equal(lines.length, 1, 'a stall is reported once per episode');
        assert.deepEqual(healthHits, [1, 1, 1]);
        assert.equal(await nonceOf(fulfiller.address), before);
        const still = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [requestId] });
        assert.equal(still.status, 1);
        const refunds = await client.getLogs({ address: coordinator, event: parseAbiItem('event Refunded(bytes32 indexed requestId, uint8 reason)'), args: { requestId }, fromBlock: requestReceipt.blockNumber, toBlock: await head(), strict: true });
        assert.equal(refunds.length, 0);
        serve = true;
        const submitted = await worker.pollOnce();
        assert.equal(forRequest(submitted, requestId)?.status, 'submitted');
        const fulfilledReceipt = await receipt(forRequest(submitted, requestId)!.transactionHash!);
        const derivationContext = fixture.vectors[0].derivations[0].context as Hex;
        const expectedUrl = new URL(`${relayUrl}/expected`);
        for (const [name, value] of Object.entries({ chainId: 33, round: record.targetRound, coordinator, requester: requester.address, requestId, context: derivationContext })) expectedUrl.searchParams.set(name, String(value));
        const expected = await (await fetch(expectedUrl)).json() as { beta: Hex };
        const finalRecord = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [requestId] });
        assert.equal(finalRecord.status, 2);
        assert.equal(finalRecord.beta, expected.beta);
        assert.equal(parseEventLogs({ abi: coordinatorAbi, eventName: 'Fulfilled', logs: fulfilledReceipt.logs }).length, 1);
      } finally {
        await Promise.all(servers.map(closeServer));
      }
    });
  });

  it('sends at most eight legacy fulfills, earliest chain deadline first', { timeout: 300_000 }, async () => {
    await withRelay(18775, async relayUrl => {
      await fund([requester, fulfiller]);
      const { coordinator, key, beacon } = await deployCoordinator();
      const made: { requestId: Hex }[] = [];
      for (let i = 0; i < 9; i++) {
        if (i > 0) await mine();
        const tag = `0x${(i + 1).toString(16).padStart(64, '0')}` as Hex;
        const { requestId } = await requestRandomness(coordinator, tag);
        made.push({ requestId });
      }
      const lastId = made[8]?.requestId;
      assert.ok(lastId);
      const lastRecord = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [lastId] });
      await mineBlocks(Number(lastRecord.confirmations));
      let now = 0n;
      for (const item of made) {
        const record = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [item.requestId] });
        const roundTime = beacon.genesis + (record.targetRound - 1n) * beacon.period;
        if (roundTime > now) now = roundTime;
      }
      const bucket = { n: 0 };
      const before = await nonceOf(fulfiller.address);
      const quote = await quotedStart();
      assert.equal(quote.cap, quote.minimum > 0n ? 80n * quote.minimum - 1n : null);
      const worker = createWorker({
        rpcUrl, coordinator, chain, fulfillerPrivateKey: fulfillerKey, provingKey: key,
        relayUrl, drandPin: pinOf(beacon), nowSeconds: () => now, fetch: countingFetch(bucket),
      });
      const results = await worker.pollOnce();
      assert.equal(results.length, 9);
      assert.equal(bucket.n, 8);
      const submitted = results.filter(item => item.status === 'submitted');
      const waiting = results.filter(item => item.status === 'waiting');
      assert.equal(submitted.length, 8);
      assert.equal(waiting.length, 1);
      assert.equal(await nonceOf(fulfiller.address), before + 8);
      const ranked: { requestId: Hex; deadline: bigint }[] = [];
      for (const item of made) {
        const live = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [item.requestId] });
        ranked.push({ requestId: item.requestId, deadline: BigInt(live.deadline) });
      }
      ranked.sort((a, b) => a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : 0);
      for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i]!.deadline > ranked[i - 1]!.deadline);
      const latestId = ranked[8]!.requestId;
      assert.equal(forRequest(results, latestId)?.status, 'waiting');
      assert.equal(forRequest(results, latestId)?.transactionHash, undefined);
      const earliest = ranked.slice(0, 8).map(item => item.requestId.toLowerCase());
      const observed: { nonce: number; requestId: string }[] = [];
      for (const item of submitted) {
        assert.ok(item.transactionHash);
        const tx = await client.getTransaction({ hash: item.transactionHash });
        assert.equal(tx.type, 'legacy');
        if (tx.type !== 'legacy') assert.fail('fulfillment is a legacy transaction');
        assert.equal(tx.gas, 507_000n);
        assert.equal(tx.gasPrice, quote.price);
        const decoded = decodeFunctionData({ abi: coordinatorAbi, data: tx.input });
        assert.equal(decoded.functionName, 'fulfill');
        const args = decoded.args as readonly unknown[] | undefined;
        const first = args?.[0];
        assert.equal(typeof first, 'string');
        observed.push({ nonce: tx.nonce, requestId: String(first).toLowerCase() });
      }
      observed.sort((a, b) => a.nonce - b.nonce);
      for (let i = 0; i < 8; i++) {
        assert.equal(observed[i]!.nonce, before + i);
        assert.equal(observed[i]!.requestId, earliest[i]);
      }
      await mine();
    });
  });

  it('sends nothing below the cost of twenty fulfills and resumes at equality for the earlier deadline', { timeout: 300_000 }, async () => {
    await withRelay(18776, async relayUrl => {
      const poorKey = `0x${'78'.repeat(32)}` as Hex;
      const poor = privateKeyToAccount(poorKey);
      const poorWallet = createWalletClient({ account: poor, chain, transport: http(rpcUrl) });
      const fee = 21_000n * 1n;
      await fund([requester]);
      const { coordinator, key, beacon } = await deployCoordinator();
      const first = await requestRandomness(coordinator, `0x${'11'.repeat(32)}`);
      await mine();
      const second = await requestRandomness(coordinator, `0x${'22'.repeat(32)}`);
      await mineBlocks(Number(second.record.confirmations));
      const balanceOf = () => client.getBalance({ address: poor.address });
      let quote = await quotedStart();
      let cost = 20n * 507_000n * quote.price;
      let balance = await balanceOf();
      if (balance >= cost && balance > fee + 1n) {
        const target = cost - 1n;
        const value = balance > target + fee ? balance - target - fee : 1n;
        await receipt(await poorWallet.sendTransaction({ to: poor.address, value, gas: 21_000n, gasPrice: 1n }));
      }
      quote = await quotedStart();
      cost = 20n * 507_000n * quote.price;
      balance = await balanceOf();
      if (balance < cost - 1n) {
        await receipt(await wallet.sendTransaction({ to: poor.address, value: cost - 1n - balance, gas: 21_000n, gasPrice: 1n }));
      }
      quote = await quotedStart();
      cost = 20n * 507_000n * quote.price;
      balance = await balanceOf();
      if (balance >= cost && balance > fee + 1n) {
        await receipt(await poorWallet.sendTransaction({ to: poor.address, value: 1n, gas: 21_000n, gasPrice: 1n }));
      }
      quote = await quotedStart();
      cost = 20n * 507_000n * quote.price;
      assert.ok(await balanceOf() < cost);
      const firstRound = beacon.genesis + (first.record.targetRound - 1n) * beacon.period;
      const secondRound = beacon.genesis + (second.record.targetRound - 1n) * beacon.period;
      const now = firstRound > secondRound ? firstRound : secondRound;
      const bucket = { n: 0 };
      const worker = createWorker({
        rpcUrl, coordinator, chain, fulfillerPrivateKey: poorKey, provingKey: key,
        relayUrl, drandPin: pinOf(beacon), nowSeconds: () => now, fetch: countingFetch(bucket),
      });
      const before = await nonceOf(poor.address);
      const under = await worker.pollOnce();
      assert.equal(bucket.n, 0);
      assert.equal(forRequest(under, first.requestId)?.status, 'waiting');
      assert.equal(forRequest(under, second.requestId)?.status, 'waiting');
      assert.equal(forRequest(under, first.requestId)?.transactionHash, undefined);
      assert.equal(await nonceOf(poor.address), before);
      assert.equal((await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [first.requestId] })).status, 1);
      assert.equal((await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [second.requestId] })).status, 1);
      const refunds = await client.getLogs({ address: coordinator, event: parseAbiItem('event Refunded(bytes32 indexed requestId, uint8 reason)'), fromBlock: first.requestReceipt.blockNumber, toBlock: await head(), strict: true });
      assert.equal(refunds.length, 0);
      for (let attempt = 0; attempt < 2; attempt++) {
        quote = await quotedStart();
        cost = 20n * 507_000n * quote.price;
        balance = await balanceOf();
        if (balance < cost) await receipt(await wallet.sendTransaction({ to: poor.address, value: cost - balance, gas: 21_000n, gasPrice: 1n }));
      }
      quote = await quotedStart();
      cost = 20n * 507_000n * quote.price;
      balance = await balanceOf();
      const oneFulfillment = 507_000n * quote.price;
      if (balance >= cost + oneFulfillment && balance > cost + fee) {
        await receipt(await poorWallet.sendTransaction({ to: poor.address, value: balance - cost - fee, gas: 21_000n, gasPrice: 1n }));
      }
      quote = await quotedStart();
      cost = 20n * 507_000n * quote.price;
      const window = 507_000n * quote.price;
      balance = await balanceOf();
      assert.ok(balance >= cost && balance < cost + window);
      bucket.n = 0;
      const beforeSend = await nonceOf(poor.address);
      const sent = await worker.pollOnce();
      const liveFirst = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [first.requestId] });
      const liveSecond = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [second.requestId] });
      const earlier = BigInt(liveFirst.deadline) < BigInt(liveSecond.deadline) ? first.requestId : second.requestId;
      const later = earlier === first.requestId ? second.requestId : first.requestId;
      assert.equal(forRequest(sent, earlier)?.status, 'submitted');
      assert.equal(forRequest(sent, later)?.status, 'waiting');
      assert.equal(bucket.n, 1);
      assert.equal(await nonceOf(poor.address), beforeSend + 1);
      const hash = forRequest(sent, earlier)?.transactionHash;
      assert.ok(hash);
      const tx = await client.getTransaction({ hash });
      assert.equal(tx.type, 'legacy');
      if (tx.type !== 'legacy') assert.fail('fulfillment is a legacy transaction');
      assert.equal(tx.gas, 507_000n);
      assert.equal(tx.gasPrice, quote.price);
      assert.equal(tx.from.toLowerCase(), poor.address.toLowerCase());
      const fulfilledReceipt = await receipt(hash);
      const after = await balanceOf();
      quote = await quotedStart();
      cost = 20n * 507_000n * quote.price;
      if (after < cost) {
        bucket.n = 0;
        const heldNonce = await nonceOf(poor.address);
        const held = await worker.pollOnce();
        assert.equal(forRequest(held, later)?.status, 'waiting');
        assert.equal(forRequest(held, later)?.transactionHash, undefined);
        assert.equal(bucket.n, 0);
        assert.equal(await nonceOf(poor.address), heldNonce);
        assert.equal((await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [later] })).status, 1);
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        quote = await quotedStart();
        cost = 20n * 507_000n * quote.price;
        balance = await balanceOf();
        if (balance < cost) await receipt(await wallet.sendTransaction({ to: poor.address, value: cost - balance, gas: 21_000n, gasPrice: 1n }));
      }
      assert.ok(await balanceOf() >= 20n * 507_000n * (await quotedStart()).price);
      bucket.n = 0;
      const resumed = await worker.pollOnce();
      assert.equal(forRequest(resumed, later)?.status, 'submitted');
      const laterHash = forRequest(resumed, later)?.transactionHash;
      assert.ok(laterHash);
      const laterReceipt = await receipt(laterHash);
      assert.equal((await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [later] })).status, 2);
      for (const mined of [fulfilledReceipt, laterReceipt]) {
        const logs = parseEventLogs({ abi: coordinatorAbi, eventName: 'Fulfilled', logs: mined.logs });
        assert.equal(logs.length, 1);
        assert.equal(logs[0]?.args.fulfiller.toLowerCase(), poor.address.toLowerCase());
      }
    });
  });

  it('backup with grace 100 does not submit until requestBlock + confirmations + 100', { timeout: 300_000 }, async () => {
    await withRelay(18777, async relayUrl => {
      const backupKey = `0x${'9a'.repeat(32)}` as Hex;
      const backup = privateKeyToAccount(backupKey);
      await fund([requester, backup]);
      const { coordinator, key, beacon } = await deployCoordinator();
      const { requestId, record } = await requestRandomness(coordinator, `0x${'44'.repeat(32)}`);
      assert.equal(record.confirmations, 12);
      const bucket = { n: 0 };
      const worker = createWorker({
        rpcUrl, coordinator, chain, fulfillerPrivateKey: backupKey, provingKey: key, relayUrl,
        drandPin: pinOf(beacon), graceBlocks: 100, fetch: countingFetch(bucket),
        nowSeconds: () => beacon.genesis + (record.targetRound - 1n) * beacon.period,
      });
      const fulfillableAt = BigInt(record.requestBlock) + BigInt(record.confirmations) + 100n;
      await mineTo(fulfillableAt - 1n);
      const before = await nonceOf(backup.address);
      bucket.n = 0;
      const early = await worker.pollOnce();
      assert.equal(forRequest(early, requestId)?.status, 'waiting');
      assert.equal(forRequest(early, requestId)?.transactionHash, undefined);
      assert.equal(bucket.n, 0);
      assert.equal(await nonceOf(backup.address), before);
      assert.equal((await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [requestId] })).status, 1);
      await mine();
      assert.equal(await head(), fulfillableAt);
      const submitted = await worker.pollOnce();
      assert.equal(forRequest(submitted, requestId)?.status, 'submitted');
      const hash = forRequest(submitted, requestId)?.transactionHash;
      assert.ok(hash);
      const fulfilledReceipt = await receipt(hash);
      const derivationContext = fixture.vectors[0].derivations[0].context as Hex;
      const expectedUrl = new URL(`${relayUrl}/expected`);
      for (const [name, value] of Object.entries({ chainId: 33, round: record.targetRound, coordinator, requester: requester.address, requestId, context: derivationContext })) expectedUrl.searchParams.set(name, String(value));
      const expected = await (await fetch(expectedUrl)).json() as { beta: Hex };
      const finalRecord = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [requestId] });
      assert.equal(finalRecord.status, 2);
      assert.equal(finalRecord.beta, expected.beta);
      const logs = parseEventLogs({ abi: coordinatorAbi, eventName: 'Fulfilled', logs: fulfilledReceipt.logs });
      assert.equal(logs.length, 1);
      assert.equal(logs[0]?.args.fulfiller.toLowerCase(), backup.address.toLowerCase());
      assert.equal(parseEventLogs({ abi: coordinatorAbi, eventName: 'Refunded', logs: fulfilledReceipt.logs }).length, 0);
    });
  });

  it('primary and backup both broadcast once and exactly one fulfillment lands', { timeout: 300_000 }, async () => {
    await withRelay(18778, async relayUrl => {
      const primaryKey = `0x${'9a'.repeat(32)}` as Hex;
      const backupKey = `0x${'bc'.repeat(32)}` as Hex;
      const primary = privateKeyToAccount(primaryKey);
      const backup = privateKeyToAccount(backupKey);
      await fund([requester, primary, backup]);
      const { coordinator, key, beacon } = await deployCoordinator();
      const { requestId, record } = await requestRandomness(coordinator, `0x${'55'.repeat(32)}`);
      assert.equal(record.confirmations, 12);
      const primaryHits = { n: 0 };
      const backupHits = { n: 0 };
      const shared = {
        rpcUrl, coordinator, chain, provingKey: key, relayUrl, drandPin: pinOf(beacon),
        nowSeconds: () => beacon.genesis + (record.targetRound - 1n) * beacon.period,
      };
      const primaryWorker = createWorker({ ...shared, fulfillerPrivateKey: primaryKey, graceBlocks: 0, fetch: countingFetch(primaryHits) });
      const backupWorker = createWorker({ ...shared, fulfillerPrivateKey: backupKey, graceBlocks: 100, fetch: countingFetch(backupHits) });
      const fulfillableAt = BigInt(record.requestBlock) + BigInt(record.confirmations) + 100n;
      await mineTo(fulfillableAt);
      const primaryBefore = await nonceOf(primary.address);
      const backupBefore = await nonceOf(backup.address);
      const primaryResults = await primaryWorker.pollOnce();
      const backupResults = await backupWorker.pollOnce();
      assert.equal(forRequest(primaryResults, requestId)?.status, 'submitted');
      assert.equal(forRequest(backupResults, requestId)?.status, 'submitted');
      const primaryHash = forRequest(primaryResults, requestId)?.transactionHash;
      const backupHash = forRequest(backupResults, requestId)?.transactionHash;
      assert.ok(primaryHash);
      assert.ok(backupHash);
      assert.equal(primaryHits.n, 1);
      assert.equal(backupHits.n, 1);
      assert.equal(await nonceOf(primary.address), primaryBefore + 1);
      assert.equal(await nonceOf(backup.address), backupBefore + 1);
      await mine();
      const receipts = await Promise.all([primaryHash, backupHash].map(hash => client.waitForTransactionReceipt({ hash })));
      const success = receipts.filter(item => item.status === 'success');
      const reverted = receipts.filter(item => item.status === 'reverted');
      assert.equal(success.length, 1);
      assert.equal(reverted.length, 1);
      const fulfilled = receipts.flatMap(item => parseEventLogs({ abi: coordinatorAbi, eventName: 'Fulfilled', logs: item.logs }));
      assert.equal(fulfilled.length, 1);
      const winner = fulfilled[0]?.args.fulfiller.toLowerCase();
      assert.ok(winner === primary.address.toLowerCase() || winner === backup.address.toLowerCase());
      assert.equal(receipts.flatMap(item => parseEventLogs({ abi: coordinatorAbi, eventName: 'Refunded', logs: item.logs })).length, 0);
      const derivationContext = fixture.vectors[0].derivations[0].context as Hex;
      const expectedUrl = new URL(`${relayUrl}/expected`);
      for (const [name, value] of Object.entries({ chainId: 33, round: record.targetRound, coordinator, requester: requester.address, requestId, context: derivationContext })) expectedUrl.searchParams.set(name, String(value));
      const expected = await (await fetch(expectedUrl)).json() as { beta: Hex };
      const finalRecord = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [requestId] });
      assert.equal(finalRecord.status, 2);
      assert.equal(finalRecord.beta, expected.beta);
      primaryHits.n = 0;
      backupHits.n = 0;
      const laterPrimary = await primaryWorker.pollOnce();
      const laterBackup = await backupWorker.pollOnce();
      assert.equal(forRequest(laterPrimary, requestId)?.status, 'waiting');
      assert.equal(forRequest(laterBackup, requestId)?.status, 'waiting');
      assert.equal(forRequest(laterPrimary, requestId)?.transactionHash, undefined);
      assert.equal(forRequest(laterBackup, requestId)?.transactionHash, undefined);
      assert.equal(primaryHits.n, 0);
      assert.equal(backupHits.n, 0);
      assert.equal(await nonceOf(primary.address), primaryBefore + 1);
      assert.equal(await nonceOf(backup.address), backupBefore + 1);
    });
  });

  it('real rskj: upgrade preserves requests and balances; worker fulfills, settles fees and refunds Escrow', { timeout: 180_000 }, async () => {
    const relayPort = 18769;
    const relay = spawn(process.env.TEST_RELAY_BIN ?? '/tmp/rsk-vrf-test-relay', ['-test-relay', `127.0.0.1:${relayPort}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    let relayError = ''; relay.stderr.on('data', chunk => { relayError += String(chunk); });
    try {
      const relayUrl = `http://127.0.0.1:${relayPort}`;
      let ready = false;
      for (let n = 0; n < 100; n++) {
        try { ready = (await fetch(`${relayUrl}/public/1`)).ok; if (ready) break; } catch { /* startup only */ }
        if (relay.exitCode !== null) throw new Error(`Test relay exited: ${relayError}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(ready, 'offline signing relay starts');
      assert.equal(await client.getChainId(), 33, 'must use real rskj regtest');
      for (const account of [requester, fulfiller]) await receipt(await wallet.sendTransaction({ to: account.address, value: 10n ** 19n, gas: 21_000n, gasPrice: 1n }));
      const implementation = artifact('VRFCoordinator');
      const deployed = await receipt(await wallet.deployContract({ abi: implementation.abi, bytecode: implementation.bytecode.object, gas: 6_500_000n, gasPrice: 1n }));
      assert.ok(deployed.contractAddress);
      const beacon = { publicKey: fixture.drand.publicKey.map(BigInt), genesis: BigInt(fixture.drand.genesis), period: BigInt(fixture.drand.period) };
      const init = encodeFunctionData({ abi: implementation.abi, functionName: 'initialize', args: [owner.address, beacon] });
      const proxy = artifact('ERC1967Proxy');
      const proxyReceipt = await receipt(await wallet.deployContract({ abi: proxy.abi, bytecode: proxy.bytecode.object, args: [deployed.contractAddress, init], gas: 2_000_000n, gasPrice: 1n }));
      const coordinator = proxyReceipt.contractAddress!;
      const key = ProvingKey.fromHex(fixture.vectors[0].vrf.secretKey);
      await receipt(await wallet.writeContract({ address: coordinator, abi: coordinatorAbi, functionName: 'registerProvingKey', args: [key.publicKey, owner.address], gas: 500_000n, gasPrice: 1n }));
      const requesterWallet = createWalletClient({ account: requester, chain, transport: http(rpcUrl) });
      const initialFee = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'fee' });
      const requestReceipt = await receipt(await requesterWallet.writeContract({ address: coordinator, abi: coordinatorAbi, functionName: 'request', args: [`0x${'ab'.repeat(32)}`], value: initialFee, gas: 500_000n, gasPrice: 1n }));
      const event = parseEventLogs({ abi: coordinatorAbi, eventName: 'RandomnessRequested', logs: requestReceipt.logs })[0]!;
      const requestId = event.args.requestId;
      const record = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [requestId] });
      const roundTime = beacon.genesis + (record.targetRound - 1n) * beacon.period;
      let now = roundTime - 1n;
      let relayCalls = 0;
      let invalidSignature = true;
      let worker = createWorker({ rpcUrl, coordinator, chain, fulfillerPrivateKey: fulfillerKey, provingKey: key, relayUrl, drandPin: pinOf(beacon), nowSeconds: () => now,
        fetch: async (input, init) => {
          relayCalls++;
          const response = await fetch(input, init);
          if (!invalidSignature) return response;
          const body = await response.json() as { round: number; signature: string };
          // Valid point/signature for a DIFFERENT round: only contract simulation
          // rejects this, after a genuine noble proof has been composed.
          const other = await (await fetch(`${relayUrl}/public/${record.targetRound + 1n}`)).json() as { signature: string };
          return Response.json({ ...body, signature: other.signature });
        },
      });
      now = roundTime;
      assert.deepEqual((await worker.pollOnce()).map(x => x.status), ['waiting']);
      assert.equal(relayCalls, 0, 'frozen confirmations are checked before fetching a published round');
      now = roundTime - 1n;
      for (let n = 0; n < 12; n++) await mine();
      assert.deepEqual((await worker.pollOnce()).map(x => x.status), ['waiting']);
      assert.equal(relayCalls, 0, 'future frozen round does not fetch or consume event');
      now = roundTime;
      const before = await client.getTransactionCount({ address: fulfiller.address, blockTag: 'pending' });
      assert.deepEqual((await worker.pollOnce()).map(x => x.status), ['retry']);
      assert.equal(await client.getTransactionCount({ address: fulfiller.address, blockTag: 'pending' }), before, 'failed real eth_call must never broadcast');
      invalidSignature = false;
      const submitted = await worker.pollOnce();
      assert.equal(submitted[0]?.status, 'submitted', 'same queued request retries after simulation failure');
      const fulfilledReceipt = await receipt(submitted[0]!.transactionHash!);
      const fulfilled = parseEventLogs({ abi: coordinatorAbi, eventName: 'Fulfilled', logs: fulfilledReceipt.logs })[0]!;
      assert.equal(fulfilled.args.fulfiller.toLowerCase(), fulfiller.address.toLowerCase());
      assert.notEqual(requester.address, fulfiller.address);
      const derivationContext = fixture.vectors[0].derivations[0].context as Hex;
      const expectedUrl = new URL(`${relayUrl}/expected`);
      for (const [name, value] of Object.entries({ chainId: 33, round: record.targetRound, coordinator, requester: requester.address, requestId, context: derivationContext })) expectedUrl.searchParams.set(name, String(value));
      const expected = await (await fetch(expectedUrl)).json() as { beta: Hex; random: Hex };
      const final = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [requestId] });
      assert.equal(final.status, 2);
      assert.equal(final.beta, expected.beta, 'Beta matches independently domain-bound Go prover output');
      assert.equal(await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'deriveRandom', args: [requestId, derivationContext] }), BigInt(expected.random));
      assert.equal(forRequest(await worker.pollOnce(), requestId)?.status, 'waiting');
      await mineBlocks(12);
      assert.deepEqual(await worker.pollOnce(), []);

      // Populate every namespace before upgrading: Admin parameters, the append-only
      // beacon list, the Key Registry, requester nonce, terminal and Pending records,
      // and Ownable2Step's pending Admin. None may change when the implementation does.
      for (const [functionName, value] of [
        ['setFeeConfig', 12_345n], ['setCallbackGasCap', 250_000n],
        ['setRoundOffset', 41n], ['setTimeoutBlocks', 601n], ['setConfirmations', 6n],
      ] as const) {
        await receipt(await wallet.writeContract({ address: coordinator, abi: implementation.abi, functionName, args: [value], gas: 150_000n, gasPrice: 1n }));
      }
      const nextBeacon = { ...beacon, period: beacon.period + 1n };
      await receipt(await wallet.writeContract({ address: coordinator, abi: implementation.abi, functionName: 'addDrandConfig', args: [nextBeacon], gas: 500_000n, gasPrice: 1n }));
      await receipt(await wallet.writeContract({ address: coordinator, abi: implementation.abi, functionName: 'transferOwnership', args: [requester.address], gas: 150_000n, gasPrice: 1n }));
      const pendingFee = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'fee' });
      const pendingReceipt = await receipt(await requesterWallet.writeContract({ address: coordinator, abi: implementation.abi, functionName: 'request', args: [`0x${'cd'.repeat(32)}`], value: pendingFee, gas: 500_000n, gasPrice: 1n }));
      const pendingId = parseEventLogs({ abi: coordinatorAbi, eventName: 'RandomnessRequested', logs: pendingReceipt.logs })[0]!.args.requestId;
      const pendingRecord = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [pendingId] });
      assert.equal(pendingRecord.status, 1);
      assert.equal(pendingRecord.fee, 12_345n);
      assert.equal(pendingRecord.drandConfigId, 1);
      assert.equal(pendingRecord.confirmations, 6);
      assert.equal(pendingRecord.deadline - pendingRecord.requestBlock, 601);
      const getters = ['fee', 'callbackGasCap', 'roundOffset', 'timeoutBlocks', 'confirmations', 'drandConfigCount', 'owner', 'pendingOwner'] as const;
      const readParameters = () => Promise.all(getters.map(functionName => client.readContract({ address: coordinator, abi: implementation.abi, functionName })));
      const parameters = await readParameters();
      const balanceBeforeUpgrade = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'payeeBalance', args: [owner.address] });
      const provingKey = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getProvingKey', args: [1] });
      const nonce = await client.readContract({ address: coordinator, abi: implementation.abi, functionName: 'requesterNonce', args: [requester.address] });
      assert.equal(nonce, 2n);
      const next = artifact('VRFCoordinatorV2');
      const nextReceipt = await receipt(await wallet.deployContract({ abi: next.abi, bytecode: next.bytecode.object, gas: 6_500_000n, gasPrice: 1n }));
      const nextAddress = nextReceipt.contractAddress!;
      const implementationSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
      const originalImplementation = await client.getStorageAt({ address: coordinator, slot: implementationSlot });
      await assert.rejects(client.simulateContract({ address: coordinator, abi: implementation.abi, functionName: 'upgradeToAndCall', args: [nextAddress, '0x'], account: requester, gas: 500_000n }), /transaction reverted/i, 'the pending Admin cannot upgrade before accepting ownership (rskj does not return custom error data)');
      const rejectedHash = await requesterWallet.writeContract({ address: coordinator, abi: implementation.abi, functionName: 'upgradeToAndCall', args: [nextAddress, '0x'], gas: 500_000n, gasPrice: 1n });
      await mine();
      assert.equal((await client.waitForTransactionReceipt({ hash: rejectedHash })).status, 'reverted', 'non-Admin upgrade is rejected in a mined transaction');
      assert.equal(await client.getStorageAt({ address: coordinator, slot: implementationSlot }), originalImplementation);
      const upgraded = await receipt(await wallet.writeContract({ address: coordinator, abi: implementation.abi, functionName: 'upgradeToAndCall', args: [nextAddress, '0x'], gas: 500_000n, gasPrice: 1n }));
      assert.equal(parseEventLogs({ abi: implementation.abi, eventName: 'Upgraded', logs: upgraded.logs }).length, 1);
      assert.equal(await client.getStorageAt({ address: coordinator, slot: implementationSlot }), `0x${nextAddress.slice(2).toLowerCase().padStart(64, '0')}`);
      assert.equal(await client.readContract({ address: coordinator, abi: next.abi, functionName: 'revision' }), 2n, 'proxy executes the new implementation');
      assert.deepEqual(await readParameters(), parameters, 'all Admin parameters and ownership survive');
      assert.equal(await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'payeeBalance', args: [owner.address] }), balanceBeforeUpgrade, 'earned fees survive upgrade');
      assert.equal(await client.readContract({ address: coordinator, abi: implementation.abi, functionName: 'requesterNonce', args: [requester.address] }), nonce);
      assert.equal(await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'activeKeyId' }), 1);
      assert.deepEqual(await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getProvingKey', args: [1] }), provingKey);
      assert.deepEqual(await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getDrandConfig', args: [0] }), beacon);
      assert.deepEqual(await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getDrandConfig', args: [1] }), nextBeacon);
      assert.deepEqual(await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [requestId] }), final, 'Fulfilled record and Beta survive');
      assert.deepEqual(await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [pendingId] }), pendingRecord, 'Pending request retains its complete frozen record');
      assert.equal(await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'deriveRandom', args: [requestId, derivationContext] }), BigInt(expected.random));

      // The same proxy and key still accept the proof of the pre-upgrade request.
      now = nextBeacon.genesis + (pendingRecord.targetRound - 1n) * nextBeacon.period;
      for (let n = 0; n < pendingRecord.confirmations; n++) await mine();
      // The upgraded coordinator's new beacon requires an explicit new local pin.
      worker = createWorker({ rpcUrl, coordinator, chain, fulfillerPrivateKey: fulfillerKey, provingKey: key, relayUrl, drandPin: pinOf(nextBeacon), nowSeconds: () => now });
      const afterUpgrade = await worker.pollOnce();
      assert.equal(afterUpgrade[0]?.status, 'submitted', 'pre-upgrade Pending request remains Fulfillable');
      await receipt(afterUpgrade[0]!.transactionHash!);
      const pendingExpectedUrl = new URL(`${relayUrl}/expected`);
      for (const [name, value] of Object.entries({ chainId: 33, round: pendingRecord.targetRound, coordinator, requester: requester.address, requestId: pendingId, context: derivationContext })) pendingExpectedUrl.searchParams.set(name, String(value));
      const pendingExpected = await (await fetch(pendingExpectedUrl)).json() as { beta: Hex; random: Hex };
      const after = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [pendingId] });
      assert.equal(after.status, 2);
      assert.equal(after.beta, pendingExpected.beta, 'post-upgrade Beta still matches the independent Go prover');
      assert.equal(await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'deriveRandom', args: [pendingId, derivationContext] }), BigInt(pendingExpected.random));
      await mineBlocks(12);
      const fee = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'fee' });
      assert.equal(record.fee, 20_000_000_000_000n, 'request escrows exact native rBTC fee');
      assert.equal(await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'payeeBalance', args: [owner.address] }), record.fee + pendingRecord.fee);
      const withdrew = await receipt(await wallet.writeContract({ address: coordinator, abi: coordinatorAbi, functionName: 'withdrawFees', gas: 300_000n, gasPrice: 1n }));
      assert.equal(parseEventLogs({ abi: coordinatorAbi, eventName: 'FeesWithdrawn', logs: withdrew.logs })[0]!.args.amount, record.fee + pendingRecord.fee);
      assert.equal(await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'payeeBalance', args: [owner.address] }), 0n);

      // Keep two requests queued while the worker is offline. A third party refunds
      // one; the other stays Pending after its hard Deadline. Neither may be sent.
      const expiring = [];
      for (const tag of ['cd', 'ef']) {
        const made = await receipt(await requesterWallet.writeContract({ address: coordinator, abi: coordinatorAbi, functionName: 'request', args: [`0x${tag.repeat(32)}`], value: fee, gas: 500_000n, gasPrice: 1n }));
        const id = parseEventLogs({ abi: coordinatorAbi, eventName: 'RandomnessRequested', logs: made.logs })[0]!.args.requestId;
        const request = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [id] });
        expiring.push({ id, request });
      }
      assert.deepEqual((await worker.pollOnce()).map(x => x.status), ['waiting', 'waiting']);
      // Changing the current fee must not change either request's Refund amount.
      await receipt(await wallet.writeContract({ address: coordinator, abi: coordinatorAbi, functionName: 'setFeeConfig', args: [0n], gas: 100_000n, gasPrice: 1n }));
      while (await client.getBlockNumber({ cacheTime: 0 }) <= BigInt(expiring[1]!.request.deadline)) await mine();
      const requesterBeforeRefund = await client.getBalance({ address: requester.address });
      const refunded = await receipt(await wallet.writeContract({ address: coordinator, abi: coordinatorAbi, functionName: 'timeoutRefund', args: [expiring[0]!.id], gas: 300_000n, gasPrice: 1n }));
      assert.equal(parseEventLogs({ abi: coordinatorAbi, eventName: 'Refunded', logs: refunded.logs })[0]!.args.reason, 0, 'Deadline reason');
      assert.equal(await client.getBalance({ address: requester.address }), requesterBeforeRefund + fee, 'third-party refund pushes the frozen Escrow to Requester');
      const refundRecord = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [expiring[0]!.id] });
      assert.equal(refundRecord.status, 3);
      assert.equal((await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [expiring[1]!.id] })).status, 1);
      const nonceBeforeSkip = await client.getTransactionCount({ address: fulfiller.address, blockTag: 'pending' });
      const callsBeforeSkip = relayCalls;
      assert.deepEqual((await worker.pollOnce()).map(x => x.status), ['waiting', 'skipped']);
      assert.equal(relayCalls, callsBeforeSkip, 'Refunded and expired requests never fetch a beacon');
      assert.equal(await client.getTransactionCount({ address: fulfiller.address, blockTag: 'pending' }), nonceBeforeSkip, 'no fulfill is broadcast past a hard Deadline');
      await mineBlocks(12);
      const remaining = await worker.pollOnce();
      assert.equal(forRequest(remaining, expiring[0]!.id), undefined, 'Refunded request leaves after 12 blocks');
      assert.equal(forRequest(remaining, expiring[1]!.id)?.status, 'skipped', 'expired Pending request stays until an outcome');

    } finally {
      relay.kill('SIGTERM');
      if (relay.exitCode === null) await once(relay, 'exit');
    }
  });
});
