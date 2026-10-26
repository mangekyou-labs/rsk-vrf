import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, decodeFunctionData, defineChain, encodeAbiParameters, http, keccak256, stringToHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { artifact, coordinatorAbi, type OnChainProof, type Signature } from '../demo/lib.ts';
import { ProvingKey } from '../src/proving-key.ts';
import { createWorker } from '../src/worker.ts';

// Runs every demo script as a child process against real rskj regtest, with the
// coordinator deployed by contracts/script/deploy.sh and read from its record.
const rpcUrl = process.env.RSK_RPC_URL ?? 'http://127.0.0.1:4449';
const chain = defineChain({ id: 33, name: 'Rootstock regtest', nativeCurrency: { name: 'Test RBTC', symbol: 'tRBTC', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const client = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 50, cacheTime: 0 });
// Public rskj regtest genesis key, never a production credential. It funds the
// test accounts and signs for the Safe stand-in.
const signer = privateKeyToAccount('0xc85ef7d79691fe79573b1a7064c19c1a9819ebdbd1faaab1a8ec92344438aaf4');
const wallet = createWalletClient({ account: signer, chain, transport: http(rpcUrl) });
const deployerKey = `0x${'39'.repeat(32)}` as Hex;
const fulfillerKey = `0x${'3a'.repeat(32)}` as Hex;
const demoKey = `0x${'3b'.repeat(32)}` as Hex;
const deployer = privateKeyToAccount(deployerKey);
const deployerWallet = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });
const workerDir = fileURLToPath(new URL('../', import.meta.url));
const contractsDir = fileURLToPath(new URL('../../contracts/', import.meta.url));
const deploymentsDir = fileURLToPath(new URL('../../deployments/', import.meta.url));
const fixture = JSON.parse(readFileSync(new URL('../../tools/vrf-vectors-go/coordinator-vectors.json', import.meta.url), 'utf8'));
const relayPort = 18780;
const relayUrl = `http://127.0.0.1:${relayPort}`;
const beacon = { publicKey: fixture.drand.publicKey.map(BigInt) as [bigint, bigint, bigint, bigint], genesis: BigInt(fixture.drand.genesis), period: BigInt(fixture.drand.period) };

async function mine() { await client.request({ method: 'evm_mine' as never, params: [] as never }); }
async function receipt(hash: Hex) { await mine(); const found = await client.waitForTransactionReceipt({ hash }); assert.equal(found.status, 'success'); return found; }

/** rskj regtest only mines on request, so forge would wait forever for its receipts. */
async function withMiner<T>(body: () => Promise<T>): Promise<T> {
  let mining = true;
  const loop = (async () => { while (mining) { await mine(); await new Promise(resolve => setTimeout(resolve, 100)); } })();
  try { return await body(); } finally { mining = false; await loop; }
}

function run(command: string, args: string[], cwd: string, env: Record<string, string> = {}): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
}

let record = '';
let dir = '';
let relay: ChildProcess | undefined;
let coordinator: Address;
let safe: Address;
let stopWorker = () => Promise.resolve();
let revertingRequestId: Hex | undefined;

/** Runs a demo script the way a reader would, with only the documented environment. */
async function demo(script: string, env: Record<string, string> = {}) {
  const result = await run(process.execPath, [`demo/${script}.ts`], workerDir, {
    RPC_URL: rpcUrl, DEPLOYMENT_FILE: record, DEMO_PRIVATE_KEY: demoKey, DRAND_RELAY_URL: relayUrl, ...env,
  });
  const line = result.output.split('\n').find(text => text.startsWith('RESULT '));
  return { ...result, result: line ? JSON.parse(line.slice('RESULT '.length)) : undefined };
}

function assertPresented(output: string, transactions: Hex[]) {
  assert.match(output, /Unaudited testnet pilot; do not use for value\./, 'prints the pilot banner');
  for (const hash of transactions) assert.ok(output.includes(hash), `prints a link for ${hash}`);
}

