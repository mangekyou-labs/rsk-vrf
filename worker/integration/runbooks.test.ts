import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, encodeFunctionData, http, keccak256, parseAbi, parseEventLogs, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { coordinatorAbi } from '../src/coordinator.ts';
import { ProvingKey } from '../src/proving-key.ts';
import { createWorker, REFUND_REASON, type DrandPin } from '../src/worker.ts';

// The operator tools the runbooks in docs/runbooks/ call, run on real rskj regtest.
const rpcUrl = process.env.RSK_RPC_URL ?? 'http://127.0.0.1:4449';
const chain = defineChain({ id: 33, name: 'Rootstock regtest', nativeCurrency: { name: 'Test RBTC', symbol: 'tRBTC', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const client = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 50, cacheTime: 0 });
// Public rskj regtest genesis key, never a production credential. It funds the deployer and signs for the Safe stand-in.
const signer = privateKeyToAccount('0xc85ef7d79691fe79573b1a7064c19c1a9819ebdbd1faaab1a8ec92344438aaf4');
const deployerKey = `0x${'57'.repeat(32)}` as Hex;
const deployer = privateKeyToAccount(deployerKey);
const wallet = createWalletClient({ account: signer, chain, transport: http(rpcUrl) });
const contractsDir = fileURLToPath(new URL('../../contracts/', import.meta.url));
const workerDir = fileURLToPath(new URL('../', import.meta.url));
const deploymentsDir = fileURLToPath(new URL('../../deployments/', import.meta.url));
const fixture = JSON.parse(readFileSync(new URL('../../tools/vrf-vectors-go/coordinator-vectors.json', import.meta.url), 'utf8'));
const artifact = (name: string) => JSON.parse(readFileSync(new URL(`../../contracts/out/${name}.sol/${name}.json`, import.meta.url), 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
const ownableAbi = parseAbi(['function acceptOwnership()']);
const KeyState = { Active: 1, Draining: 2, Revoked: 3, Retired: 4 } as const;

async function mine() { await client.request({ method: 'evm_mine' as never, params: [] as never }); }
async function mineTo(target: bigint) { while (await client.getBlockNumber({ cacheTime: 0 }) < target) await mine(); }
async function receipt(hash: Hex) { await mine(); const found = await client.waitForTransactionReceipt({ hash }); assert.equal(found.status, 'success'); return found; }

async function withMiner<T>(body: () => Promise<T>): Promise<T> {
  let mining = true;
  const loop = (async () => { while (mining) { await mine(); await new Promise(resolve => setTimeout(resolve, 100)); } })();
  try { return await body(); } finally { mining = false; await loop; }
}

function run(command: string, args: string[], cwd: string, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let output = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, output }));
  });
}

const safeTx = (record: string, ...args: string[]) => run('script/safe-tx.sh', [record, ...args], contractsDir, { RPC_URL: rpcUrl });
const pending = (record: string, keyHash: Hex) => run('script/pending-requests.sh', [record, keyHash], contractsDir, { RPC_URL: rpcUrl });

/** The to, value and data lines safe-tx.sh prints for the Safe signers. */
function proposal(stdout: string): { to: Address; value: string; data: Hex } {
  const field = (name: string) => stdout.match(new RegExp(`^${name}:\\s+(\\S+)`, 'm'))?.[1];
  const to = field('to'); const value = field('value'); const data = field('data');
  assert.ok(to && value && data, `a full proposal in:\n${stdout}`);
  return { to: to as Address, value, data: data as Hex };
}

async function execute(safe: Address, tx: { to: Address; value: string; data: Hex }) {
  assert.equal(tx.value, '0');
  const standIn = artifact('SafeStandIn');
  return receipt(await wallet.writeContract({ address: safe, abi: standIn.abi, functionName: 'execute', args: [tx.to, tx.data], gas: 600_000n, gasPrice: 1n }));
}

async function keyState(coordinator: Address, keyId: number) {
  return (await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getProvingKey', args: [keyId] }))[2];
}

async function request(coordinator: Address, tag: string) {
  const fee = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'fee' });
  const made = await receipt(await wallet.writeContract({ address: coordinator, abi: coordinatorAbi, functionName: 'request', args: [`0x${tag.repeat(32)}`], value: fee, gas: 500_000n, gasPrice: 1n }));
  const event = parseEventLogs({ abi: coordinatorAbi, eventName: 'RandomnessRequested', logs: made.logs })[0]!;
  return { requestId: event.args.requestId, record: await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [event.args.requestId] }) };
}

