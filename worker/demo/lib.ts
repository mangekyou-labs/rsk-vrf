// Shared plumbing for the demo scripts: environment, the deployment record, contract
// artifacts, explorer links and waiting for blocks. Testnet pilot code, not externally audited.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createPublicClient, createWalletClient, decodeErrorResult, decodeFunctionData, defineChain,
  encodeFunctionData, http, parseEventLogs, stringToHex,
  type Abi, type Address, type Hex, type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { coordinatorFromDeployment } from '../src/deployment.ts';
import { EVMNET_CHAIN_HASH } from '../src/relays.ts';
import type { Signature } from './derive.ts';

export { alphaOf, type Signature } from './derive.ts';

export const BANNER = 'Testnet pilot, not externally audited; do not use for value.';
export const REGTEST = 33;
export const Status = { None: 0, Pending: 1, Fulfilled: 2, Refunded: 3 } as const;

const repo = new URL('../../', import.meta.url);

/** A Foundry artifact; the scripts need `forge build` in contracts/ first. */
export function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const path = new URL(`contracts/out/${name}.sol/${name}.json`, repo);
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { throw new Error(`Missing ${fileURLToPath(path)}; run forge build in contracts/ first`); }
  const json = JSON.parse(text) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

export const coordinatorAbi = artifact('VRFCoordinator').abi;

/** The evmnet drand chain on the public relay; DRAND_RELAY_URL overrides it. */
export const EVMNET_RELAY = `https://api.drand.sh/${EVMNET_CHAIN_HASH}`;

export function drandRelay(): string {
  return (process.env.DRAND_RELAY_URL ?? EVMNET_RELAY).replace(/\/$/, '');
}

/** VRF.sol's Proof struct as viem decodes it from fulfill calldata. */
export interface OnChainProof {
  pk: readonly [bigint, bigint]; gamma: readonly [bigint, bigint]; c: bigint; s: bigint; seed: bigint; uWitness: Address;
  cGammaWitness: readonly [bigint, bigint]; sHashWitness: readonly [bigint, bigint]; zInv: bigint;
}

/** The arguments of a fulfill transaction's calldata. */
export function decodeFulfill(input: Hex): { requestId: Hex; proof: OnChainProof; signature: Signature } {
  const [requestId, proof, signature] = decodeFunctionData({ abi: coordinatorAbi, data: input }).args as unknown as [Hex, OnChainProof, Signature];
  return { requestId, proof, signature };
}

/** fulfill calldata for a request, proof and drand signature. */
export function encodeFulfill(requestId: Hex, proof: OnChainProof, signature: Signature): Hex {
  return encodeFunctionData({ abi: coordinatorAbi, functionName: 'fulfill', args: [requestId, proof as never, signature as never] });
}

/** The drand signature a relay publishes for a round, waiting up to `attempts` polls for it. */
export async function drandSignature(relay: string, round: bigint, attempts = 200): Promise<Signature> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${relay}/public/${round}`).catch(() => undefined);
    if (response?.ok) {
      const hex = ((await response.json()) as { signature: string }).signature.replace(/^0x/, '');
      return [BigInt(`0x${hex.slice(0, 64)}`), BigInt(`0x${hex.slice(64, 128)}`)];
    }
    if (attempt + 1 >= attempts) throw new Error(`${relay} has no round ${round}`);
    await sleep(3_000);
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

/** The public explorer page of a transaction, or the bare hash on a private chain. */
export function txLink(chainId: number, hash: Hex): string {
  const custom = process.env.EXPLORER_TX_URL;
  if (custom) return `${custom.replace(/\/$/, '')}/${hash}`;
  if (chainId === 31) return `https://rootstock-testnet.blockscout.com/tx/${hash}`;
  if (chainId === 30) return `https://rootstock.blockscout.com/tx/${hash}`;
  return `${hash} (no public explorer for chain ${chainId})`;
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export type Demo = Awaited<ReturnType<typeof connect>>;