describe('demo scripts on real rskj', { concurrency: 1 }, () => {
  before(async () => {
    assert.equal(await client.getChainId(), 33, 'must use real rskj regtest');
    for (const to of [deployer.address, privateKeyToAccount(fulfillerKey).address, privateKeyToAccount(demoKey).address]) {
      await receipt(await wallet.sendTransaction({ to, value: 10n ** 19n, gas: 21_000n, gasPrice: 1n }));
    }
    const standIn = artifact('SafeStandIn');
    safe = (await receipt(await wallet.deployContract({ abi: standIn.abi, bytecode: standIn.bytecode, args: [signer.address], gas: 1_000_000n, gasPrice: 1n }))).contractAddress!;
    const key = ProvingKey.fromHex(fixture.vectors[0].vrf.secretKey);
    const [x, y] = key.publicKey;
    mkdirSync(deploymentsDir, { recursive: true });
    dir = mkdtempSync(join(deploymentsDir, 'demo-'));
    record = join(dir, '33.json');
    const deployed = await withMiner(() => run('script/deploy.sh', [safe, String(x), String(y), '--private-key', deployerKey], contractsDir, { RPC_URL: rpcUrl, DEPLOYMENT_FILE: record }));
    assert.equal(deployed.code, 0, deployed.output);
    coordinator = JSON.parse(readFileSync(record, 'utf8')).contracts.proxy.address;
    // Regtest cannot reach the evmnet beacon, so the deployer (still the owner) adds the
    // offline test beacon; new requests bind the latest drand config.
    await receipt(await deployerWallet.writeContract({ address: coordinator, abi: coordinatorAbi, functionName: 'addDrandConfig', args: [beacon], gas: 300_000n, gasPrice: 1n }));

    relay = spawn(process.env.TEST_RELAY_BIN ?? '/tmp/rsk-vrf-test-relay', ['-test-relay', `127.0.0.1:${relayPort}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    let relayError = ''; relay.stderr!.on('data', chunk => { relayError += String(chunk); });
    let ready = false;
    for (let n = 0; n < 100 && !ready; n++) {
      try { ready = (await fetch(`${relayUrl}/public/1`)).ok; } catch { /* startup only */ }
      if (relay.exitCode !== null) throw new Error(`Test relay exited: ${relayError}`);
      if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, 'test relay is up');

    // The operator's worker. It never mines: on chain 33 the demo scripts mine for themselves.
    // Its clock runs ahead so the test beacon's rounds count as published.
    const worker = createWorker({
      rpcUrl, coordinator, chain, fulfillerPrivateKey: fulfillerKey, loadProvingKey: async () => key, relayUrl, drandPin: beacon,
      nowSeconds: () => BigInt(Math.floor(Date.now() / 1000)) + 3_600n,
    });
    let polling = true;
    const loop = (async () => {
      while (polling) {
        try { await worker.pollOnce(); } catch { /* a transient poll failure retries */ }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    })();
    stopWorker = async () => { polling = false; await loop; };
  });

  after(async () => {
    await stopWorker();
    if (relay && relay.exitCode === null) { relay.kill('SIGTERM'); await once(relay, 'exit'); }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('dice: the callback stores Beta and the face comes from deriveRandomInRange(1, 6)', { timeout: 120_000 }, async () => {
    const { code, output, result } = await demo('dice');
    assert.equal(code, 0, output);
    const dice = artifact('DemoDice');
    const requestId = result.requestId as Hex;
    const stored = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [requestId] }) as { status: number; beta: Hex; requester: Address };
    assert.equal(stored.status, 2, 'Fulfilled');
    assert.equal(stored.requester.toLowerCase(), (result.dice as string).toLowerCase());
    assert.equal(await client.readContract({ address: result.dice, abi: dice.abi, functionName: 'betaOf', args: [requestId] }), stored.beta, 'the callback stored the verified Beta');
    const face = await client.readContract({ address: result.dice, abi: dice.abi, functionName: 'face', args: [requestId] }) as bigint;
    assert.ok(face >= 1n && face <= 6n);
    assert.equal(BigInt(result.face), face);
    const fulfilled = await client.getTransactionReceipt({ hash: result.fulfillTx });
    assert.ok(fulfilled.logs.some(log => log.address.toLowerCase() === (result.dice as string).toLowerCase()), 'Rolled was emitted inside the fulfill transaction');
    assertPresented(output, [result.deployTx, result.requestTx, result.fulfillTx]);
  });

  it('read path: an EOA request is read through the derive views, which refuse it while Pending', { timeout: 120_000 }, async () => {
    const { code, output, result } = await demo('read-path');
    assert.equal(code, 0, output);
    const requestId = result.requestId as Hex;
    const stored = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [requestId] }) as { status: number; beta: Hex; requester: Address; callbackGasCap: number };
    assert.equal(stored.status, 2);
    assert.equal(stored.requester, privateKeyToAccount(demoKey).address, 'the EOA itself is the requester');
    assert.equal(stored.callbackGasCap, 0, 'no callback for an EOA');
    assert.equal(result.pendingRevert, 'RequestPending', 'the derive views refused the Pending request');
    // Literal derivation, independent of the script: keccak(abi.encode(keccak("rsk-vrf/v1/derive"), ctx, beta)).
    const context = result.context as Hex;
    const bytes = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }], [keccak256(stringToHex('rsk-vrf/v1/derive')), context, stored.beta]));
    assert.equal(result.randomBytes, bytes);
    assert.equal(BigInt(result.random), BigInt(bytes));
    assert.equal(BigInt(result.inRange), await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'deriveRandomInRange', args: [requestId, context, 1n, 100n] }));
    assert.ok(BigInt(result.inRange) >= 1n && BigInt(result.inRange) <= 100n);
    assertPresented(output, [result.requestTx, result.fulfillTx]);
  });

  it('reverting consumer: the callback fails with CallbackFailed, the fee is credited to the Payee and the Payee withdraws it', { timeout: 120_000 }, async () => {
    const before = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'payeeBalance', args: [safe] }) as bigint;
    const reverting = await demo('reverting-consumer');
    assert.equal(reverting.code, 0, reverting.output);
    const { requestId, fulfillTx } = reverting.result as { requestId: Hex; fulfillTx: Hex };
    revertingRequestId = requestId;
    const stored = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [requestId] }) as { status: number; fee: bigint };
    assert.equal(stored.status, 2, 'Fulfilled although the callback reverted');
    const callbackFailed = keccak256(stringToHex('CallbackFailed(bytes32)'));
    const logs = (await client.getTransactionReceipt({ hash: fulfillTx })).logs;
    assert.ok(logs.some(log => log.address.toLowerCase() === coordinator.toLowerCase() && log.topics[0] === callbackFailed && log.topics[1] === requestId), 'CallbackFailed(requestId)');
    const credited = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'payeeBalance', args: [safe] }) as bigint;
    assert.ok(credited >= before + stored.fee, 'the fee was credited to the Payee');
    assertPresented(reverting.output, [reverting.result.deployTx, reverting.result.requestTx, fulfillTx]);

    // The Payee is the Admin Safe here; the script cannot sign for it, so it prints the call.
    const instructions = await demo('withdraw-fees', { REQUEST_ID: requestId });
    assert.equal(instructions.code, 3, instructions.output);
    assert.ok(instructions.output.toLowerCase().includes(safe.toLowerCase()), 'names the Payee');
    assert.ok(instructions.output.includes('0x476343ee'), 'gives the withdrawFees() calldata');

    const withdrawFees = '0x476343ee';
    const safeBalance = await client.getBalance({ address: safe });
    const withdrawn = await receipt(await wallet.writeContract({ address: safe, abi: artifact('SafeStandIn').abi, functionName: 'execute', args: [coordinator, withdrawFees], gas: 200_000n, gasPrice: 1n }));
    assert.equal(await client.getBalance({ address: safe }), safeBalance + credited);

    const verified = await demo('withdraw-fees', { REQUEST_ID: requestId, WITHDRAW_TX: withdrawn.transactionHash });
    assert.equal(verified.code, 0, verified.output);
    assert.equal(BigInt(verified.result.amount), credited);
    assert.equal(verified.result.payee.toLowerCase(), safe.toLowerCase());
    assertPresented(verified.output, [withdrawn.transactionHash]);
  });

  it('recompute Beta: the on-chain proof and published inputs give the stored Beta, and the noble and Go provers agree', { timeout: 120_000 }, async () => {
    const { code, output, result } = await demo('recompute-beta', { GO_VRF_URL: relayUrl });
    assert.equal(code, 0, output);
    const requestId = result.requestId as Hex;
    const stored = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [requestId] }) as { status: number; beta: Hex; requester: Address; targetRound: bigint };
    assert.equal(stored.status, 2);
    assert.equal(result.beta, stored.beta, 'the recomputed Beta is the stored one');
    // The Go helper proves the same request on its own; its Beta must be the chain's.
    const query = new URLSearchParams({ chainId: '33', round: String(stored.targetRound), coordinator, requester: stored.requester, requestId, context: `0x${'00'.repeat(32)}` });
    const expected = await (await fetch(`${relayUrl}/expected?${query}`)).json() as { beta: Hex; alpha: Hex };
    assert.equal(expected.beta, stored.beta, 'the Go prover derives the same Beta');
    assert.equal(result.alpha, expected.alpha);
    assert.equal(result.proofVerified, true, 'the demo\'s own ECVRF verifier accepts the on-chain proof over the recomputed Alpha');
    assert.equal(result.goVerified, true, 'the Go verifier accepts the on-chain proof');
    assert.equal(result.proversMatch, true, 'the Go proof bytes equal the noble proof on chain');
    assertPresented(output, [result.fulfillTx]);
  });

  it('rejections: invalid, mismatched and repeated fulfillments are mined and reverted, each for its one reason', { timeout: 180_000 }, async () => {
    const { code, output, result } = await demo('rejections');
    assert.equal(code, 0, output);
    assert.equal(result.isolated, true, 'regtest has the public test key, so every case on B is isolated');
    const rejections = result.rejections as { case: string; tx: Hex; expected: string; error: string }[];
    assert.deepEqual(rejections.map(r => r.case), ['corrupted gamma', 'corrupted s', "A's proof on B", 'wrong drand round', 'repeat on Fulfilled A']);
    for (const r of rejections) assert.equal(r.error, r.expected, `${r.case} reverted with the script's expected error`);

    // Isolation, checked against the operator's own fulfillment of B: each case on B is
    // that valid fulfillment with exactly one thing changed.
    const decode = async (hash: Hex) => decodeFunctionData({ abi: coordinatorAbi, data: (await client.getTransaction({ hash })).input }).args as unknown as [Hex, OnChainProof, Signature];
    const [idB, proofB, signatureB] = await decode(result.fulfillTxB);
    const [, proofA] = await decode(result.fulfillTxA);
    const sent = Object.fromEntries(await Promise.all(rejections.map(async r => [r.case, await decode(r.tx)] as const)));
    assert.deepEqual(sent['corrupted gamma'], [idB, { ...proofB, gamma: [proofB.gamma[0] + 1n, proofB.gamma[1]] }, signatureB]);
    assert.deepEqual(sent['corrupted s'], [idB, { ...proofB, s: proofB.s + 1n }, signatureB]);
    assert.deepEqual(sent["A's proof on B"], [idB, proofA, signatureB]);
    const [wrongId, wrongProof, wrongSignature] = sent['wrong drand round']!;
    assert.deepEqual([wrongId, wrongProof], [idB, proofB], 'the wrong round carries B\'s valid proof');
    assert.notDeepEqual(wrongSignature, signatureB);

    const fulfilledB = await client.getTransactionReceipt({ hash: result.fulfillTxB });
    for (const rejection of rejections) {
      const mined = await client.getTransactionReceipt({ hash: rejection.tx });
      assert.equal(mined.status, 'reverted', `${rejection.case} was mined and reverted`);
      assert.ok(mined.blockNumber < fulfilledB.blockNumber, `${rejection.case} landed while B was still Pending`);
      const tx = await client.getTransaction({ hash: rejection.tx });
      assert.equal(tx.to?.toLowerCase(), coordinator.toLowerCase());
    }
    for (const id of [result.requestIdA, result.requestIdB] as Hex[]) {
      const stored = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [id] }) as { status: number };
      assert.equal(stored.status, 2, 'the rejections changed nothing: both requests end Fulfilled by the operator');
    }
    assertPresented(output, rejections.map(r => r.tx));
  });

  // Last: it registers a new Active key, which the worker does not hold.
  it('withdraw fees: names the Payee of the key that served the request, not the Active key\'s', { timeout: 60_000 }, async () => {
    assert.ok(revertingRequestId, 'the reverting consumer test ran first');
    const otherKey = privateKeyToAccount(`0x${'3c'.repeat(32)}`).publicKey;
    const otherPayee = '0x000000000000000000000000000000000000dEaD';
    const pk = [BigInt(`0x${otherKey.slice(4, 68)}`), BigInt(`0x${otherKey.slice(68)}`)] as const;
    await receipt(await deployerWallet.writeContract({ address: coordinator, abi: coordinatorAbi, functionName: 'registerProvingKey', args: [pk, otherPayee], gas: 300_000n, gasPrice: 1n }));
    const instructions = await demo('withdraw-fees', { REQUEST_ID: revertingRequestId });
    assert.equal(instructions.code, 3, instructions.output);
    assert.ok(instructions.output.toLowerCase().includes(safe.toLowerCase()), 'names the Safe, the Payee of the key that served the request');
    assert.ok(!instructions.output.toLowerCase().includes(otherPayee.toLowerCase()), 'not the new Active key\'s Payee');
  });
});

