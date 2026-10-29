// Counts the requests of a deployment that missed their Deadline: those whose Deadline
// is in fromBlock..toBlock and that, at the latest block, are still Pending past it or
// were refunded on the Deadline branch. A Revocation Refund is not a miss. The rule is
// the worker's (deadlineMiss in src/worker.ts), so the count matches its missed_deadline
// pages. Each --exclude <from>-<to> drops the requests whose Deadline is in that
// announced window. Prints one line per miss, the count, and a RESULT line.
// Usage: RPC_URL=<rpc> node demo/missed-deadlines.ts <deployment record> <fromBlock> <toBlock> [--exclude <from>-<to>]...
// LOG_BLOCK_SPAN (default 5000) is the block range of each log read.
// Testnet pilot, not externally audited; do not use for value.
import { readFileSync } from 'node:fs';

import { createPublicClient, http, parseAbiItem, type Hex } from 'viem';

import { coordinatorAbi } from '../src/coordinator.ts';
import { coordinatorFromDeployment } from '../src/deployment.ts';
import { deadlineMiss } from '../src/worker.ts';
import { BANNER, main, result } from './lib.ts';

const USAGE = 'Usage: RPC_URL=<rpc> node demo/missed-deadlines.ts <deployment record> <fromBlock> <toBlock> [--exclude <from>-<to>]...';
const requestedEvent = parseAbiItem('event RandomnessRequested(bytes32 indexed requestId, address indexed requester, bytes32 tag, uint32 keyId, uint64 targetRound, uint48 requestBlock, uint48 deadline, uint96 fee, uint32 callbackGasCap)');
const refundedEvent = parseAbiItem('event Refunded(bytes32 indexed requestId, uint8 reason)');

function block(text: string | undefined): bigint {
  if (!text || !/^\d+$/.test(text)) throw new Error(USAGE);
  return BigInt(text);
}

function range(text: string): [bigint, bigint] {
  const [from, to] = text.split('-');
  const window: [bigint, bigint] = [block(from), block(to)];
  if (window[1] < window[0]) throw new Error(`Window ${text} ends before it starts`);
  return window;
}

main(async () => {
  console.log(BANNER);
  const [file, fromText, toText, ...rest] = process.argv.slice(2);
  const rpcUrl = process.env.RPC_URL;
  if (!file || !rpcUrl) throw new Error(USAGE);
  const fromBlock = block(fromText);
  const toBlock = block(toText);
  if (toBlock < fromBlock) throw new Error(`Range ${fromBlock}..${toBlock} ends before it starts`);
  const excluded: [bigint, bigint][] = [];
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] !== '--exclude' || rest[i + 1] == null) throw new Error(USAGE);
    excluded.push(range(rest[i + 1]!));
  }

  const client = createPublicClient({ transport: http(rpcUrl) });
  const text = readFileSync(file, 'utf8');
  const coordinator = coordinatorFromDeployment(text, await client.getChainId());
  const createdAt = BigInt((JSON.parse(text) as { contracts: { proxy: { block: number } } }).contracts.proxy.block);
  const latest = await client.getBlockNumber();
  const span = BigInt(process.env.LOG_BLOCK_SPAN ?? 5_000);
  const windows = excluded.map(([from, to]) => `${from}..${to}`).join(', ');
  console.log(`coordinator ${coordinator} (from ${file}), Deadlines in blocks ${fromBlock}..${toBlock}${windows ? `, excluding ${windows}` : ''}, at block ${latest}`);

  async function logs<T>(read: (from: bigint, to: bigint) => Promise<T[]>, end: bigint): Promise<T[]> {
    const all: T[] = [];
    for (let start = createdAt; start <= end; start += span) all.push(...await read(start, start + span - 1n < end ? start + span - 1n : end));
    return all;
  }
  // A request is made before its Deadline, so none made after toBlock has one in the range.
  const requested = await logs(
    (from, to) => client.getLogs({ address: coordinator, event: requestedEvent, fromBlock: from, toBlock: to, strict: true }),
    toBlock < latest ? toBlock : latest,
  );
  const refunds = await logs((from, to) => client.getLogs({ address: coordinator, event: refundedEvent, fromBlock: from, toBlock: to, strict: true }), latest);
  const refundReasons = new Map(refunds.map(log => [log.args.requestId, log.args.reason]));

  const missed: { requestId: Hex; deadline: number; outcome: string }[] = [];
  for (const log of requested) {
    const deadline = BigInt(log.args.deadline);
    if (deadline < fromBlock || deadline > toBlock) continue;
    if (excluded.some(([from, to]) => deadline >= from && deadline <= to)) continue;
    const request = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getRequest', args: [log.args.requestId] });
    const outcome = deadlineMiss(request, refundReasons.get(log.args.requestId), latest);
    if (!outcome) continue;
    missed.push({ requestId: log.args.requestId, deadline: request.deadline, outcome });
    console.log(`${log.args.requestId} deadline ${request.deadline} ${outcome}`);
  }
  console.log(`${missed.length} missed Deadline in blocks ${fromBlock}..${toBlock}${windows ? `, excluding ${windows}` : ''}`);
  result({ count: missed.length, fromBlock, toBlock, excluded: excluded.map(([from, to]) => ({ fromBlock: from, toBlock: to })), latest, missed });
});
