import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, parseAbiItem, parseEventLogs, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { coordinatorAbi } from '../src/coordinator.ts';
import { ProvingKey } from '../src/proving-key.ts';
import { createWorker, type PollResult } from '../src/worker.ts';

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
  const requestReceipt = await receipt(await requesterWallet.writeContract({ address: coordinator, abi: coordinatorAbi, functionName: 'request', args: [tag], gas: 500_000n, gasPrice: 1n }));
  const event = parseEventLogs({ abi: coordinatorAbi, eventName: 'RandomnessRequested', logs: requestReceipt.logs })[0];
  assert.ok(event);
  const requestId = event.args.requestId;
  const record = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [requestId] });
  return { requestId, requestReceipt, record };
}

function forRequest(results: PollResult[], requestId: Hex) {
  return results.find(item => item.requestId === requestId);
}

describe('worker regtest', { concurrency: 1 }, () => {
  it('real rskj: waits frozen round, rejects simulation without a send, retries and fulfills from separate EOA, derives independent Go expected word, and keeps the id until the outcome is confirmations deep', { timeout: 180_000 }, async () => {
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
      const cursor = await head();
      assert.ok(cursor > requestReceipt.blockNumber, 'caller cursor is past the request block');
      const worker = createWorker({
        rpcUrl, coordinator, chain, fulfillerPrivateKey: fulfillerKey, provingKey: key, relayUrl, fromBlock: cursor, nowSeconds: () => now,
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
      const fulfilledReceipt = await receipt(submitted[0]!.transactionHash!);
      const fulfilled = parseEventLogs({ abi: coordinatorAbi, eventName: 'Fulfilled', logs: fulfilledReceipt.logs })[0];
      assert.ok(fulfilled);
      assert.equal(fulfilled.args.fulfiller.toLowerCase(), fulfiller.address.toLowerCase());
      assert.notEqual(requester.address, fulfiller.address);
      const context = fixture.vectors[0].derivations[0].context as Hex;
      const expectedUrl = new URL(`${relayUrl}/expected`);
      for (const [name, value] of Object.entries({ chainId: 33, round: record.targetRound, coordinator, requester: requester.address, requestId, context })) expectedUrl.searchParams.set(name, String(value));
      const expected = await (await fetch(expectedUrl)).json() as { beta: Hex; random: Hex };
      const finalRecord = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [requestId] });
      assert.equal(finalRecord.status, 2);
      assert.equal(finalRecord.beta, expected.beta, 'Beta matches independently domain-bound Go prover output');
      assert.equal(await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'deriveRandom', args: [requestId, context] }), BigInt(expected.random));
      const held = await worker.pollOnce();
      assert.equal(forRequest(held, requestId)?.status, 'waiting', 'an outcome at depth 0 stays pending');
      await mineBlocks(confirmations);
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
        rpcUrl, coordinator, chain, fulfillerPrivateKey: fulfillerKey, provingKey: key, relayUrl,
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

  it('a new fulfiller keeps a mined outcome until it is confirmations deep and does not send another', { timeout: 180_000 }, async () => {
    await withRelay(18771, async relayUrl => {
      const backupKey = `0x${'56'.repeat(32)}` as Hex;
      const backup = privateKeyToAccount(backupKey);
      await fund([requester, fulfiller, backup]);
      const { coordinator, key, beacon } = await deployCoordinator();
      const { requestId, requestReceipt, record } = await requestRandomness(coordinator, `0x${'ef'.repeat(32)}`);
      const confirmations = Number(record.confirmations);
      const roundTime = beacon.genesis + (record.targetRound - 1n) * beacon.period;
      await mineBlocks(confirmations);
      const worker = createWorker({ rpcUrl, coordinator, chain, fulfillerPrivateKey: fulfillerKey, provingKey: key, relayUrl, nowSeconds: () => roundTime });
      const submitted = await worker.pollOnce();
      assert.equal(forRequest(submitted, requestId)?.status, 'submitted');
      await receipt(forRequest(submitted, requestId)!.transactionHash!);
      const before = await nonceOf(backup.address);
      const restarted = createWorker({ rpcUrl, coordinator, chain, fulfillerPrivateKey: backupKey, provingKey: key, relayUrl, nowSeconds: () => roundTime });
      const seen = await restarted.pollOnce();
      assert.equal(forRequest(seen, requestId)?.status, 'waiting');
      assert.equal(seen.some(item => item.status === 'submitted'), false);
      assert.equal(await nonceOf(backup.address), before);
      const logs = await client.getLogs({ address: coordinator, event: fulfilledEvent, args: { requestId }, fromBlock: requestReceipt.blockNumber, toBlock: await head(), strict: true });
      assert.equal(logs.length, 1);
      assert.equal(logs[0]?.args.fulfiller.toLowerCase(), fulfiller.address.toLowerCase());
      await mineBlocks(confirmations);
      const released = await restarted.pollOnce();
      assert.equal(released.some(item => item.requestId === requestId), false);
    });
  });
});
