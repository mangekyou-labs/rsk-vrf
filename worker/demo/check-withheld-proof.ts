// Checks the withheld proof that a missed Deadline Incident Note publishes, without the
// worker's code. Takes a file with the missed_deadline page or log line, or only its
// `proof` object. Against the chain at RPC_URL it checks that the proof is for the
// on-chain request and its registered Proving Key, that the drand signature is the one
// DRAND_RELAY_URL (default: the evmnet relay) publishes for the target round, that the
// ECVRF proof verifies over the recomputed Alpha (./ecvrf.ts), and that Beta follows.
// Usage: RPC_URL=<rpc> node demo/check-withheld-proof.ts <file>
// Testnet pilot, not externally audited; do not use for value.
import { readFileSync } from 'node:fs';

import { createPublicClient, getAddress, http, type Address, type Hex } from 'viem';

import { alphaOf, betaOf, keyHashOf } from './derive.ts';
import { verify } from './ecvrf.ts';
import { BANNER, Status, check, coordinatorAbi, drandRelay, drandSignature, main, result } from './lib.ts';

interface Published {
  chainId: string; coordinator: Address; requester: Address; requestId: Hex; targetRound: string; signature: Hex;
  keyHash: Hex; keyId: number; drandConfigId: number; alpha: Hex; beta: Hex;
  proof: { pk: string[]; gamma: string[]; c: string; s: string; uWitness: string };
}

const pair = (values: string[]) => [BigInt(values[0]!), BigInt(values[1]!)] as const;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

main(async () => {
  console.log(BANNER);
  const file = process.argv[2];
  const rpcUrl = process.env.RPC_URL;
  if (!file || !rpcUrl) throw new Error('Usage: RPC_URL=<rpc> node demo/check-withheld-proof.ts <file>');
  // The page and the log line hold the publication under `proof`; the publication holds the ECVRF proof under `proof`.
  const json = JSON.parse(readFileSync(file, 'utf8')) as { proof?: unknown };
  const published = (typeof json.proof === 'object' && json.proof !== null && 'alpha' in json.proof ? json.proof : json) as Published;
  const client = createPublicClient({ transport: http(rpcUrl) });
  const coordinator = getAddress(published.coordinator);
  const read = <T>(functionName: string, args: unknown[]) => client.readContract({ address: coordinator, abi: coordinatorAbi, functionName, args }) as Promise<T>;
  console.log(`request ${published.requestId}, keyHash ${published.keyHash}, coordinator ${coordinator}`);

  check(BigInt(await client.getChainId()) === BigInt(published.chainId), `RPC_URL is chain ${published.chainId}`);
  const request = await read<{ requester: Address; status: number; targetRound: bigint; deadline: number; keyId: number; drandConfigId: number }>('getRequest', [published.requestId]);
  check(request.status !== Status.None, 'the request exists on chain');
  check(same(request.requester, published.requester) && request.targetRound === BigInt(published.targetRound)
    && request.keyId === Number(published.keyId) && request.drandConfigId === Number(published.drandConfigId),
  'the requester, target round, keyId and drand config are those of the on-chain request');
  check(request.status !== Status.Fulfilled, 'the request was not fulfilled');
  check(await client.getBlockNumber() > BigInt(request.deadline), `the Deadline, block ${request.deadline}, has passed`);

  const proof = { pk: pair(published.proof.pk), gamma: pair(published.proof.gamma), c: BigInt(published.proof.c), s: BigInt(published.proof.s), uWitness: published.proof.uWitness };
  const { keyHash } = await read<{ keyHash: Hex }>('getProvingKey', [request.keyId]);
  check(same(keyHash, published.keyHash) && same(keyHashOf(proof.pk), keyHash),
    `the proof's public key is the registered Proving Key ${request.keyId} of the request`);

  const relay = drandRelay();
  const signature = pair([`0x${published.signature.slice(2, 66)}`, `0x${published.signature.slice(66, 130)}`]);
  const relayed = await drandSignature(relay, request.targetRound, 3);
  check(relayed[0] === signature[0] && relayed[1] === signature[1], `the drand signature is the one ${relay} publishes for round ${request.targetRound}`);

  const alpha = alphaOf({ chainId: Number(published.chainId), coordinator, requester: request.requester, requestId: published.requestId, targetRound: request.targetRound, signature });
  check(same(alpha, published.alpha), `Alpha is ${alpha}`);
  const verified = verify(proof, BigInt(alpha));
  check(verified.valid, 'the proof (Gamma, c, s) verifies over Alpha and the Proving Key');
  const beta = betaOf(verified.output);
  check(same(beta, published.beta), `Beta is ${beta}`);
  result({ valid: true, requestId: published.requestId, keyHash, beta, status: request.status === Status.Refunded ? 'Refunded' : 'Pending' });
});