async function withRelay(port: number, body: (relayUrl: string) => Promise<void>) {
  const relay = spawn(process.env.TEST_RELAY_BIN ?? '/tmp/rsk-vrf-test-relay', ['-test-relay', `127.0.0.1:${port}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  const relayUrl = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let n = 0; n < 100 && !ready; n++) {
      try { ready = (await fetch(`${relayUrl}/public/1`)).ok; } catch { await new Promise(resolve => setTimeout(resolve, 25)); }
    }
    assert.ok(ready, 'offline drand signer starts');
    await body(relayUrl);
  } finally { relay.kill('SIGTERM'); if (relay.exitCode === null) await once(relay, 'exit'); }
}

describe('runbook tools on real rskj', { concurrency: 1 }, () => {
  it('rotation, then revocation with a pending request and timeoutRefund, through safe-tx.sh and pending-requests.sh', { timeout: 300_000 }, async () => {
    assert.equal(await client.getChainId(), 33, 'must use real rskj regtest');
    await receipt(await wallet.sendTransaction({ to: deployer.address, value: 10n ** 19n, gas: 21_000n, gasPrice: 1n }));
    const standIn = artifact('SafeStandIn');
    const safeReceipt = await receipt(await wallet.deployContract({ abi: standIn.abi, bytecode: standIn.bytecode.object, args: [signer.address], gas: 1_000_000n, gasPrice: 1n }));
    const safe = safeReceipt.contractAddress!;
    const oldKey = ProvingKey.fromHex(fixture.vectors[0].vrf.secretKey);
    const newKey = ProvingKey.fromHex(`0x${'7a'.repeat(32)}`);

    mkdirSync(deploymentsDir, { recursive: true });
    const dir = mkdtempSync(join(deploymentsDir, 'test-'));
    const record = join(dir, '33.json');
    try {
      const deployed = await withMiner(() => run('script/deploy.sh', [safe, String(oldKey.publicKey[0]), String(oldKey.publicKey[1]), '--private-key', deployerKey], contractsDir, { RPC_URL: rpcUrl, DEPLOYMENT_FILE: record }));
      assert.equal(deployed.code, 0, deployed.output);
      const coordinator = JSON.parse(readFileSync(record, 'utf8')).contracts.proxy.address as Address;

      const early = await safeTx(record, 'revoke', oldKey.keyHash);
      assert.notEqual(early.code, 0, 'a proposal the Safe cannot yet execute is refused');
      assert.match(early.output, /reverts/);
      assert.equal(early.stdout, '', 'a refused proposal prints no transaction to sign');
      // The hand-off of docs/development/deploy.md, section 4.
      const accept = await safeTx(record, 'accept-ownership');
      assert.equal(accept.code, 0, accept.output);
      const acceptTx = proposal(accept.stdout);
      assert.deepEqual(acceptTx, { to: coordinator, value: '0', data: encodeFunctionData({ abi: ownableAbi, functionName: 'acceptOwnership' }) });
      await execute(safe, acceptTx);
      const acceptedAgain = await safeTx(record, 'accept-ownership');
      assert.notEqual(acceptedAgain.code, 0, 'a hand-off the Safe already accepted is refused before signing');
      assert.equal(acceptedAgain.stdout, '');

      const onOld = await request(coordinator, 'b1');
      const listed = await pending(record, oldKey.keyHash);
      assert.equal(listed.code, 0, listed.output);
      assert.deepEqual(listed.stdout.trim().split('\n').map(line => line.split(/\s+/)[0]), [onOld.requestId], 'the pending request of the key, one per line');
      assert.match(listed.stdout, new RegExp(`deadline ${onOld.record.deadline}`));

      // Rotation: register and activate the new key, Payee the Admin Safe.
      const register = await safeTx(record, 'register', String(newKey.publicKey[0]), String(newKey.publicKey[1]));
      assert.equal(register.code, 0, register.output);
      assert.match(register.output, new RegExp(`keyHash ${newKey.keyHash}`), 'signers compare the keyHash with the keygen output');
      const registerTx = proposal(register.stdout);
      assert.equal(registerTx.to, coordinator);
      const registered = await execute(safe, registerTx);
      const [event] = parseEventLogs({ abi: coordinatorAbi, eventName: 'KeyRegistered', logs: registered.logs });
      assert.equal(event!.args.keyHash, newKey.keyHash);
      assert.equal(event!.args.payee.toLowerCase(), safe.toLowerCase(), 'the Payee is the Admin Safe');
      assert.equal(await keyState(coordinator, onOld.record.keyId), KeyState.Draining);
      assert.equal(await keyState(coordinator, event!.args.keyId), KeyState.Active);
      assert.equal(await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'activeKeyId' }), event!.args.keyId);
      const again = await safeTx(record, 'register', String(newKey.publicKey[0]), String(newKey.publicKey[1]));
      assert.notEqual(again.code, 0, 'a second registration of the same key is refused before signing');

      // Compromise of the Draining key: revoke, list, refund at once.
      const revoke = await safeTx(record, 'revoke', oldKey.keyHash);
      assert.equal(revoke.code, 0, revoke.output);
      await execute(safe, proposal(revoke.stdout));
      assert.equal(await keyState(coordinator, onOld.record.keyId), KeyState.Revoked);
      const stillPending = await pending(record, oldKey.keyHash);
      assert.equal(stillPending.stdout.trim().split(/\s+/)[0], onOld.requestId, 'a request of a Revoked Key stays Pending until someone refunds it');
      const refund = await receipt(await wallet.writeContract({ address: coordinator, abi: coordinatorAbi, functionName: 'timeoutRefund', args: [onOld.requestId], gas: 200_000n, gasPrice: 1n }));
      const [refunded] = parseEventLogs({ abi: coordinatorAbi, eventName: 'Refunded', logs: refund.logs });
      assert.equal(refunded!.args.reason, REFUND_REASON.KEY_REVOKED, 'refunded before its Deadline as a Revocation Refund');
      const after = await pending(record, oldKey.keyHash);
      assert.equal(after.code, 0, after.output);
      assert.equal(after.stdout.trim(), '', 'nothing is left pending');

      const unknown = await pending(record, `0x${'00'.repeat(32)}`);
      assert.notEqual(unknown.code, 0, 'a keyHash that was never registered is an error, not an empty list');

      const withdraw = await safeTx(record, 'withdraw-fees');
      assert.notEqual(withdraw.code, 0, 'a withdrawal of a zero balance is refused, as it does nothing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('missed-deadlines counts the requests not fulfilled by their Deadline in a block range, less an announced window', { timeout: 300_000 }, async () => {
    await withRelay(18798, async relayUrl => {
      const implementation = artifact('VRFCoordinator');
      const impl = await receipt(await wallet.deployContract({ abi: implementation.abi, bytecode: implementation.bytecode.object, gas: 6_500_000n, gasPrice: 1n }));
      const pin: DrandPin = { publicKey: fixture.drand.publicKey.map(BigInt), genesis: BigInt(fixture.drand.genesis), period: BigInt(fixture.drand.period) };
      const proxy = artifact('ERC1967Proxy');
      const init = encodeFunctionData({ abi: implementation.abi, functionName: 'initialize', args: [signer.address, pin] });
      const created = await receipt(await wallet.deployContract({ abi: proxy.abi, bytecode: proxy.bytecode.object, args: [impl.contractAddress!, init], gas: 2_000_000n, gasPrice: 1n }));
      const coordinator = created.contractAddress!;
      const key = ProvingKey.fromHex(fixture.vectors[0].vrf.secretKey);
      await receipt(await wallet.writeContract({ address: coordinator, abi: coordinatorAbi, functionName: 'registerProvingKey', args: [key.publicKey, signer.address], gas: 500_000n, gasPrice: 1n }));
      const fulfiller = privateKeyToAccount(`0x${'7d'.repeat(32)}`);
      await receipt(await wallet.sendTransaction({ to: fulfiller.address, value: 10n ** 18n, gas: 21_000n, gasPrice: 1n }));

      // Each request is mined in its own block, so each has its own Deadline.
      const fulfilled = await request(coordinator, 'c1');
      const stillPending = await request(coordinator, 'c2');
      const refunded = await request(coordinator, 'c3');
      const late = await request(coordinator, 'c4');
      await mineTo(BigInt(fulfilled.record.requestBlock + fulfilled.record.confirmations));
      const worker = createWorker({
        rpcUrl, coordinator, chain, fulfiller, drandPin: pin, relayUrl,
        loadProvingKey: async hash => hash.toLowerCase() === key.keyHash ? key : undefined,
        nowSeconds: () => pin.genesis + (fulfilled.record.targetRound + 1n) * pin.period, report: () => {},
      });
      const sent = (await worker.pollOnce()).find(entry => entry.requestId === fulfilled.requestId);
      assert.equal(sent?.status, 'submitted');
      await receipt(sent!.transactionHash!);
      await mineTo(BigInt(refunded.record.deadline) + 1n);
      const refund = await receipt(await wallet.writeContract({ address: coordinator, abi: coordinatorAbi, functionName: 'timeoutRefund', args: [refunded.requestId], gas: 200_000n, gasPrice: 1n }));
      assert.equal(parseEventLogs({ abi: coordinatorAbi, eventName: 'Refunded', logs: refund.logs })[0]!.args.reason, REFUND_REASON.DEADLINE);
      await mineTo(BigInt(late.record.deadline) + 1n);

      mkdirSync(deploymentsDir, { recursive: true });
      const dir = mkdtempSync(join(deploymentsDir, 'test-'));
      const record = join(dir, '33.json');
      writeFileSync(record, JSON.stringify({ chainId: 33, safe: signer.address, contracts: { proxy: { address: coordinator, block: Number(created.blockNumber) } } }));
      try {
        const count = async (...args: string[]) => {
          const result = await run('node', ['demo/missed-deadlines.ts', record, ...args], workerDir, { RPC_URL: rpcUrl });
          assert.equal(result.code, 0, result.output);
          const line = result.stdout.split('\n').find(text => text.startsWith('RESULT '));
          assert.ok(line, result.output);
          return { output: result.stdout, result: JSON.parse(line.slice('RESULT '.length)) as { count: number; missed: { requestId: Hex; deadline: number; outcome: string }[] } };
        };
        // The range ends before the last request's Deadline, so that request is out of it.
        const all = await count(String(fulfilled.record.deadline), String(refunded.record.deadline));
        assert.equal(all.result.count, 2, all.output);
        assert.deepEqual(all.result.missed, [
          { requestId: stillPending.requestId, deadline: stillPending.record.deadline, outcome: 'Pending' },
          { requestId: refunded.requestId, deadline: refunded.record.deadline, outcome: 'Refunded' },
        ], 'a fulfilled request is not a miss; one still Pending past its Deadline and one refunded are');
        assert.match(all.output, /^2 missed Deadline/m, 'prints the count');
        assert.ok(all.output.includes(`${stillPending.requestId} deadline ${stillPending.record.deadline} Pending`), 'prints each miss with its Deadline and outcome');

        const window = `${refunded.record.deadline}-${late.record.deadline}`;
        const outside = await count(String(fulfilled.record.deadline), String(late.record.deadline), '--exclude', window);
        assert.deepEqual(outside.result.missed.map(miss => miss.requestId), [stillPending.requestId], 'a miss whose Deadline is in the excluded window is dropped');
        assert.equal(outside.result.count, 1);

        const bad = await run('node', ['demo/missed-deadlines.ts', record, '10', '5'], workerDir, { RPC_URL: rpcUrl });
        assert.notEqual(bad.code, 0, 'a range that ends before it starts is an error');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('check-withheld-proof accepts the proof a missed Deadline page publishes and rejects a changed one', { timeout: 300_000 }, async () => {
    await withRelay(18797, async relayUrl => {
      // Owner is the genesis EOA here; the coordinator uses the test drand chain of the relay.
      const implementation = artifact('VRFCoordinator');
      const impl = await receipt(await wallet.deployContract({ abi: implementation.abi, bytecode: implementation.bytecode.object, gas: 6_500_000n, gasPrice: 1n }));
      const pin: DrandPin = { publicKey: fixture.drand.publicKey.map(BigInt), genesis: BigInt(fixture.drand.genesis), period: BigInt(fixture.drand.period) };
      const proxy = artifact('ERC1967Proxy');
      const init = encodeFunctionData({ abi: implementation.abi, functionName: 'initialize', args: [signer.address, pin] });
      const coordinator = (await receipt(await wallet.deployContract({ abi: proxy.abi, bytecode: proxy.bytecode.object, args: [impl.contractAddress!, init], gas: 2_000_000n, gasPrice: 1n }))).contractAddress!;
      const key = ProvingKey.fromHex(fixture.vectors[0].vrf.secretKey);
      await receipt(await wallet.writeContract({ address: coordinator, abi: coordinatorAbi, functionName: 'registerProvingKey', args: [key.publicKey, signer.address], gas: 500_000n, gasPrice: 1n }));
      const missed = await request(coordinator, 'b2');
      await mineTo(BigInt(missed.record.deadline) + 1n);

      const pages: Record<string, unknown>[] = [];
      const sink = createServer(async (req, res) => { let raw = ''; for await (const chunk of req) raw += String(chunk); pages.push(JSON.parse(raw)); res.end('ok'); });
      sink.listen(0, '127.0.0.1'); await once(sink, 'listening');
      const address = sink.address(); assert.ok(address && typeof address !== 'string');
      try {
        const worker = createWorker({
          rpcUrl, coordinator, chain, fulfiller: privateKeyToAccount(`0x${'7b'.repeat(32)}`), drandPin: pin, relayUrl,
          loadProvingKey: async hash => hash.toLowerCase() === key.keyHash ? key : undefined,
          nowSeconds: () => pin.genesis + (missed.record.targetRound + 1n) * pin.period,
          watchdog: { workerId: 'primary', pageUrl: `http://127.0.0.1:${address.port}/page`, warningUrl: `http://127.0.0.1:${address.port}/warn` },
          report: () => {},
        });
        await worker.pollOnce();
      } finally { await new Promise<void>(resolve => sink.close(() => resolve())); }
      const page = pages.map(p => ('text' in p ? JSON.parse(String(p.text)) : p) as { event: string; proof?: Record<string, unknown> }).find(p => p.event === 'missed_deadline' && p.proof);
      assert.ok(page, 'the worker pages a missed Deadline with its withheld proof');

      const dir = mkdtempSync(join(deploymentsDir, 'test-'));
      try {
        const check = (body: unknown) => {
          const file = join(dir, 'page.json');
          writeFileSync(file, JSON.stringify(body));
          return run('node', ['demo/check-withheld-proof.ts', file], workerDir, { RPC_URL: rpcUrl, DRAND_RELAY_URL: relayUrl });
        };
        const whole = await check(page);
        assert.equal(whole.code, 0, whole.output);
        assert.match(whole.output, new RegExp(`keyHash ${key.keyHash}`));
        assert.match(whole.output, /RESULT .*"valid":true/);
        const proofOnly = await check(page.proof);
        assert.equal(proofOnly.code, 0, 'the proof object alone, as the log line holds it, also checks');

        const proof = page.proof as { proof: Record<string, unknown>; beta: Hex; requester: Address };
        const changedS = { ...proof, proof: { ...proof.proof, s: String(BigInt(String(proof.proof.s)) + 1n) } };
        assert.notEqual((await check(changedS)).code, 0, 'a changed proof fails');
        const changedBeta = { ...proof, beta: keccak256(encodeAbiParameters([{ type: 'uint256' }], [1n])) };
        assert.notEqual((await check(changedBeta)).code, 0, 'a changed Beta fails');
        const otherKey = ProvingKey.fromHex(`0x${'7c'.repeat(32)}`);
        const changedKey = { ...proof, proof: { ...proof.proof, pk: otherKey.publicKey.map(String) } };
        const wrongKey = await check(changedKey);
        assert.notEqual(wrongKey.code, 0);
        assert.match(wrongKey.output, /registered/, 'a proof under a key the request did not name fails');
        const changedRequester = { ...proof, requester: signer.address === proof.requester ? deployer.address : signer.address };
        assert.notEqual((await check(changedRequester)).code, 0, 'inputs that differ from the on-chain request fail');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
