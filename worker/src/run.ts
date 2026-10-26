#!/usr/bin/env node
// Polling worker. Each poll backfills from the chain; proving keys load from Secrets Manager.
import { KMSClient } from '@aws-sdk/client-kms';
import { SSMClient } from '@aws-sdk/client-ssm';
import { createPublicClient, defineChain, getAddress, http, type Hex } from 'viem';
import type { LocalAccount } from 'viem/accounts';
import { kmsAccount } from './kms-signer.ts';
import { applyParameters, loadParameters } from './parameters.ts';
import { AwsSecretSource, provingKeyLoader } from './secrets.ts';
import { createWorker, RESERVE_FULFILLS, type DrandPin } from './worker.ts';
import { runWorkerLoop } from './loop.ts';
import { jsonLine, type WatchdogConfig } from './watchdog.ts';

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

/** fulfiller is the KMS key when FULFILLER_KMS_KEY_ID is set, else FULFILLER_PRIVATE_KEY (development only). */
async function fulfiller(): Promise<{ fulfillerAccount: LocalAccount } | { fulfillerPrivateKey: Hex }> {
  const keyId = process.env.FULFILLER_KMS_KEY_ID;
  const privateKey = process.env.FULFILLER_PRIVATE_KEY;
  delete process.env.FULFILLER_PRIVATE_KEY;
  if (keyId && privateKey) throw new Error('Configure exactly one Fulfiller');
  if (keyId) return { fulfillerAccount: await kmsAccount({ kms: new KMSClient({}), keyId }) };
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('Invalid Fulfiller key');
  return { fulfillerPrivateKey: privateKey as Hex };
}

async function main() {
  // On the hosts, configuration lives in SSM Parameter Store under this path.
  const parameterPath = process.env.SSM_CONFIG_PATH;
  if (parameterPath) applyParameters(process.env, await loadParameters({ ssm: new SSMClient({}), path: parameterPath }));
  const pin = drandPin();
  const watchdog: WatchdogConfig = {
    pageUrl: new URL(required('ALERT_PAGE_URL')).toString(),
    warningUrl: new URL(required('ALERT_WARNING_URL')).toString(),
    workerId: required('WORKER_ID'),
    pageToken: process.env.ALERT_PAGE_TOKEN,
    allowedFulfillers: (process.env.OWN_FULFILLER_ADDRESSES ?? '').split(',').filter(Boolean).map(value => getAddress(value.trim().toLowerCase())),
    topUpFulfillments: BigInt(process.env.TOP_UP_FULFILLMENTS ?? '100'),
  };
  if (watchdog.topUpFulfillments! <= RESERVE_FULFILLS) throw new Error('Invalid top-up threshold');
  const heartbeatUrl = new URL(required('HEALTHCHECKS_PING_URL')).toString();
  const grace = graceBlocks();
  const relays = relayUrls();
  const rpcUrl = new URL(required('RSK_RPC_URL')).toString();
  const coordinator = getAddress(required('COORDINATOR_ADDRESS').toLowerCase());
  const signer = await fulfiller();
  const client = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await client.getChainId();
  const chain = defineChain({ id: chainId, name: 'Rootstock', nativeCurrency: { name: 'RBTC', symbol: 'RBTC', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  // Every Active and Draining key loads at startup and again on KeyStateChanged,
  // so a Draining key keeps serving after rotation.
  const loadProvingKey = provingKeyLoader(new AwsSecretSource());
  const worker = createWorker({
    rpcUrl, relayUrls: relays, coordinator, chain, ...signer, loadProvingKey, drandPin: pin, graceBlocks: grace, watchdog,
    report: line => process.stderr.write(`${line}\n`),
  });
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());
  // Do not log secret-store exception text: provider errors can quote configuration.
  for (const key of await worker.syncKeys()) process.stdout.write(`${jsonLine({ event: 'key_sync', keyId: key.keyId, keyHash: key.keyHash, held: key.held })}\n`);
  process.stdout.write(`${jsonLine({ event: 'polling', coordinator, workerId: watchdog.workerId })}\n`);
  await runWorkerLoop({
    pollOnce: worker.pollOnce,
    signal: stop.signal,
    report: line => process.stdout.write(`${line}\n`),
    heartbeat: async () => {
      const response = await fetch(heartbeatUrl, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
      if (!response.ok) throw new Error('Heartbeat failed');
    },
  });
}

try { await main(); } catch {
  // Never stringify SDK errors or secret-bearing configuration.
  process.stderr.write(`${jsonLine({ level: 'error', event: 'startup_failed', message: 'Check configuration, RPC and Secrets Manager access' })}\n`);
  process.exitCode = 1;
}
