import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { it } from 'node:test';
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, parseAbi, parseEventLogs, type Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { coordinatorAbi as workerAbi } from '../src/coordinator.ts';
import { createWorker } from '../src/worker.ts';
import { ProvingKey } from '../src/proving-key.ts';

// The worker never revokes; only the tests act as the Admin here.
const coordinatorAbi = [...workerAbi, ...parseAbi(['function revoke(bytes32 keyHash)'])];
const rpcUrl = process.env.RSK_RPC_URL ?? 'http://127.0.0.1:4449';
const chain = defineChain({ id: 33, name: 'Rootstock regtest', nativeCurrency: { name: 'Test RBTC', symbol: 'tRBTC', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const client = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 50 });
// Public rskj regtest genesis key, never a production credential.
const owner = privateKeyToAccount('0xc85ef7d79691fe79573b1a7064c19c1a9819ebdbd1faaab1a8ec92344438aaf4');
const requester = privateKeyToAccount(`0x${'12'.repeat(32)}`);
const fulfillerKey = `0x${'34'.repeat(32)}` as Hex;
const fulfiller = privateKeyToAccount(fulfillerKey);
const wallet = createWalletClient({ account: owner, chain, transport: http(rpcUrl) });
const fixture = JSON.parse(readFileSync(new URL('../../tools/vrf-vectors-go/coordinator-vectors.json', import.meta.url), 'utf8'));
const artifact = (name: string) => JSON.parse(readFileSync(new URL(`../../contracts/out/${name}.sol/${name}.json`, import.meta.url), 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
async function mine() { await client.request({ method: 'evm_mine' as never, params: [] as never }); }
async function receipt(hash: Hex) { await mine(); const r = await client.waitForTransactionReceipt({ hash }); assert.equal(r.status, 'success'); return r; }

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
    const requestReceipt = await receipt(await requesterWallet.writeContract({ address: coordinator, abi: coordinatorAbi, functionName: 'request', args: [`0x${'ab'.repeat(32)}`], value: 2n * 10n ** 13n, gas: 500_000n, gasPrice: 1n }));
    const event = parseEventLogs({ abi: coordinatorAbi, eventName: 'RandomnessRequested', logs: requestReceipt.logs })[0]!;
    const requestId = event.args.requestId;
    const record = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [requestId] });
    const roundTime = beacon.genesis + (record.targetRound - 1n) * beacon.period;
    let now = roundTime - 1n;
    let relayCalls = 0;
    let invalidSignature = true;
    const worker = createWorker({ rpcUrl, coordinator, chain, fulfillerPrivateKey: fulfillerKey, loadProvingKey: keyStore(key), relayUrl, fromBlock: requestReceipt.blockNumber, nowSeconds: () => now,
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
    const context = fixture.vectors[0].derivations[0].context as Hex;
    const expectedUrl = new URL(`${relayUrl}/expected`);
    for (const [name, value] of Object.entries({ chainId: 33, round: record.targetRound, coordinator, requester: requester.address, requestId, context })) expectedUrl.searchParams.set(name, String(value));
    const expected = await (await fetch(expectedUrl)).json() as { beta: Hex; random: Hex };
    const final = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [requestId] });
    assert.equal(final.status, 2);
    assert.equal(final.beta, expected.beta, 'Beta matches independently domain-bound Go prover output');
    assert.equal(await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'deriveRandom', args: [requestId, context] }), BigInt(expected.random));
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
    const pendingReceipt = await receipt(await requesterWallet.writeContract({ address: coordinator, abi: implementation.abi, functionName: 'request', args: [`0x${'cd'.repeat(32)}`], value: 12_345n, gas: 500_000n, gasPrice: 1n }));
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
    assert.equal(await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'deriveRandom', args: [requestId, context] }), BigInt(expected.random));

    // The same proxy and key still accept the proof of the pre-upgrade request.
    now = nextBeacon.genesis + (pendingRecord.targetRound - 1n) * nextBeacon.period;
    for (let n = 0; n < pendingRecord.confirmations; n++) await mine();
    const afterUpgrade = await worker.pollOnce();
    assert.equal(afterUpgrade[0]?.status, 'submitted', 'pre-upgrade Pending request remains Fulfillable');
    await receipt(afterUpgrade[0]!.transactionHash!);
    const pendingExpectedUrl = new URL(`${relayUrl}/expected`);
    for (const [name, value] of Object.entries({ chainId: 33, round: pendingRecord.targetRound, coordinator, requester: requester.address, requestId: pendingId, context })) pendingExpectedUrl.searchParams.set(name, String(value));
    const pendingExpected = await (await fetch(pendingExpectedUrl)).json() as { beta: Hex; random: Hex };
    const after = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [pendingId] });
    assert.equal(after.status, 2);
    assert.equal(after.beta, pendingExpected.beta, 'post-upgrade Beta still matches the independent Go prover');
    assert.equal(await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'deriveRandom', args: [pendingId, context] }), BigInt(pendingExpected.random));
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
    assert.deepEqual((await worker.pollOnce()).map(x => x.status), ['skipped', 'skipped']);
    assert.equal(relayCalls, callsBeforeSkip, 'Refunded and expired requests never fetch a beacon');
    assert.equal(await client.getTransactionCount({ address: fulfiller.address, blockTag: 'pending' }), nonceBeforeSkip, 'no fulfill is broadcast past a hard Deadline');
    assert.deepEqual(await worker.pollOnce(), [], 'Refunded and expired requests are dropped');

  } finally {
    relay.kill('SIGTERM');
    if (relay.exitCode === null) await once(relay, 'exit');
  }
});

