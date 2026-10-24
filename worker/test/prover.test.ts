import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProvingKey } from '../src/proving-key.ts';
import { bytesToHex } from '../src/vrf/bytes.ts';
import { encodeProof } from '../src/vrf/prover.ts';
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
