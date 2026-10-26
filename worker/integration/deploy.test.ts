import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, parseAbi, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ProvingKey } from '../src/proving-key.ts';

const rpcUrl = process.env.RSK_RPC_URL ?? 'http://127.0.0.1:4449';
const chain = defineChain({ id: 33, name: 'Rootstock regtest', nativeCurrency: { name: 'Test RBTC', symbol: 'tRBTC', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const client = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 50, cacheTime: 0 });
// Public rskj regtest genesis key, never a production credential. It funds the deployer and signs for the Safe stand-in.
const signer = privateKeyToAccount('0xc85ef7d79691fe79573b1a7064c19c1a9819ebdbd1faaab1a8ec92344438aaf4');
const deployerKey = `0x${'56'.repeat(32)}` as Hex;
const deployer = privateKeyToAccount(deployerKey);
const wallet = createWalletClient({ account: signer, chain, transport: http(rpcUrl) });
const contractsDir = fileURLToPath(new URL('../../contracts/', import.meta.url));
// Records go in a fresh directory under deployments/ (gitignored, and inside forge's
// fs_permissions), so a developer's own deployments/33.json is never touched.
const deploymentsDir = fileURLToPath(new URL('../../deployments/', import.meta.url));
const fixture = JSON.parse(readFileSync(new URL('../../tools/vrf-vectors-go/coordinator-vectors.json', import.meta.url), 'utf8'));
const artifact = (name: string) => JSON.parse(readFileSync(new URL(`../../contracts/out/${name}.sol/${name}.json`, import.meta.url), 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
const ownableAbi = parseAbi(['function owner() view returns (address)', 'function pendingOwner() view returns (address)', 'function acceptOwnership()']);

async function mine() { await client.request({ method: 'evm_mine' as never, params: [] as never }); }
async function receipt(hash: Hex) { await mine(); const found = await client.waitForTransactionReceipt({ hash }); assert.equal(found.status, 'success'); return found; }

/** rskj regtest only mines on request, so forge would wait forever for its receipts. */
async function withMiner<T>(body: () => Promise<T>): Promise<T> {
  let mining = true;
  const loop = (async () => { while (mining) { await mine(); await new Promise(resolve => setTimeout(resolve, 100)); } })();
  try { return await body(); } finally { mining = false; await loop; }
}

function run(command: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: contractsDir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
}

function check(path: string, expectedSafe: Address) {
  return run('forge', ['script', 'script/CheckDeployment.s.sol:CheckDeployment', '--rpc-url', rpcUrl, '--sig', 'run(string,address)', path, expectedSafe]);
}

function git(...args: string[]) { return execFileSync('git', args, { cwd: contractsDir, encoding: 'utf8' }).trim(); }

type Recorded = { address: string; block: number; txHash: Hex };

describe('deploy and Safe hand-off on real rskj', { concurrency: 1 }, () => {
  it('deploy.sh deploys and records the plan, and the check passes only once the Safe accepts', { timeout: 300_000 }, async () => {
    assert.equal(await client.getChainId(), 33, 'must use real rskj regtest');
    await receipt(await wallet.sendTransaction({ to: deployer.address, value: 10n ** 19n, gas: 21_000n, gasPrice: 1n }));
    const standIn = artifact('SafeStandIn');
    const safeReceipt = await receipt(await wallet.deployContract({ abi: standIn.abi, bytecode: standIn.bytecode.object, args: [signer.address], gas: 1_000_000n, gasPrice: 1n }));
    assert.ok(safeReceipt.contractAddress);
    const safe = safeReceipt.contractAddress;
    const [x, y] = ProvingKey.fromHex(fixture.vectors[0].vrf.secretKey).publicKey;

    const dir = mkdtempSync(join(deploymentsDir, 'test-'));
    const record = join(dir, '33.json');
    const editedRecord = join(dir, '33.edited.json');
    try {
      const deployed = await withMiner(() => run('script/deploy.sh', [safe, String(x), String(y), '--private-key', deployerKey], { RPC_URL: rpcUrl, DEPLOYMENT_FILE: record }));
      assert.equal(deployed.code, 0, deployed.output);

      const text = readFileSync(record, 'utf8');
      for (const address of text.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) ?? []) assert.equal(address, address.toLowerCase(), 'addresses are lowercase');
      const json = JSON.parse(text);
      assert.equal(json.chainId, 33);
      const dirty = git('status', '--porcelain', '--untracked-files=all') !== '';
      assert.equal(json.commit, git('rev-parse', 'HEAD') + (dirty ? '-dirty' : ''), 'off chain 31 a dirty tree is marked, not refused');
      assert.equal(json.deployer, deployer.address.toLowerCase());
      assert.equal(json.safe, safe.toLowerCase());
      assert.equal(json.config.provingKey.payee, safe.toLowerCase());
      assert.equal(json.config.fee, 20_000_000_000_000);
      assert.equal(json.config.callbackGasCap, 200_000);

      for (const name of ['implementation', 'proxy'] as const) {
        const entry = json.contracts[name] as Recorded & { verification?: unknown };
        const found = await client.getTransactionReceipt({ hash: entry.txHash });
        assert.equal(found.contractAddress?.toLowerCase(), entry.address, `${name} tx created it`);
        assert.equal(found.blockNumber, BigInt(entry.block), `${name} block`);
        assert.equal(entry.verification, undefined, 'explorers do not index regtest');
      }
      assert.deepEqual((json.transactions as { function: string }[]).map(tx => tx.function), [
        'registerProvingKey(uint256[2],address)',
        'setFeeConfig(uint256)',
        'setCallbackGasCap(uint256)',
        'transferOwnership(address)',
      ]);
      for (const tx of json.transactions as { txHash: Hex; block: number }[]) {
        const found = await client.getTransactionReceipt({ hash: tx.txHash });
        assert.equal(found.status, 'success');
        assert.equal(found.from.toLowerCase(), json.deployer);
        assert.equal(found.to?.toLowerCase(), json.contracts.proxy.address);
        assert.equal(found.blockNumber, BigInt(tx.block));
      }

      const coordinator = json.contracts.proxy.address as Address;
      assert.equal((await client.readContract({ address: coordinator, abi: ownableAbi, functionName: 'pendingOwner' })).toLowerCase(), safe.toLowerCase());
      const early = await check(record, safe);
      assert.notEqual(early.code, 0, 'check fails while the deployer still owns');
      assert.match(early.output, /Mismatch\("owner"\)/);

      const accept = encodeFunctionData({ abi: ownableAbi, functionName: 'acceptOwnership' });
      await receipt(await wallet.writeContract({ address: safe, abi: standIn.abi, functionName: 'execute', args: [coordinator, accept], gas: 200_000n, gasPrice: 1n }));
      assert.equal((await client.readContract({ address: coordinator, abi: ownableAbi, functionName: 'owner' })).toLowerCase(), safe.toLowerCase());

      const passed = await check(record, safe);
      assert.equal(passed.code, 0, passed.output);

      const otherSafe = await check(record, signer.address);
      assert.notEqual(otherSafe.code, 0, 'check fails when the operator expects another Safe');
      assert.match(otherSafe.output, /Mismatch\("safe"\)/);

      const editedText = text.replace('"fee": 20000000000000', '"fee": 20000000000001');
      assert.notEqual(editedText, text, 'the edit changes the fee');
      writeFileSync(editedRecord, editedText);
      const edited = await check(editedRecord, safe);
      assert.notEqual(edited.code, 0, 'check fails on an edited fee');
      assert.match(edited.output, /Mismatch\("fee"\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