async function startRelay(port: number) {
  const relay = spawn(process.env.TEST_RELAY_BIN ?? '/tmp/rsk-vrf-test-relay', ['-test-relay', `127.0.0.1:${port}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let relayError = ''; relay.stderr.on('data', chunk => { relayError += String(chunk); });
  const url = `http://127.0.0.1:${port}`;
  const stop = async () => { relay.kill('SIGTERM'); if (relay.exitCode === null) await once(relay, 'exit'); };
  for (let n = 0; n < 100; n++) {
    try { if ((await fetch(`${url}/public/1`)).ok) return { url, stop }; } catch { /* startup only */ }
    if (relay.exitCode !== null) throw new Error(`Test relay exited: ${relayError}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await stop();
  throw new Error('Test relay did not start');
}

async function deployCoordinator() {
  assert.equal(await client.getChainId(), 33, 'must use real rskj regtest');
  for (const account of [requester, fulfiller]) await receipt(await wallet.sendTransaction({ to: account.address, value: 10n ** 19n, gas: 21_000n, gasPrice: 1n }));
  const implementation = artifact('VRFCoordinator');
  const deployed = await receipt(await wallet.deployContract({ abi: implementation.abi, bytecode: implementation.bytecode.object, gas: 6_500_000n, gasPrice: 1n }));
  const beacon = { publicKey: fixture.drand.publicKey.map(BigInt), genesis: BigInt(fixture.drand.genesis), period: BigInt(fixture.drand.period) };
  const init = encodeFunctionData({ abi: implementation.abi, functionName: 'initialize', args: [owner.address, beacon] });
  const proxy = artifact('ERC1967Proxy');
  const proxyReceipt = await receipt(await wallet.deployContract({ abi: proxy.abi, bytecode: proxy.bytecode.object, args: [deployed.contractAddress!, init], gas: 2_000_000n, gasPrice: 1n }));
  return { coordinator: proxyReceipt.contractAddress!, beacon, fromBlock: proxyReceipt.blockNumber };
}

/** An in-memory secret store standing in for AWS Secrets Manager. */
const keyStore = (...keys: ProvingKey[]) => async (keyHash: Hex) => keys.find(k => k.keyHash.toLowerCase() === keyHash.toLowerCase());

const requesterWallet = createWalletClient({ account: requester, chain, transport: http(rpcUrl) });
async function makeRequest(coordinator: Hex, tag: string) {
  const made = await receipt(await requesterWallet.writeContract({ address: coordinator, abi: coordinatorAbi, functionName: 'request', args: [`0x${tag.repeat(32)}`], value: 2n * 10n ** 13n, gas: 500_000n, gasPrice: 1n }));
  const id = parseEventLogs({ abi: coordinatorAbi, eventName: 'RandomnessRequested', logs: made.logs })[0]!.args.requestId;
  return { id, record: await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [id] }) };
}
const register = async (coordinator: Hex, key: ProvingKey) => receipt(await wallet.writeContract({ address: coordinator, abi: coordinatorAbi, functionName: 'registerProvingKey', args: [key.publicKey, owner.address], gas: 500_000n, gasPrice: 1n }));

it('real rskj: after rotation the worker fulfills the pending request with the old key and the new request with the new key', { timeout: 180_000 }, async () => {
  const relay = await startRelay(18770);
  try {
    const { coordinator, beacon, fromBlock } = await deployCoordinator();
    const oldKey = ProvingKey.generate();
    const newKey = ProvingKey.generate();
    await register(coordinator, oldKey);
    let now = 0n;
    const worker = createWorker({ rpcUrl, coordinator, chain, fulfillerPrivateKey: fulfillerKey, loadProvingKey: keyStore(oldKey, newKey), relayUrl: relay.url, fromBlock, nowSeconds: () => now });

    const before = await makeRequest(coordinator, 'a1');
    assert.deepEqual((await worker.pollOnce()).map(x => x.status), ['waiting']);
    await register(coordinator, newKey);
    assert.equal((await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getProvingKey', args: [1] }))[2], 2, 'old key is Draining');
    const after = await makeRequest(coordinator, 'a2');
    assert.equal(before.record.keyId, 1);
    assert.equal(after.record.keyId, 2);

    now = beacon.genesis + (after.record.targetRound - 1n) * beacon.period;
    for (let n = 0; n < 12; n++) await mine();
    const results = await worker.pollOnce();
    assert.deepEqual(results.map(x => x.status), ['submitted', 'submitted']);
    for (const r of results) await receipt(r.transactionHash!);
    for (const { id } of [before, after]) {
      assert.equal((await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [id] })).status, 2, 'Fulfilled');
    }
  } finally {
    await relay.stop();
  }
});

it('real rskj: revocation stops the worker and the pending request is refunded before its Deadline', { timeout: 180_000 }, async () => {
  const relay = await startRelay(18771);
  try {
    const { coordinator, beacon, fromBlock } = await deployCoordinator();
    const key = ProvingKey.generate();
    await register(coordinator, key);
    const { id, record } = await makeRequest(coordinator, 'b1');
    let relayCalls = 0;
    let now = 0n;
    const worker = createWorker({ rpcUrl, coordinator, chain, fulfillerPrivateKey: fulfillerKey, loadProvingKey: keyStore(key), relayUrl: relay.url, fromBlock, nowSeconds: () => now,
      fetch: async (input, init) => { relayCalls++; return fetch(input, init); } });
    assert.deepEqual((await worker.pollOnce()).map(x => x.status), ['waiting']);

    await receipt(await wallet.writeContract({ address: coordinator, abi: coordinatorAbi, functionName: 'revoke', args: [key.keyHash], gas: 200_000n, gasPrice: 1n }));
    now = beacon.genesis + (record.targetRound - 1n) * beacon.period;
    for (let n = 0; n < 12; n++) await mine();
    const nonce = await client.getTransactionCount({ address: fulfiller.address, blockTag: 'pending' });
    assert.deepEqual((await worker.pollOnce()).map(x => x.status), ['skipped'], 'never proves for a Revoked key');
    assert.equal(relayCalls, 0);
    assert.equal(await client.getTransactionCount({ address: fulfiller.address, blockTag: 'pending' }), nonce, 'no fulfill is sent');

    assert.ok(await client.getBlockNumber({ cacheTime: 0 }) < BigInt(record.deadline), 'still before the Deadline');
    const balance = await client.getBalance({ address: requester.address });
    const refunded = await receipt(await wallet.writeContract({ address: coordinator, abi: coordinatorAbi, functionName: 'timeoutRefund', args: [id], gas: 300_000n, gasPrice: 1n }));
    assert.equal(parseEventLogs({ abi: coordinatorAbi, eventName: 'Refunded', logs: refunded.logs })[0]!.args.reason, 1, 'KeyRevoked reason');
    assert.equal(await client.getBalance({ address: requester.address }), balance + record.fee);
    assert.deepEqual(await worker.pollOnce(), []);
  } finally {
    await relay.stop();
  }
});

it('real rskj: the worker holds every Active and Draining key and follows KeyStateChanged', { timeout: 180_000 }, async () => {
  const { coordinator, fromBlock } = await deployCoordinator();
  const [first, second, third] = [ProvingKey.generate(), ProvingKey.generate(), ProvingKey.generate()];
  await register(coordinator, first);
  await register(coordinator, second);
  const loads: Hex[] = [];
  const store = keyStore(first, second, third);
  const worker = createWorker({ rpcUrl, coordinator, chain, fulfillerPrivateKey: fulfillerKey, relayUrl: 'http://127.0.0.1:1', fromBlock,
    loadProvingKey: async (keyHash) => {
      loads.push(keyHash);
      return store(keyHash);
    } });
  const held = (...keys: ProvingKey[]) => keys.map(k => k.keyHash).sort();

  const startup = await worker.syncKeys();
  assert.deepEqual(startup.map(k => [k.keyId, k.held]), [[1, true], [2, true]], 'Draining and Active keys load before any request');
  assert.deepEqual(worker.heldKeys().sort(), held(first, second));

  await receipt(await wallet.writeContract({ address: coordinator, abi: coordinatorAbi, functionName: 'revoke', args: [first.keyHash], gas: 200_000n, gasPrice: 1n }));
  await worker.pollOnce();
  assert.deepEqual(worker.heldKeys(), held(second), 'a Revoked key is evicted');

  await register(coordinator, third);
  await worker.pollOnce();
  assert.deepEqual(worker.heldKeys().sort(), held(second, third), 'a newly Active key loads on KeyStateChanged');
  assert.equal(loads.length, 3, 'held keys are not reloaded');
});

it('real rskj: a key the secret store lacks is reported as not held, and a load failure keeps its message', { timeout: 180_000 }, async () => {
  const { coordinator, fromBlock } = await deployCoordinator();
  const [missing, failing] = [ProvingKey.generate(), ProvingKey.generate()];
  await register(coordinator, missing);
  await register(coordinator, failing);
  const worker = createWorker({ rpcUrl, coordinator, chain, fulfillerPrivateKey: fulfillerKey, relayUrl: 'http://127.0.0.1:1', fromBlock,
    loadProvingKey: async (keyHash) => {
      if (keyHash.toLowerCase() === failing.keyHash) throw new Error('AccessDeniedException');
      return undefined;
    } });
  const synced = await worker.syncKeys();
  assert.deepEqual(synced.map(k => [k.keyId, k.held, k.error]), [[1, false, undefined], [2, false, 'AccessDeniedException']]);
  assert.deepEqual(worker.heldKeys(), []);
});