/**
 * Connects with RPC_URL and DEMO_PRIVATE_KEY and reads the coordinator from
 * DEPLOYMENT_FILE (default deployments/<chainId>.json), so a demo runs on any chain
 * the coordinator is deployed to once the key holds faucet funds.
 */
export async function connect(script: string) {
  console.log(BANNER);
  console.log(`rsk-vrf demo: ${script}`);
  const rpcUrl = required('RPC_URL');
  const account = privateKeyToAccount(required('DEMO_PRIVATE_KEY') as Hex);
  const probe = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await probe.getChainId();
  const chain = defineChain({ id: chainId, name: `chain ${chainId}`, nativeCurrency: { name: 'RBTC', symbol: 'RBTC', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const client = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 250, cacheTime: 0 });
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const deploymentFile = process.env.DEPLOYMENT_FILE ?? fileURLToPath(new URL(`deployments/${chainId}.json`, repo));
  const coordinator = coordinatorFromDeployment(readFileSync(deploymentFile, 'utf8'), chainId);
  console.log(`chain ${chainId}, coordinator ${coordinator} (from ${deploymentFile}), sender ${account.address}`);
  // Regtest mines only on request, so there the demo mines its own blocks.
  const regtest = chainId === REGTEST;

  async function nextBlock() {
    if (regtest) await client.request({ method: 'evm_mine' as never, params: [] as never });
    else await sleep(Number(process.env.POLL_MS ?? 10_000));
  }

  async function gasPrice() {
    const quoted = await client.getGasPrice();
    return quoted * 11n / 10n > 1n ? quoted * 11n / 10n : 1n;
  }

  /** Broadcasts a legacy transaction with an explicit gas limit and prints its link. */
  async function broadcast(label: string, tx: { to?: Address; data: Hex; value?: bigint; gas: bigint; nonce?: number }): Promise<Hex> {
    const hash = await wallet.sendTransaction({ to: tx.to ?? null, data: tx.data, value: tx.value ?? 0n, gas: tx.gas, gasPrice: await gasPrice(), type: 'legacy', nonce: tx.nonce } as never);
    console.log(`${label}: ${txLink(chainId, hash)}`);
    return hash;
  }

  /** Waits for a receipt, mining on regtest; reverted receipts are returned, not thrown. */
  async function mined(hash: Hex): Promise<TransactionReceipt> {
    for (;;) {
      const found = await client.getTransactionReceipt({ hash }).catch(() => undefined);
      if (found) return found;
      await nextBlock();
    }
  }

  /** Broadcasts and requires success. */
  async function send(label: string, tx: { to?: Address; data: Hex; value?: bigint; gas: bigint }) {
    const hash = await broadcast(label, tx);
    const receipt = await mined(hash);
    if (receipt.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
    return receipt;
  }

  async function untilBlock(n: bigint) {
    while (await client.getBlockNumber() < n) await nextBlock();
  }

  /** Calls a coordinator view, optionally at a past block. */
  async function read<T = unknown>(functionName: string, args: readonly unknown[] = [], blockNumber?: bigint): Promise<T> {
    return await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName, args, blockNumber } as never) as T;
  }

  /** The coordinator's current fee in wei. */
  const fee = () => read<bigint>('fee');

  /** Has the sender request randomness for a tag with no callback, paying the exact fee. */
  async function request(tag: string): Promise<{ requestId: Hex; receipt: TransactionReceipt }> {
    const data = encodeFunctionData({ abi: coordinatorAbi, functionName: 'request', args: [stringToHex(tag, { size: 32 })] });
    const receipt = await send(`request ${tag}`, { to: coordinator, data, value: await fee(), gas: 400_000n });
    const requestId = requested(receipt);
    console.log(`requestId ${requestId}`);
    return { requestId, receipt };
  }

  async function getRequest(requestId: Hex) {
    return await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [requestId] }) as {
      requester: Address; status: number; callbackGasCap: number; requestBlock: number; drandConfigId: number; fee: bigint;
      targetRound: bigint; deadline: number; confirmations: number; keyId: number; beta: Hex;
    };
  }

  /** The requestId from a receipt's RandomnessRequested event. */
  function requested(receipt: TransactionReceipt): Hex {
    const [event] = parseEventLogs({ abi: coordinatorAbi, logs: receipt.logs, eventName: 'RandomnessRequested' });
    if (!event) throw new Error('No RandomnessRequested event');
    return (event.args as { requestId: Hex }).requestId;
  }

  /** Waits for an operator's worker to fulfill, then returns the request and its fulfill transaction. */
  async function waitFulfilled(requestId: Hex) {
    console.log(`waiting for the operator to fulfill ${requestId}`);
    for (;;) {
      const request = await getRequest(requestId);
      if (request.status === Status.Fulfilled) {
        const logs = await client.getContractEvents({ address: coordinator, abi: coordinatorAbi, eventName: 'Fulfilled', args: { requestId } as never, fromBlock: BigInt(request.requestBlock), toBlock: 'latest' });
        const fulfillTx = logs[0]?.transactionHash;
        if (!fulfillTx) throw new Error(`No Fulfilled event for ${requestId}`);
        console.log(`fulfilled with Beta ${request.beta}: ${txLink(chainId, fulfillTx)}`);
        return { request, fulfillTx, fulfillReceipt: await client.getTransactionReceipt({ hash: fulfillTx }) };
      }
      if (request.status === Status.Refunded) throw new Error(`${requestId} was refunded`);
      if (await client.getBlockNumber() > BigInt(request.deadline)) throw new Error(`${requestId} passed its deadline unfulfilled`);
      await nextBlock();
    }
  }

  /**
   * Replays a mined transaction as a call on its block and decodes the revert. rskj runs
   * such a call with that block's number on its post-state; a reverted transaction left
   * no state behind, so this repeats its checks.
   */
  async function revertOf(hash: Hex): Promise<string> {
    const tx = await client.getTransaction({ hash });
    const receipt = await client.getTransactionReceipt({ hash });
    try {
      await client.request({ method: 'eth_call', params: [{ from: tx.from, to: tx.to!, data: tx.input, gas: `0x${tx.gas.toString(16)}`, value: `0x${tx.value.toString(16)}` }, `0x${receipt.blockNumber.toString(16)}`] });
    } catch (error) {
      return describeRevert(error);
    }
    throw new Error(`${hash} does not revert when replayed`);
  }

  return { chainId, client, wallet, account, coordinator, regtest, nextBlock, broadcast, mined, send, untilBlock, read, fee, request, getRequest, requested, waitFulfilled, revertOf, link: (hash: Hex) => txLink(chainId, hash) };
}

