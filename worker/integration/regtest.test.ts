import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { it } from 'node:test';
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, parseEventLogs, type Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { coordinatorAbi } from '../src/coordinator.ts';
import { createWorker } from '../src/worker.ts';
import { ProvingKey } from '../src/proving-key.ts';

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

it('real rskj: fulfills, settles fees, refunds frozen Escrow and drops Refunded or expired requests', { timeout: 180_000 }, async () => {
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
    const worker = createWorker({ rpcUrl, coordinator, chain, fulfillerPrivateKey: fulfillerKey, provingKey: key, relayUrl, fromBlock: requestReceipt.blockNumber, nowSeconds: () => now,
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

    const fee = 2n * 10n ** 13n;
    assert.equal(record.fee, fee, 'request escrows exact native rBTC fee');
    assert.equal(await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'payeeBalance', args: [owner.address] }), fee);
    const withdrew = await receipt(await wallet.writeContract({ address: coordinator, abi: coordinatorAbi, functionName: 'withdrawFees', gas: 300_000n, gasPrice: 1n }));
    assert.equal(parseEventLogs({ abi: coordinatorAbi, eventName: 'FeesWithdrawn', logs: withdrew.logs })[0]!.args.amount, fee);
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
