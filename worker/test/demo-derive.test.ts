import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

import { alphaOf, betaOf } from '../demo/derive.ts';

// The demo scripts' own Alpha and Beta derivation, checked against the Go-generated
// coordinator vectors (tools/vrf-vectors-go), not against the worker's code.
const golden = JSON.parse(readFileSync(new URL('../../tools/vrf-vectors-go/coordinator-vectors.json', import.meta.url), 'utf8'));

for (const v of golden.vectors) {
  it(`derives the golden Alpha and Beta: ${v.name}`, () => {
    const signature = [BigInt(v.drandSignature[0]), BigInt(v.drandSignature[1])] as const;
    assert.equal(alphaOf({ chainId: v.chainId, coordinator: v.coordinator, requester: v.requester, requestId: v.requestId, targetRound: BigInt(v.targetRound), signature }), v.alpha);
    assert.equal(betaOf(BigInt(v.vrf.output)), v.beta);
  });
}
