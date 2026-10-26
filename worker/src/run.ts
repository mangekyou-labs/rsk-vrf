#!/usr/bin/env node
// Polling worker. Each poll backfills from the chain; proving keys load from Secrets Manager.
import { setTimeout } from 'node:timers/promises';
import { createPublicClient, defineChain, getAddress, http, type Hex } from 'viem';
import { ProvingKey } from './proving-key.ts';
import { AwsSecretSource, secretName } from './secrets.ts';
import { parseKeyHash } from './types.ts';
import { createWorker, type DrandPin } from './worker.ts';

const SPEC_RELAYS = ['https://api.drand.sh', 'https://api2.drand.sh', 'https://api3.drand.sh'];

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('Missing configuration');
  return value;
}

function drandPin(): DrandPin {
  const words = required('DRAND_PIN_PUBLIC_KEY').split(',').map(word => word.trim());
  if (words.length !== 4 || words.some(word => !/^0x[0-9a-fA-F]{1,64}$/.test(word))) throw new Error('Invalid pin');
  const publicKey = words.map(word => BigInt(word)) as [bigint, bigint, bigint, bigint];
  const genesis = BigInt(required('DRAND_PIN_GENESIS'));
  const period = BigInt(required('DRAND_PIN_PERIOD'));
  if (period <= 0n) throw new Error('Invalid pin');
  return { publicKey, genesis, period };
}

function relayUrls(): string[] {
  const listed = process.env.DRAND_RELAY_URLS;
  const single = process.env.DRAND_RELAY_URL;
  const raw = listed ? listed.split(',') : single ? [single] : SPEC_RELAYS;
  return raw.map(item => new URL(item.trim()).toString().replace(/\/$/, ''));
}

function graceBlocks(): number {
  const raw = process.env.GRACE_BLOCKS;
  if (raw === undefined || raw === '') return 0;
  if (!/^\d+$/.test(raw)) throw new Error('Invalid grace');
  return Number(raw);
}

async function main() {
  const pin = drandPin();
  const grace = graceBlocks();
  const relays = relayUrls();
  const rpcUrl = new URL(required('RSK_RPC_URL')).toString();
  const coordinator = getAddress(required('COORDINATOR_ADDRESS').toLowerCase());
  const fulfillerPrivateKey = required('FULFILLER_PRIVATE_KEY') as Hex;
  delete process.env.FULFILLER_PRIVATE_KEY;
  if (!/^0x[0-9a-fA-F]{64}$/.test(fulfillerPrivateKey)) throw new Error('Invalid Fulfiller key');
  const client = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await client.getChainId();
  const chain = defineChain({ id: chainId, name: 'Rootstock', nativeCurrency: { name: 'RBTC', symbol: 'RBTC', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  // Every Active and Draining key loads at startup and again on KeyStateChanged,
  // so a Draining key keeps serving after rotation.
  const secrets = new AwsSecretSource();
  const loadProvingKey = async (keyHash: Hex) => {
    const parsed = parseKeyHash(keyHash);
    if (!parsed) throw new Error('Invalid key hash');
    let secret: string;
    try {
      secret = await secrets.load(secretName(parsed));
    } catch (error) {
      // A key this deployment does not hold is not an error.
      if (error instanceof Error && error.name === 'ResourceNotFoundException') return undefined;
      throw error;
    }
    return ProvingKey.fromHex(secret);
  };
  const worker = createWorker({
    rpcUrl, relayUrls: relays, coordinator, chain, fulfillerPrivateKey, loadProvingKey, drandPin: pin, graceBlocks: grace,
    report: line => process.stderr.write(`${line}\n`),
  });
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());
  // KeySync carries only keyIds, keyHashes and load-error messages, which never quote a secret.
  for (const key of await worker.syncKeys()) process.stdout.write(`${JSON.stringify(key)}\n`);
  process.stdout.write(`worker: polling ${coordinator}\n`);
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
