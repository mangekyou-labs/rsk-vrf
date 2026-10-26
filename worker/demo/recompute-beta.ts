// Demo: recompute a request's Beta from its on-chain proof and the published inputs,
// without the worker's code. Takes REQUEST_ID, or makes a fresh EOA request.
// On every chain it verifies the proof (Gamma, c, s) over the recomputed Alpha and the
// Proving Key's public key with its own ECVRF verifier (./ecvrf.ts, @noble primitives),
// then derives Beta from Gamma. With GO_VRF_URL (the Go test relay) it also has
// Chainlink's Go verifier check the proof and compares the Go prover's proof with the
// one the worker's noble prover sent.
// Unaudited testnet pilot; do not use for value.
import { concat, encodeAbiParameters, keccak256, pad, stringToHex, toHex, type Hex } from 'viem';

import { verify } from './ecvrf.ts';
import { alphaOf, check, connect, decodeFulfill, drandRelay, drandSignature, main, result } from './lib.ts';

const word = (n: bigint) => pad(toHex(n), { size: 32 });

main(async () => {
  const demo = await connect('recompute-beta');
  const requestId = (process.env.REQUEST_ID as Hex | undefined) ?? (await demo.request('recompute-beta')).requestId;
  const { request, fulfillTx } = await demo.waitFulfilled(requestId);

  // The published inputs: the fulfill calldata, the request record and the drand beacon.
  const { proof, signature } = decodeFulfill((await demo.client.getTransaction({ hash: fulfillTx })).input);
  const { keyHash } = await demo.read<{ keyHash: Hex }>('getProvingKey', [request.keyId]);
  check(keccak256(concat([word(proof.pk[0]), word(proof.pk[1])])) === keyHash, 'the proof\'s public key is the request\'s registered key');

  const relay = drandRelay();
  const published = await drandSignature(relay, request.targetRound, 1);
  check(published[0] === signature[0] && published[1] === signature[1], `the drand signature is the one ${relay} publishes for round ${request.targetRound}`);

  const alpha = alphaOf({ chainId: demo.chainId, coordinator: demo.coordinator, requester: request.requester, requestId, targetRound: request.targetRound, signature });
  console.log(`Alpha ${alpha}`);
  const verified = verify(proof, BigInt(alpha));
  const proofVerified = verified.valid;
  check(verified.valid, 'the proof (Gamma, c, s) verifies over the recomputed Alpha and the Proving Key\'s public key');
  const beta = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [keccak256(stringToHex('rsk-vrf/v1/beta')), word(verified.output)]));
  check(beta === request.beta, `the Beta derived from Gamma, ${beta}, is the stored Beta`);

  let goVerified: boolean | 'skipped' = 'skipped';
  let proversMatch: boolean | 'skipped' = 'skipped';
  const goUrl = process.env.GO_VRF_URL?.replace(/\/$/, '');
  if (goUrl) {
    // The coordinator ignores proof.seed and proves over its own Alpha, so Alpha goes in its slot.
    const proofBytes = concat([
      ...[...proof.pk, ...proof.gamma, proof.c, proof.s, BigInt(alpha), BigInt(proof.uWitness), ...proof.cGammaWitness, ...proof.sHashWitness, proof.zInv].map(word),
    ]);
    const go = await (await fetch(`${goUrl}/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proofBytes, registeredKeyHash: keyHash, alpha }) })).json() as { valid: boolean; beta?: Hex };
    goVerified = go.valid && go.beta === beta;
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
  result({ requestId, alpha, beta, proofVerified, goVerified, proversMatch, fulfillTx });
});
