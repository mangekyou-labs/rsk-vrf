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
    assert.equal(got.hashToCurveTries, v.vrf.hashToCurveTries);
    assert.equal(got.alpha, v.alpha);
    assert.equal(bytesToHex(encodeProof(got.proof)), v.vrf.proofBytes);
    assert.equal(got.beta, v.beta);
  });
}

// A deterministic search found this input after 2911 candidates. At the spec's
// 507k one-try bound + 15k per additional try, 14 tries need 702k verification
// gas: beyond the former fixed 642k allowance, before callback cap or reserve.
it('retains verification work for a 14-try proof beyond the old fixed allowance', () => {
  const v = golden.vectors[0];
  const got = composeFulfillment({ chainId: BigInt(v.chainId), coordinator: v.coordinator, requester: v.requester,
    requestId: '0x0000000000000000000000000000000000000000000000000000000000000b5f',
    targetRound: BigInt(v.targetRound), signature: `0x${v.drandSignature.map((s: string) => s.slice(2)).join('')}` }, ProvingKey.fromHex(v.vrf.secretKey));
  assert.equal(got.hashToCurveTries, 14);
  assert.equal(got.alpha, '0xc306aec444d24bbaee5c8e0099fe625e6be858523e2f8fefaca5f0c3994a28d2');
  assert.equal(got.beta, '0x4bacde2f6d86f03518ee3092da0a7e440c8ebbe3cf7b243819c970d9c35381ba');
});
