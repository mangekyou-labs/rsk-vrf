import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { verify } from '../demo/ecvrf.ts';
import { vectors } from './vectors.ts';

// The recompute-beta demo's own ECVRF verifier, checked against the proofs Chainlink's
// Go prover generates (tools/vrf-vectors-go), not against the worker's prover.
const pair = (xy: readonly [`0x${string}`, `0x${string}`]) => [BigInt(xy[0]), BigInt(xy[1])] as const;
const proofOf = (v: (typeof vectors)[number]) => ({
  pk: pair(v.proof.pk), gamma: pair(v.proof.gamma), c: BigInt(v.proof.c), s: BigInt(v.proof.s), uWitness: v.proof.uWitness,
});

describe('demo ECVRF verify', () => {
  for (const v of vectors) {
    it(`accepts the Go proof and gives the Go output: ${v.name}`, () => {
      assert.deepEqual(verify(proofOf(v), BigInt(v.proof.seed)), { valid: true, output: BigInt(v.output) });
    });
  }

  const v = vectors[0]!;
  const proof = proofOf(v);
  const alpha = BigInt(v.proof.seed);
  const cases = {
    'another Alpha': [proof, alpha + 1n],
    'a corrupted s': [{ ...proof, s: proof.s + 1n }, alpha],
    'a corrupted c': [{ ...proof, c: proof.c + 1n }, alpha],
    'a Gamma off the curve': [{ ...proof, gamma: [proof.gamma[0] + 1n, proof.gamma[1]] as const }, alpha],
    'another valid point as Gamma': [{ ...proof, gamma: proofOf(vectors[1]!).gamma }, alpha],
    'a uWitness for another proof': [{ ...proof, uWitness: vectors[1]!.proof.uWitness }, alpha],
  } as const;
  for (const [name, [bad, over]] of Object.entries(cases)) {
    it(`rejects ${name}`, () => {
      assert.equal(verify(bad, over).valid, false);
    });
  }
});
