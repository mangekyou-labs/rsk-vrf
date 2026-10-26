// Demo: recompute a request's Beta from its on-chain proof and the published inputs,
// without the worker's code. Takes REQUEST_ID, or makes a fresh EOA request.
// With GO_VRF_URL (the Go test relay) it also has Chainlink's Go verifier check the
// proof and compares the Go prover's proof with the one the worker's noble prover sent.
// Unaudited testnet pilot; do not use for value.
import { createHash } from 'node:crypto';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { concat, decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, pad, stringToHex, toHex, type Address, type Hex } from 'viem';

import { check, connect, coordinatorAbi, main, result } from './lib.ts';

const EVMNET_RELAY = 'https://api.drand.sh/04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3';
const word = (n: bigint) => pad(toHex(n), { size: 32 });

interface OnChainProof {
  pk: readonly [bigint, bigint]; gamma: readonly [bigint, bigint]; c: bigint; s: bigint; seed: bigint; uWitness: Address;
  cGammaWitness: readonly [bigint, bigint]; sHashWitness: readonly [bigint, bigint]; zInv: bigint;
}

main(async () => {
  const demo = await connect('recompute-beta');
  const read = (functionName: string, args: unknown[]) => demo.client.readContract({ address: demo.coordinator, abi: coordinatorAbi, functionName, args } as never) as Promise<unknown>;
  let requestId = process.env.REQUEST_ID as Hex | undefined;
  if (!requestId) {
    const fee = await read('fee', []) as bigint;
    const requested = await demo.send('request', { to: demo.coordinator, data: encodeFunctionData({ abi: coordinatorAbi, functionName: 'request', args: [stringToHex('recompute-beta', { size: 32 })] }), value: fee, gas: 400_000n });
    requestId = demo.requested(requested);
    console.log(`requestId ${requestId}`);
  }
  const { request, fulfillTx } = await demo.waitFulfilled(requestId);

  // The published inputs: the fulfill calldata, the request record and the drand beacon.
  const tx = await demo.client.getTransaction({ hash: fulfillTx });
  const { args } = decodeFunctionData({ abi: coordinatorAbi, data: tx.input });
  const [, proof, signature] = args as unknown as [Hex, OnChainProof, readonly [bigint, bigint]];
  const { keyHash } = await read('getProvingKey', [request.keyId]) as { keyHash: Hex };
  check(keccak256(concat([word(proof.pk[0]), word(proof.pk[1])])) === keyHash, 'the proof\'s public key is the request\'s registered key');
  const sig = concat([word(signature[0]), word(signature[1])]);

  const relay = (process.env.DRAND_RELAY_URL ?? EVMNET_RELAY).replace(/\/$/, '');
  const published = await (await fetch(`${relay}/public/${request.targetRound}`)).json() as { signature: string };
  check(`0x${published.signature.replace(/^0x/, '').toLowerCase()}` === sig.toLowerCase(), `the drand signature is the one ${relay} publishes for round ${request.targetRound}`);

  const randomness = `0x${createHash('sha256').update(Buffer.from(sig.slice(2), 'hex')).digest('hex')}` as Hex;
  const alpha = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint64' }, { type: 'bytes32' }],
    [keccak256(stringToHex('rsk-vrf/v1/alpha')), BigInt(demo.chainId), demo.coordinator, request.requester, requestId, request.targetRound, randomness],
  ));
  console.log(`Alpha ${alpha}`);
  secp256k1.Point.fromAffine({ x: proof.gamma[0], y: proof.gamma[1] }).assertValidity();
  const output = keccak256(concat([word(3n), word(proof.gamma[0]), word(proof.gamma[1])]));
  const beta = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [keccak256(stringToHex('rsk-vrf/v1/beta')), output]));
  check(beta === request.beta, `the recomputed Beta ${beta} is the stored Beta`);

  let goVerified: boolean | 'skipped' = 'skipped';
  let proversMatch: boolean | 'skipped' = 'skipped';
  const goUrl = process.env.GO_VRF_URL?.replace(/\/$/, '');
  if (goUrl) {
    // The coordinator ignores proof.seed and proves over its own Alpha, so Alpha goes in its slot.
    const proofBytes = concat([
      ...[...proof.pk, ...proof.gamma, proof.c, proof.s, BigInt(alpha), BigInt(proof.uWitness), ...proof.cGammaWitness, ...proof.sHashWitness, proof.zInv].map(word),
    ]);
    const verified = await (await fetch(`${goUrl}/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proofBytes, registeredKeyHash: keyHash, alpha }) })).json() as { valid: boolean; beta?: Hex };
    goVerified = verified.valid && verified.beta === beta;
    check(goVerified, 'Chainlink\'s Go verifier accepts the proof and derives the same Beta');
    const query = new URLSearchParams({ chainId: String(demo.chainId), round: String(request.targetRound), coordinator: demo.coordinator, requester: request.requester, requestId, context: word(0n) });
    const expected = await (await fetch(`${goUrl}/expected?${query}`)).json() as { alpha: Hex; proofBytes: Hex };
    if (expected.alpha === alpha) {
      proversMatch = expected.proofBytes.toLowerCase() === proofBytes.toLowerCase();
      check(proversMatch, 'the Go prover\'s proof is byte for byte the noble proof the worker sent');
    } else {
      console.log('skipped the prover comparison: the Go helper signs with its own test beacon, not this request\'s');
    }
  } else {
    console.log('skipped the Go cross-check: set GO_VRF_URL to the Go test relay to run it');
  }
  result({ requestId, alpha, beta, goVerified, proversMatch, fulfillTx });
});
