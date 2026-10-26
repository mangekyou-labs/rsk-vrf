import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { it } from 'node:test';
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, parseEventLogs, type Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { composeFulfillment, coordinatorAbi } from '../src/coordinator.ts';
import { createWorker } from '../src/worker.ts';
import { ProvingKey } from '../src/proving-key.ts';

const rpcUrl = process.env.RSK_RPC_URL ?? 'http://127.0.0.1:4449';
const chain = defineChain({ id: 33, name: 'Rootstock regtest', nativeCurrency: { name: 'Test RBTC', symbol: 'tRBTC', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const client = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 50 });
// Published rskj regtest genesis key, never a production credential.
const admin = privateKeyToAccount('0xc85ef7d79691fe79573b1a7064c19c1a9819ebdbd1faaab1a8ec92344438aaf4');
const fulfillerKey = `0x${'56'.repeat(32)}` as Hex;
const fulfiller = privateKeyToAccount(fulfillerKey);
const wallet = createWalletClient({ account: admin, chain, transport: http(rpcUrl) });
const fulfillerWallet = createWalletClient({ account: fulfiller, chain, transport: http(rpcUrl) });
const fixture = JSON.parse(readFileSync(new URL('../../tools/vrf-vectors-go/coordinator-vectors.json', import.meta.url), 'utf8'));
const artifact = (name: string) => JSON.parse(readFileSync(new URL(`../../contracts/out/${name}.sol/${name}.json`, import.meta.url), 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
async function mine() { await client.request({ method: 'evm_mine' as never, params: [] as never }); }
async function receipt(hash: Hex) { await mine(); const r = await client.waitForTransactionReceipt({ hash }); assert.equal(r.status, 'success'); return r; }

// Search independently of eth_estimateGas: its result can depend on the
// callback branch observed, whereas the guarantee covers the entire frozen cap.
async function boundary<T>(call: (gas: bigint) => Promise<T>, upper = 4_000_000n) {
  let low = 21_000n;
  let high = upper;
  await call(high);
  while (low + 1n < high) {
    const middle = (low + high) / 2n;
    try { await call(middle); high = middle; } catch { low = middle; }
  }
  await assert.rejects(call(high - 1n), 'one gas below the boundary must revert');
  return { gas: high, result: await call(high) };
}

it('real rskj: full callback caps, isolated failures and reserve boundaries', { timeout: 180_000 }, async () => {
  const relayPort = 18770;
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
    assert.ok(ready);
    assert.equal(await client.getChainId(), 33, 'this gate requires real rskj, not an EIP-150 EVM');
    await receipt(await wallet.sendTransaction({ to: fulfiller.address, value: 10n ** 19n, gas: 21_000n, gasPrice: 1n }));
    const implementation = artifact('VRFCoordinator');
    const deployed = await receipt(await wallet.deployContract({ abi: implementation.abi, bytecode: implementation.bytecode.object, gas: 6_500_000n, gasPrice: 1n }));
    const beacon = { publicKey: fixture.drand.publicKey.map(BigInt), genesis: BigInt(fixture.drand.genesis), period: BigInt(fixture.drand.period) };
    const init = encodeFunctionData({ abi: implementation.abi, functionName: 'initialize', args: [admin.address, beacon] });
    const proxy = artifact('ERC1967Proxy');
    const proxyReceipt = await receipt(await wallet.deployContract({ abi: proxy.abi, bytecode: proxy.bytecode.object, args: [deployed.contractAddress!, init], gas: 2_000_000n, gasPrice: 1n }));
    const coordinator = proxyReceipt.contractAddress!;
    const key = ProvingKey.fromHex(fixture.vectors[0].vrf.secretKey);
    await receipt(await wallet.writeContract({ address: coordinator, abi: coordinatorAbi, functionName: 'registerProvingKey', args: [key.publicKey, admin.address], gas: 500_000n, gasPrice: 1n }));
    const consumerArtifact = artifact('CallbackRegtestConsumer');
    const deployedConsumer = await receipt(await wallet.deployContract({ abi: consumerArtifact.abi, bytecode: consumerArtifact.bytecode.object, args: [coordinator], gas: 1_000_000n, gasPrice: 1n }));
    const consumer = deployedConsumer.contractAddress!;
    const probeArtifact = artifact('CallbackReserveProbe');
    const probe = (await receipt(await wallet.deployContract({ abi: probeArtifact.abi, bytecode: probeArtifact.bytecode.object, gas: 1_000_000n, gasPrice: 1n }))).contractAddress!;
    // rskj reports an out-of-gas eth_call as 0x, which looks like a successful
    // void fulfill. Mine each production search trial and revert its snapshot;
    // receipt status is the authority, not an empty simulation response.
    const fulfillmentBoundary = (args: readonly [Hex, ReturnType<typeof composeFulfillment>['proof'], readonly [bigint, bigint]]) => boundary(async gas => {
      const snapshot = await client.request({ method: 'evm_snapshot' as never, params: [] as never });
      try {
        const hash = await fulfillerWallet.writeContract({ address: coordinator, abi: implementation.abi, functionName: 'fulfill', args, gas, gasPrice: 1n });
        return await receipt(hash);
      } finally {
        assert.equal(await client.request({ method: 'evm_revert' as never, params: [snapshot] as never }), true);
      }
    });
    let tag = 0;
    let totalFees = 0n;
    const request = async (cap: number, mode: number) => {
      await receipt(await wallet.writeContract({ address: coordinator, abi: implementation.abi, functionName: 'setCallbackGasCap', args: [cap], gas: 150_000n, gasPrice: 1n }));
      await receipt(await wallet.writeContract({ address: consumer, abi: consumerArtifact.abi, functionName: 'setMode', args: [mode], gas: 100_000n, gasPrice: 1n }));
      const made = await receipt(await wallet.writeContract({ address: consumer, abi: consumerArtifact.abi, functionName: 'request', args: [`0x${(++tag).toString(16).padStart(64, '0')}`], value: 20_000_000_000_000n, gas: 500_000n, gasPrice: 1n }));
      const requestId = parseEventLogs({ abi: coordinatorAbi, eventName: 'RandomnessRequested', logs: made.logs })[0]!.args.requestId;
      const record = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [requestId] });
      assert.equal(record.callbackGasCap, cap);
      const signature = (await (await fetch(`${relayUrl}/public/${record.targetRound}`)).json() as { signature: string }).signature;
      const composed = composeFulfillment({ chainId: 33n, coordinator, requester: consumer, requestId, targetRound: record.targetRound, signature: `0x${signature.replace(/^0x/, '')}` }, key);
      for (let n = 0; n < record.confirmations; n++) await mine();
      return { requestId, record, composed, fromBlock: made.blockNumber };
    };
    const verifySettled = async (requestId: Hex, beta: Hex) => {
      const final = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [requestId] });
      assert.equal(final.status, 2);
      assert.equal(final.beta, beta);
      totalFees += final.fee;
      assert.equal(await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'payeeBalance', args: [admin.address] }), totalFees);
    };
    for (const cap of [25_000, 200_000, 2_500_000]) {
      const success = await request(cap, 0);
      const args = [success.requestId, success.composed.proof, success.composed.drandSignature] as const;
      // Entry telemetry at the tight mined transaction boundary must show the
      // full cap, less only the consumer's selector dispatch.
      const tight = await fulfillmentBoundary(args);
      const tx = await receipt(await fulfillerWallet.writeContract({ address: coordinator, abi: implementation.abi, functionName: 'fulfill', args, gas: tight.gas, gasPrice: 1n }));
      const entered = parseEventLogs({ abi: consumerArtifact.abi, eventName: 'CallbackEntered', logs: tx.logs })[0]!;
      assert.ok(entered, 'successful callback runs at the fulfillment boundary');
      assert.ok(BigInt(cap) - (entered.args as { gasAtEntry: bigint }).gasAtEntry < 1_000n, 'callback receives the full cap, less selector dispatch only');
      assert.equal(parseEventLogs({ abi: implementation.abi, eventName: 'CallbackFailed', logs: tx.logs }).length, 0);
      await verifySettled(success.requestId, success.composed.beta);

      const burner = await request(cap, 1);
      const burnArgs = [burner.requestId, burner.composed.proof, burner.composed.drandSignature] as const;
      const burnBoundary = await fulfillmentBoundary(burnArgs);
      const burned = await receipt(await fulfillerWallet.writeContract({ address: coordinator, abi: implementation.abi, functionName: 'fulfill', args: burnArgs, gas: burnBoundary.gas, gasPrice: 1n }));
      assert.equal(parseEventLogs({ abi: implementation.abi, eventName: 'CallbackFailed', logs: burned.logs }).length, 1, 'burning the entire cap cannot revert fulfillment');
      await verifySettled(burner.requestId, burner.composed.beta);

      // This probe isolates CALL + outcome-event + return overhead. It deliberately
      // has no reserve guard, so searching can measure the reserve actually needed.
      const measured = await boundary(gas => client.simulateContract({ account: fulfiller, address: probe, abi: probeArtifact.abi, functionName: 'probe', args: [probe, cap], gas }));
      const [gasBeforeCall] = measured.result.result as readonly [bigint, bigint];
      const reserve = gasBeforeCall - BigInt(cap);
      assert.ok(reserve >= 0n && reserve <= 10_000n, `burner reserve ${reserve} exceeds CALLBACK_RESERVE`);
      console.log(`rskj cap=${cap}: CALL/event/return reserve=${reserve}, production fulfill boundary=${burnBoundary.gas}`);
    }

    // A callback may take a different branch between simulation and mining. The
    // worker must still fund the frozen full cap, including at the maximum cap.
    for (const cap of [25_000, 2_500_000]) {
      let pending = await request(cap, 0);
      // Force a multi-try proof so a fixed verification allowance fails this gate.
      while (pending.composed.hashToCurveTries < 2) {
        await receipt(await fulfillerWallet.writeContract({ address: coordinator, abi: implementation.abi, functionName: 'fulfill', args: [pending.requestId, pending.composed.proof, pending.composed.drandSignature], gas: 4_000_000n, gasPrice: 1n }));
        await verifySettled(pending.requestId, pending.composed.beta);
        pending = await request(cap, 0);
      }
      const worker = createWorker({ rpcUrl, coordinator, chain, fulfillerPrivateKey: fulfillerKey, provingKey: key, relayUrl, drandPin: { ...beacon, publicKey: beacon.publicKey as [bigint, bigint, bigint, bigint] }, nowSeconds: () => beacon.genesis + (pending.record.targetRound - 1n) * beacon.period });
      const result = await worker.pollOnce();
      const submitted = result.find(entry => entry.requestId === pending.requestId);
      assert.equal(submitted?.status, 'submitted');
      const hash = submitted!.transactionHash!;
      assert.equal((await client.getTransaction({ hash })).gas, 652_000n + 20_000n * BigInt(pending.composed.hashToCurveTries - 1) + BigInt(cap), 'worker reserves full frozen cap even for a cheap callback');
      await receipt(hash);
      await verifySettled(pending.requestId, pending.composed.beta);
    }

    const vanished = await request(25_000, 0);
    await receipt(await wallet.writeContract({ address: consumer, abi: consumerArtifact.abi, functionName: 'destroy', gas: 100_000n, gasPrice: 1n }));
    assert.ok(!await client.getCode({ address: consumer }), 'rskj deletes the Requester account');
    assert.equal(await client.getBalance({ address: consumer }), 0n);
    const measured = await boundary(gas => client.simulateContract({ account: fulfiller, address: probe, abi: probeArtifact.abi, functionName: 'probe', args: [consumer, 25_000], gas }));
    const [gasBeforeCall] = measured.result.result as readonly [bigint, bigint];
    assert.ok(gasBeforeCall <= 35_000n, 'minimum cap + reserve covers a Requester with no account');
    const args = [vanished.requestId, vanished.composed.proof, vanished.composed.drandSignature] as const;
    const tight = await fulfillmentBoundary(args);
    const fulfilled = await receipt(await fulfillerWallet.writeContract({ address: coordinator, abi: implementation.abi, functionName: 'fulfill', args, gas: tight.gas, gasPrice: 1n }));
    assert.equal(parseEventLogs({ abi: implementation.abi, eventName: 'CallbackFailed', logs: fulfilled.logs }).length, 0, 'CALL to vanished Requester succeeds');
    await verifySettled(vanished.requestId, vanished.composed.beta);
    console.log(`rskj no-account Requester: CALL/event/return needs=${gasBeforeCall}, cap+reserve=35000, production boundary=${tight.gas}`);
  } finally {
    relay.kill('SIGTERM');
    if (relay.exitCode === null) await once(relay, 'exit');
  }
});