function findRevertData(error: unknown): Hex | undefined {
  for (let cause: unknown = error; cause; cause = (cause as { cause?: unknown }).cause) {
    const raw = (cause as { raw?: unknown }).raw;
    if (typeof raw === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(raw)) return raw as Hex;
    const data = (cause as { data?: unknown }).data;
    if (typeof data === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(data)) return data as Hex;
    if (data && typeof data === 'object' && typeof (data as { data?: unknown }).data === 'string') return (data as { data: Hex }).data;
  }
  return undefined;
}

/** The coordinator error, or the require string, behind a failed call. */
export function describeRevert(error: unknown): string {
  const data = findRevertData(error);
  if (!data) throw new Error(`No revert data: ${String(error)}`);
  const decoded = decodeErrorResult({ abi: coordinatorAbi, data });
  if (decoded.errorName === 'Error') return String(decoded.args?.[0]);
  return decoded.args?.length ? `${decoded.errorName}(${decoded.args.map(String).join(', ')})` : decoded.errorName;
}

/** Prints the machine-readable outcome line and exits cleanly. */
export function result(value: Record<string, unknown>) {
  console.log(`RESULT ${JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`);
}

/** Runs a demo's main and exits nonzero on any failed check. */
export function main(body: () => Promise<void>) {
  body().catch(error => {
    console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  console.log(`ok: ${message}`);
}
