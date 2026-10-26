import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { describe, it } from 'node:test';
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, parseAbi, parseEventLogs, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { coordinatorAbi } from '../src/coordinator.ts';
import { runWorkerLoop } from '../src/loop.ts';
import { createWorker, type DrandPin, type WorkerConfig } from '../src/worker.ts';
import { ProvingKey } from '../src/proving-key.ts';
import { encodeProof, type Proof } from '../src/vrf/prover.ts';
import { bytesToHex } from '../src/vrf/bytes.ts';
const rpcUrl = process.env.RSK_RPC_URL ?? 'http://127.0.0.1:4449';
const chain = defineChain({ id: 33, name: 'Rootstock regtest', nativeCurrency: { name: 'Test RBTC', symbol: 'tRBTC', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const client = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 50, cacheTime: 0 });
const owner = privateKeyToAccount('0xc85ef7d79691fe79573b1a7064c19c1a9819ebdbd1faaab1a8ec92344438aaf4');
const wallet = createWalletClient({ account: owner, chain, transport: http(rpcUrl) });
const fixture = JSON.parse(readFileSync(new URL('../../tools/vrf-vectors-go/coordinator-vectors.json', import.meta.url), 'utf8'));
const artifact = (name: string) => JSON.parse(readFileSync(new URL(`../../contracts/out/${name}.sol/${name}.json`, import.meta.url), 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
type Alert = { event: string; level: string; workerId: string; threshold?: number; requestId?: Hex; proof?: Record<string, unknown>; [name: string]: unknown };
async function listen(server: Server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}`; }
async function close(server: Server) { await new Promise<void>(resolve => server.close(() => resolve())); }
async function mine() { await client.request({ method: 'evm_mine' as never, params: [] as never }); }
async function mineTo(target: bigint) { while (await client.getBlockNumber({ cacheTime: 0 }) < target) await mine(); }
async function receipt(hash: Hex) { await mine(); const result = await client.waitForTransactionReceipt({ hash }); assert.equal(result.status, 'success'); return result; }
async function deploy() {
  assert.equal(await client.getChainId(), 33, 'must use real rskj regtest');
  const implementation = artifact('VRFCoordinator');
  const impl = await receipt(await wallet.deployContract({ abi: implementation.abi, bytecode: implementation.bytecode.object, gas: 6_500_000n, gasPrice: 1n }));
  assert.ok(impl.contractAddress);
  const pin: DrandPin = { publicKey: fixture.drand.publicKey.map(BigInt), genesis: BigInt(fixture.drand.genesis), period: BigInt(fixture.drand.period) };
  const proxy = artifact('ERC1967Proxy');
  const init = encodeFunctionData({ abi: implementation.abi, functionName: 'initialize', args: [owner.address, pin] });
  const deployed = await receipt(await wallet.deployContract({ abi: proxy.abi, bytecode: proxy.bytecode.object, args: [impl.contractAddress, init], gas: 2_000_000n, gasPrice: 1n }));
  assert.ok(deployed.contractAddress);
  const coordinator = deployed.contractAddress;
  const key = ProvingKey.fromHex(fixture.vectors[0].vrf.secretKey);
  await receipt(await wallet.writeContract({ address: coordinator, abi: coordinatorAbi, functionName: 'registerProvingKey', args: [key.publicKey, owner.address], gas: 500_000n, gasPrice: 1n }));
  return { coordinator, key, pin };
}
async function request(coordinator: Address, tag: string) {
  const made = await receipt(await wallet.writeContract({ address: coordinator, abi: coordinatorAbi, functionName: 'request', args: [`0x${tag.repeat(32)}`], value: await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'fee' }), gas: 500_000n, gasPrice: 1n }));
  const event = parseEventLogs({ abi: coordinatorAbi, eventName: 'RandomnessRequested', logs: made.logs })[0]!;
  const requestId = event.args.requestId;
  const record = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [requestId] });
  return { requestId, record };
}
async function sinks(body: (alerts: Alert[], url: string) => Promise<void>) {
  const alerts: Alert[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += String(chunk);
    const parsed = JSON.parse(raw) as Alert | { text: string };
    const alert = 'text' in parsed ? JSON.parse(String(parsed.text)) as Alert : parsed;
    assert.equal(req.url, alert.level === 'page' ? '/page' : '/warn', 'phone pages and chat warnings use separate destinations');
    alerts.push(alert); res.end('ok');
  });
  const url = await listen(server);
  try { await body(alerts, url); } finally { await close(server); }
}
function workerConfig(setup: Awaited<ReturnType<typeof deploy>>, url: string, privateKey: Hex): WorkerConfig {
  return { rpcUrl, coordinator: setup.coordinator, chain, fulfillerPrivateKey: privateKey, loadProvingKey: async hash => hash.toLowerCase() === setup.key.keyHash ? setup.key : undefined, drandPin: setup.pin, relayUrl: 'http://127.0.0.1:1', watchdog: { workerId: 'primary', pageUrl: `${url}/page`, warningUrl: `${url}/warn` }, report: () => {} };
}
function found(alerts: Alert[], event: string, level: string) { const alert = alerts.find(item => item.event === event && item.level === level); assert.ok(alert, `received ${level} ${event}`); return alert; }
async function withRelay(body: (relayUrl: string) => Promise<void>) {
  const relay = spawn(process.env.TEST_RELAY_BIN ?? '/tmp/rsk-vrf-test-relay', ['-test-relay', '127.0.0.1:18796'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const relayUrl = 'http://127.0.0.1:18796';
  try {
    let ready = false;
    for (let n = 0; n < 100; n++) {
      try { ready = (await fetch(`${relayUrl}/public/1`)).ok; if (ready) break; } catch { /* startup */ }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(ready, 'offline drand signer starts');
    await body(relayUrl);
  } finally { relay.kill('SIGTERM'); if (relay.exitCode === null) await once(relay, 'exit'); }
}
function decodeProof(raw: Record<string, unknown>): Proof {
  const pair = (name: string) => (raw[name] as string[]).map(BigInt) as [bigint, bigint];
  return { pk: pair('pk'), gamma: pair('gamma'), c: BigInt(String(raw.c)), s: BigInt(String(raw.s)), seed: BigInt(String(raw.seed)), uWitness: raw.uWitness as Hex, cGammaWitness: pair('cGammaWitness'), sHashWitness: pair('sHashWitness'), zInv: BigInt(String(raw.zInv)) };
}
describe('watchdog on real rskj', { concurrency: 1 }, () => {
  it('pages below twenty fulfillments and warns at the top-up threshold independently on each worker', { timeout: 180_000 }, async () => {
    await sinks(async (alerts, url) => {
      const setup = await deploy();
      const poorKey = `0x${'91'.repeat(32)}` as Hex;
      await createWorker(workerConfig(setup, url, poorKey)).pollOnce();
      found(alerts, 'low_balance', 'page');
      alerts.length = 0;
      const richKey = `0x${'92'.repeat(32)}` as Hex;
      const account = privateKeyToAccount(richKey);
      await receipt(await wallet.sendTransaction({ to: account.address, value: 1_000_000_000_000n, gas: 21_000n, gasPrice: 1n }));
      const config = workerConfig(setup, url, richKey);
      config.watchdog!.topUpFulfillments = 10n ** 18n;
      await createWorker(config).pollOnce();
      found(alerts, 'top_up_balance', 'warn');
      await createWorker({ ...config, watchdog: { ...config.watchdog!, workerId: 'backup' } }).pollOnce();
      assert.deepEqual(alerts.filter(a => a.event === 'top_up_balance').map(a => a.workerId), ['primary', 'backup']);
    });
  });
  it('warns at a quarter of the oldest pending window, pages at half, and never resets age on restart', { timeout: 180_000 }, async () => {
    await sinks(async (alerts, url) => {
      const setup = await deploy();
      const pending = await request(setup.coordinator, 'a1');
      const config = workerConfig(setup, url, `0x${'93'.repeat(32)}`);
      config.nowSeconds = () => 0n;
      const worker = createWorker(config);
      const start = BigInt(pending.record.requestBlock);
      const window = BigInt(pending.record.deadline) - start;
      const quarter = start + (window + 3n) / 4n;
      await mineTo(quarter - 1n);
      await worker.pollOnce();
      assert.equal(alerts.some(a => a.event === 'pending_age'), false);
      await mine();
      await worker.pollOnce();
      assert.equal(found(alerts, 'pending_age', 'warn').threshold, 25);
      assert.equal(found(alerts, 'pending_age', 'warn').requestId, pending.requestId);
      await worker.pollOnce();
      assert.equal(alerts.filter(a => a.event === 'pending_age' && a.level === 'warn').length, 1, 'repeat polls do not flood chat');
      await mineTo(start + (window + 1n) / 2n);
      await worker.pollOnce();
      assert.equal(found(alerts, 'pending_age', 'page').threshold, 50);
      assert.equal(found(alerts, 'pending_age', 'page').requestId, pending.requestId);
      alerts.length = 0;
      await createWorker(config).pollOnce();
      found(alerts, 'pending_age', 'page');
    });
  });

  it('pages when a pending request has no held Proving Key, even before confirmations', { timeout: 180_000 }, async () => {
    await sinks(async (alerts, url) => {
      const setup = await deploy();
      const pending = await request(setup.coordinator, 'a2');
      const config = workerConfig(setup, url, `0x${'94'.repeat(32)}`);
      config.loadProvingKey = async () => undefined;
      await createWorker(config).pollOnce();
      assert.equal(found(alerts, 'missing_proving_key', 'page').requestId, pending.requestId);
    });
  });

  it('pages when the on-chain drand configuration differs from the pinned chain', { timeout: 180_000 }, async () => {
    await sinks(async (alerts, url) => {
      const setup = await deploy();
      await request(setup.coordinator, 'a3');
      const config = workerConfig(setup, url, `0x${'95'.repeat(32)}`);
      config.drandPin = { ...setup.pin, period: setup.pin.period + 1n };
      const worker = createWorker(config);
      await worker.pollOnce();
      found(alerts, 'drand_config_mismatch', 'page');
      await worker.pollOnce();
      assert.equal(alerts.filter(a => a.event === 'drand_config_mismatch').length, 1);
    });
  });

  it('pages for Key Registry changes and does not repeat already observed changes', { timeout: 180_000 }, async () => {
    await sinks(async (alerts, url) => {
      const setup = await deploy();
      const worker = createWorker(workerConfig(setup, url, `0x${'96'.repeat(32)}`));
      await worker.pollOnce();
      const before = alerts.filter(a => a.event === 'key_registry_changed').length;
      const next = ProvingKey.fromHex(`0x${'97'.repeat(32)}`);
      await receipt(await wallet.writeContract({ address: setup.coordinator, abi: coordinatorAbi, functionName: 'registerProvingKey', args: [next.publicKey, owner.address], gas: 500_000n, gasPrice: 1n }));
      await worker.pollOnce();
      assert.ok(alerts.filter(a => a.event === 'key_registry_changed').length > before, 'registration pages');
      const afterRegistration = alerts.filter(a => a.event === 'key_registry_changed').length;
      await worker.pollOnce();
      assert.equal(alerts.filter(a => a.event === 'key_registry_changed').length, afterRegistration);
      await receipt(await wallet.writeContract({ address: setup.coordinator, abi: parseAbi(['function revoke(bytes32 keyHash)']), functionName: 'revoke', args: [setup.key.keyHash], gas: 200_000n, gasPrice: 1n }));
      await worker.pollOnce();
      assert.ok(alerts.filter(a => a.event === 'key_registry_changed').length > afterRegistration, 'revocation pages');
    });
  });

  it('pages for a foreign fulfiller while allowing both configured worker accounts', { timeout: 180_000 }, async () => {
    await withRelay(async relayUrl => sinks(async (alerts, url) => {
      const setup = await deploy();
      const pending = await request(setup.coordinator, 'a4');
      await mineTo(BigInt(pending.record.requestBlock) + BigInt(pending.record.confirmations));
      const sender = workerConfig(setup, url, '0xc85ef7d79691fe79573b1a7064c19c1a9819ebdbd1faaab1a8ec92344438aaf4');
      sender.watchdog = undefined;
      sender.relayUrl = relayUrl;
      sender.nowSeconds = () => setup.pin.genesis + (pending.record.targetRound - 1n) * setup.pin.period;
      const submitted = await createWorker(sender).pollOnce();
      assert.equal(submitted[0]?.status, 'submitted');
      await receipt(submitted[0]!.transactionHash!);
      const observer = workerConfig(setup, url, `0x${'98'.repeat(32)}`);
      await createWorker(observer).pollOnce();
      found(alerts, 'foreign_fulfillment', 'page');
      alerts.length = 0;
      observer.watchdog!.allowedFulfillers = [owner.address, privateKeyToAccount(`0x${'99'.repeat(32)}`).address];
      await createWorker(observer).pollOnce();
      assert.equal(alerts.some(a => a.event === 'foreign_fulfillment'), false);
    }));
  });

  it('warns when drand remains unavailable thirty seconds after the frozen round', { timeout: 180_000 }, async () => {
    await sinks(async (alerts, url) => {
      const setup = await deploy();
      const pending = await request(setup.coordinator, 'a5');
      await mineTo(BigInt(pending.record.requestBlock) + BigInt(pending.record.confirmations));
      const key = `0x${'9a'.repeat(32)}` as Hex;
      await receipt(await wallet.sendTransaction({ to: privateKeyToAccount(key).address, value: 10n ** 18n, gas: 21_000n, gasPrice: 1n }));
      const relay = createServer((_req, res) => { res.statusCode = 503; res.end('unavailable'); });
      const relayUrl = await listen(relay);
      try {
        const config = workerConfig(setup, url, key);
        config.relayUrl = relayUrl;
        config.nowSeconds = () => setup.pin.genesis + (pending.record.targetRound - 1n) * setup.pin.period + 30n;
        const worker = createWorker(config);
        await worker.pollOnce();
        found(alerts, 'drand_stall', 'warn');
        await worker.pollOnce();
        assert.equal(alerts.filter(a => a.event === 'drand_stall').length, 1);
      } finally { await close(relay); }
    });
  });

  it('warns for a syncing node and an unreachable RPC, then rearms after recovery', { timeout: 180_000 }, async () => {
    await sinks(async (alerts, url) => {
      const setup = await deploy();
      let syncing = true;
      let broken = false;
      const proxy = createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += String(chunk);
        const request = JSON.parse(raw) as { id: number; method: string };
        if (broken) { res.statusCode = 503; res.end('node unavailable'); return; }
        res.setHeader('content-type', 'application/json');
        if (request.method === 'eth_syncing') { res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: syncing ? { startingBlock: '0x0', currentBlock: '0x1', highestBlock: '0x2' } : false })); return; }
        const upstream = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
        res.end(await upstream.text());
      });
      const proxyUrl = await listen(proxy);
      try {
        const config = workerConfig(setup, url, `0x${'9b'.repeat(32)}`);
        config.rpcUrl = proxyUrl;
        const worker = createWorker(config);
        await worker.pollOnce();
        found(alerts, 'node_unhealthy', 'warn');
        syncing = false;
        await worker.pollOnce();
        syncing = true;
        await worker.pollOnce();
        assert.equal(alerts.filter(a => a.event === 'node_unhealthy').length, 2);
        broken = true;
        await assert.rejects(worker.pollOnce());
        found(alerts, 'rpc_unhealthy', 'warn');
        broken = false;
        syncing = false;
        await worker.pollOnce();
      } finally { await close(proxy); }
    });
  });

  it('stops the healthchecks.io heartbeat when the node stops answering', { timeout: 180_000 }, async () => {
    await sinks(async (_alerts, url) => {
      const setup = await deploy();
      let broken = false;
      const proxy = createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += String(chunk);
        if (broken) { res.statusCode = 503; res.end('node unavailable'); return; }
        res.setHeader('content-type', 'application/json');
        const upstream = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
        res.end(await upstream.text());
      });
      const proxyUrl = await listen(proxy);
      const pings: string[] = [];
      const ping = createServer((req, res) => { pings.push(req.url ?? ''); res.end('ok'); });
      const pingUrl = await listen(ping);
      try {
        const config = workerConfig(setup, url, `0x${'9d'.repeat(32)}`);
        config.rpcUrl = proxyUrl;
        const worker = createWorker(config);
        const stop = new AbortController();
        let clock = 0;
        let rounds = 0;
        const running = runWorkerLoop({
          pollOnce: () => worker.pollOnce(),
          heartbeat: async () => { await fetch(`${pingUrl}/ping`); },
          signal: stop.signal,
          report: () => {},
          nowMilliseconds: () => clock,
          sleep: async () => { clock += 60_000; if (++rounds === 2) broken = true; if (rounds === 4) stop.abort(); },
        });
        await running;
        assert.deepEqual(pings, ['/ping', '/ping'], 'heartbeats follow healthy polls and stop once the node fails');
      } finally { await close(proxy); await close(ping); }
    });
  });

  it('publishes a missed Deadline proof in the phone page and JSON log, independently verifiable against a retired registered key', { timeout: 180_000 }, async () => {
    await withRelay(async relayUrl => sinks(async (alerts, url) => {
      const setup = await deploy();
      await receipt(await wallet.writeContract({ address: setup.coordinator, abi: parseAbi(['function setTimeoutBlocks(uint256 value)']), functionName: 'setTimeoutBlocks', args: [600n], gas: 200_000n, gasPrice: 1n }));
      const pending = await request(setup.coordinator, 'a6');
      const next = ProvingKey.fromHex(`0x${'9c'.repeat(32)}`);
      await receipt(await wallet.writeContract({ address: setup.coordinator, abi: coordinatorAbi, functionName: 'registerProvingKey', args: [next.publicKey, owner.address], gas: 500_000n, gasPrice: 1n }));
      await mineTo(BigInt(pending.record.requestBlock) + 2403n);
      const retired = await client.readContract({ address: setup.coordinator, abi: coordinatorAbi, functionName: 'getProvingKey', args: [pending.record.keyId] });
      assert.equal(retired[2], 4, 'original Draining Key is now Retired');
      const logs: string[] = [];
      const config = workerConfig(setup, url, `0x${'9d'.repeat(32)}`);
      config.relayUrl = relayUrl;
      config.nowSeconds = () => setup.pin.genesis + (pending.record.targetRound - 1n) * setup.pin.period;
      config.report = line => logs.push(line);
      let relayAvailable = false;
      config.fetch = async (input, init) => relayAvailable ? fetch(input, init) : new Response('offline', { status: 503 });
      const worker = createWorker(config);
      const nonceBefore = await client.getTransactionCount({ address: privateKeyToAccount(config.fulfillerPrivateKey).address });
      await worker.pollOnce();
      assert.equal(found(alerts, 'missed_deadline', 'page').proof, null, 'unavailable relay still pages immediately');
      relayAvailable = true;
      await worker.pollOnce();
      const page = alerts.find(a => a.event === 'missed_deadline' && a.proof);
      assert.ok(page, 'recovered relay adds the withheld proof to a fresh page');
      assert.equal(page.requestId, pending.requestId);
      assert.ok(page.proof, 'missed Deadline publishes withheld proof');
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 4096, 'full public proof fits in a phone notification');
      const publication = page.proof;
      assert.equal(publication.keyHash, setup.key.keyHash);
      assert.equal(publication.requestId, pending.requestId);
      const proofBytes = bytesToHex(encodeProof(decodeProof(publication.proof as Record<string, unknown>)));
      const registered = await client.readContract({ address: setup.coordinator, abi: coordinatorAbi, functionName: 'getProvingKey', args: [pending.record.keyId] });
      assert.equal(registered[0], setup.key.keyHash);
      const verify = async (proofBytes: Hex) => (await (await fetch(`${relayUrl}/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proofBytes, registeredKeyHash: registered[0], alpha: publication.alpha }) })).json()) as { valid: boolean; beta?: Hex };
      const verified = await verify(proofBytes);
      assert.equal(verified.valid, true, 'independent Go verifier accepts published proof');
      assert.equal(verified.beta, publication.beta);
      const sLastByte = 2 + 6 * 64 - 2;
      const corrupted = `${proofBytes.slice(0, sLastByte)}${proofBytes.slice(sLastByte, sLastByte + 2) === '00' ? '01' : '00'}${proofBytes.slice(sLastByte + 2)}` as Hex;
      assert.equal((await verify(corrupted)).valid, false, 'independent verifier rejects corrupted proof');
      const log = logs.map(line => JSON.parse(line) as Alert).find(a => a.event === 'missed_deadline' && a.proof);
      assert.ok(log);
      assert.deepEqual(log.proof, publication, 'structured log preserves all public verification material');
      assert.equal(JSON.stringify([logs, alerts]).includes(config.fulfillerPrivateKey.slice(2)), false);
      assert.equal(JSON.stringify([logs, alerts]).includes(fixture.vectors[0].vrf.secretKey.slice(2)), false);
      await worker.pollOnce();
      assert.equal(alerts.filter(a => a.event === 'missed_deadline').length, 2);
      assert.equal(await client.getTransactionCount({ address: privateKeyToAccount(config.fulfillerPrivateKey).address }), nonceBefore, 'expired proof is published without sending a transaction');
    }));
  });

  it('retries a failed phone delivery without repeating an acknowledged incident', { timeout: 180_000 }, async () => {
    const setup = await deploy();
    let failures = true;
    const received: Alert[] = [];
    const server = createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += String(chunk);
      const parsed = JSON.parse(raw);
      const alert = ('text' in parsed ? JSON.parse(parsed.text) : parsed) as Alert;
      if (alert.event === 'low_balance') { received.push(alert); res.statusCode = failures ? 503 : 200; }
      res.end('done');
    });
    const url = await listen(server);
    try {
      const config = workerConfig(setup, url, `0x${'9e'.repeat(32)}`);
      const worker = createWorker(config);
      await worker.pollOnce();
      assert.equal(received.length, 1);
      failures = false;
      await worker.pollOnce();
      assert.equal(received.length, 2, 'failed phone delivery retries next poll');
      await worker.pollOnce();
      assert.equal(received.length, 2, 'successful phone delivery is acknowledged');
    } finally { await close(server); }
  });

  it('publishes the missed Deadline proof even when a third party refunded before worker restart', { timeout: 180_000 }, async () => {
    await withRelay(async relayUrl => sinks(async (alerts, url) => {
      const setup = await deploy();
      await receipt(await wallet.writeContract({ address: setup.coordinator, abi: parseAbi(['function setTimeoutBlocks(uint256 value)']), functionName: 'setTimeoutBlocks', args: [600n], gas: 200_000n, gasPrice: 1n }));
      const pending = await request(setup.coordinator, 'a7');
      await mineTo(BigInt(pending.record.deadline) + 1n);
      await receipt(await wallet.writeContract({ address: setup.coordinator, abi: parseAbi(['function timeoutRefund(bytes32 requestId)']), functionName: 'timeoutRefund', args: [pending.requestId], gas: 300_000n, gasPrice: 1n }));
      const config = workerConfig(setup, url, `0x${'9f'.repeat(32)}`);
      config.relayUrl = relayUrl;
      let available = false;
      config.fetch = async (input, init) => available ? fetch(input, init) : new Response('offline', { status: 503 });
      const worker = createWorker(config);
      await mineTo(BigInt(pending.record.deadline) + 20n);
      await worker.pollOnce();
      assert.equal(found(alerts, 'missed_deadline', 'page').proof, null);
      available = true;
      await worker.pollOnce();
      assert.ok(alerts.some(alert => alert.event === 'missed_deadline' && alert.proof), 'deep refund retains incident until withheld proof can be published');
    }));
  });

  it('does not report a revocation refund as a missed Deadline', { timeout: 180_000 }, async () => {
    await sinks(async (alerts, url) => {
      const setup = await deploy();
      const pending = await request(setup.coordinator, 'a8');
      await receipt(await wallet.writeContract({ address: setup.coordinator, abi: parseAbi(['function revoke(bytes32 keyHash)']), functionName: 'revoke', args: [setup.key.keyHash], gas: 200_000n, gasPrice: 1n }));
      await receipt(await wallet.writeContract({ address: setup.coordinator, abi: coordinatorAbi, functionName: 'timeoutRefund', args: [pending.requestId], gas: 300_000n, gasPrice: 1n }));
      await createWorker(workerConfig(setup, url, `0x${'a0'.repeat(32)}`)).pollOnce();
      assert.equal(alerts.some(a => a.event === 'missed_deadline'), false);
    });
  });

});
