import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

import { composeFulfillment } from '../src/coordinator.ts';
import { ProvingKey } from '../src/proving-key.ts';
import { bytesToHex } from '../src/vrf/bytes.ts';
import { encodeProof } from '../src/vrf/prover.ts';

const golden = JSON.parse(readFileSync(new URL('../../tools/vrf-vectors-go/coordinator-vectors.json', import.meta.url), 'utf8'));

for (const v of golden.vectors) {
  it(`composes Alpha, full proof and Beta from coordinator golden vector: ${v.name}`, () => {
    const key = ProvingKey.fromHex(v.vrf.secretKey);
    const signature = `0x${v.drandSignature.map((s: string) => s.slice(2)).join('')}` as const;
    const got = composeFulfillment({ chainId: BigInt(v.chainId), coordinator: v.coordinator, requester: v.requester,
      requestId: v.requestId, targetRound: BigInt(v.targetRound), signature }, key);
    assert.equal(got.alpha, v.alpha);
    assert.equal(bytesToHex(encodeProof(got.proof)), v.vrf.proofBytes);
    assert.equal(got.beta, v.beta);
  });
}
