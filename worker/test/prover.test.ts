import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { secp256k1 } from '@noble/curves/secp256k1.js';

import { ProvingKey } from '../src/proving-key.ts';
import { bytesToHex } from '../src/vrf/bytes.ts';
import { encodeProof, projectiveECAddZ } from '../src/vrf/prover.ts';
import { SECRET_HEX } from './keys.ts';
import { vectors } from './vectors.ts';

const pair = (xy: readonly [`0x${string}`, `0x${string}`]) => [BigInt(xy[0]), BigInt(xy[1])];

describe('ProvingKey.prove', () => {
  for (const v of vectors) {
    it(`matches Chainlink's Go prover byte for byte: ${v.name} (${v.hashToCurveTries} tries)`, () => {
      const key = ProvingKey.fromHex(v.secretKey);
      const { proof, beta } = key.prove(BigInt(v.proof.seed));

      assert.deepEqual([...proof.pk], pair(v.proof.pk), 'pk');
      assert.deepEqual([...proof.gamma], pair(v.proof.gamma), 'gamma');
      assert.equal(proof.c, BigInt(v.proof.c), 'c');
      assert.equal(proof.s, BigInt(v.proof.s), 's');
      assert.equal(proof.seed, BigInt(v.proof.seed), 'seed');
      assert.equal(proof.uWitness, v.proof.uWitness, 'uWitness');
      assert.deepEqual([...proof.cGammaWitness], pair(v.proof.cGammaWitness), 'cGammaWitness');
      assert.deepEqual([...proof.sHashWitness], pair(v.proof.sHashWitness), 'sHashWitness');
      assert.equal(proof.zInv, BigInt(v.proof.zInv), 'zInv');
      assert.equal(bytesToHex(encodeProof(proof)), v.proofBytes, 'proofBytes');
      assert.equal(beta, BigInt(v.output), 'Beta');
    });
  }

  it('is deterministic', () => {
    const key = ProvingKey.fromHex(SECRET_HEX);
    assert.deepEqual(key.prove(42n), key.prove(42n));
  });

  it('rejects an Alpha that is not a 256-bit word', () => {
    const key = ProvingKey.fromHex(SECRET_HEX);
    assert.throws(() => key.prove(-1n), RangeError);
    assert.throws(() => key.prove(1n << 256n), RangeError);
  });
});

describe('ProvingKey identity', () => {
  it('exposes the public key and keyHash = keccak256(abi.encode(pk))', () => {
    const v = vectors.find((v) => v.name === 'key0-seed-zero')!;
    const key = ProvingKey.fromHex(v.secretKey);
    assert.deepEqual([...key.publicKey], pair(v.proof.pk));
    // From `cast keccak` over the abi-encoded uint256[2] public key.
    assert.equal(key.keyHash, '0x70e92af3877bf8b9a69ccd59c26a7f2275b1469f3f0d8f4546c01823ca1a9907');
  });
});

// zInv is the inverse of the z VRF.sol's _projectiveECAdd computes for
// cGammaWitness + sHashWitness. The Go vectors pin the dx != dy case; these
// pin the dx == dy branch, where VRF.sol uses z = dx.
describe('projectiveECAddZ', () => {
  const { Point } = secp256k1;
  const { Fp } = Point;
  const pointAt = (x: bigint) => {
    const y2 = Fp.add(Fp.pow(x, 3n), 7n);
    return Fp.pow(y2, (Fp.ORDER - 1n) / 2n) === 1n ? Point.fromAffine({ x, y: Fp.sqrt(y2) }) : undefined;
  };

  it('is 1 when qx - px = 1 (dx == dy == 1)', () => {
    let x = 1n;
    while (!pointAt(x) || !pointAt(x + 1n)) x++;
    assert.equal(projectiveECAddZ(pointAt(x)!, pointAt(x + 1n)!), 1n);
  });

  it('is 0 when the points share x (dx == dy == 0)', () => {
    assert.equal(projectiveECAddZ(Point.BASE, Point.BASE.negate()), 0n);
  });
});
