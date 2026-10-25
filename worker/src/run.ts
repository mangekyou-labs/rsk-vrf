#!/usr/bin/env node
// Polling tracer. Proving Keys load from Secrets Manager; no secret is logged.
import { setTimeout } from 'node:timers/promises';
import { createPublicClient, defineChain, getAddress, http, type Hex } from 'viem';
import { coordinatorAbi } from './coordinator.ts';
import { ProvingKey } from './proving-key.ts';
import { AwsSecretSource, secretName } from './secrets.ts';
import { parseKeyHash } from './types.ts';
import { createWorker } from './worker.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('Missing configuration');
  return value;
}

async function main() {
  const rpcUrl = new URL(required('RSK_RPC_URL')).toString();
  const relayUrl = new URL(required('DRAND_RELAY_URL')).toString();
  const coordinator = getAddress(required('COORDINATOR_ADDRESS').toLowerCase());
  const fromBlock = BigInt(required('FROM_BLOCK'));
  if (fromBlock < 0n) throw new Error('Invalid block');
  const fulfillerPrivateKey = required('FULFILLER_PRIVATE_KEY') as Hex;
  delete process.env.FULFILLER_PRIVATE_KEY;
  if (!/^0x[0-9a-fA-F]{64}$/.test(fulfillerPrivateKey)) throw new Error('Invalid Fulfiller key');
  const client = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await client.getChainId();
  const chain = defineChain({ id: chainId, name: 'Rootstock', nativeCurrency: { name: 'RBTC', symbol: 'RBTC', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  // An explicit hash also permits serving a Draining Key after rotation.
  let keyHash = parseKeyHash(process.env.PROVING_KEY_HASH ?? '');
  if (process.env.PROVING_KEY_HASH !== undefined && !keyHash) throw new Error('Invalid key hash');
  if (!keyHash) {
    const keyId = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'activeKeyId' });
    const [registered] = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getProvingKey', args: [keyId] });
    keyHash = parseKeyHash(registered);
  }
  if (!keyHash) throw new Error('Invalid key hash');
  const provingKey = ProvingKey.fromHex(await new AwsSecretSource().load(secretName(keyHash)));
  if (provingKey.keyHash !== keyHash) throw new Error('Proving Key mismatch');
  const worker = createWorker({ rpcUrl, relayUrl, coordinator, chain, fromBlock, fulfillerPrivateKey, provingKey });
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());
  process.stdout.write(`worker: polling ${coordinator} from block ${fromBlock}\n`);
  while (!stop.signal.aborted) {
    try {
      for (const result of await worker.pollOnce()) process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch {
      process.stderr.write('worker: polling failed; retrying\n');
    }
    try { await setTimeout(10_000, undefined, { signal: stop.signal }); } catch { /* shutdown */ }
  }
}

try { await main(); } catch {
  // Never stringify SDK errors or secret-bearing configuration.
  process.stderr.write('worker: startup failed; check configuration, RPC and Secrets Manager access\n');
  process.exitCode = 1;
}
