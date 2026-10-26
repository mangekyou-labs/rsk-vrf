// Demo: the coordinator rejects invalid, mismatched and repeated fulfillments. Each one
// is a real transaction with an explicit gas limit, mined and reverted; its error is
// read back by replaying it on its block and must be the error the case expects.
//
// On regtest the Proving Key is the public test key, so the script builds B's own valid
// proof and changes exactly one thing per case. On other chains it has no key, so the
// cases are built from A's proof and are not isolated: the corrupted proofs are also
// over the wrong Alpha. The first failing check is the same either way.
// Unaudited testnet pilot; do not use for value.
import { readFileSync } from 'node:fs';

import type { Hex } from 'viem';

import { ProvingKey } from '../src/proving-key.ts';
import { alphaOf, check, connect, decodeFulfill, drandRelay, drandSignature, encodeFulfill, main, result, Status, type OnChainProof, type Signature } from './lib.ts';

// Ample for a full proof check; a rejection must fail on its check, not run out of gas.
const REJECTION_GAS_LIMIT = 1_000_000n;

/** The error each case must revert with: the first check it fails. */
const EXPECTED = {
  'corrupted gamma': 'gamma is not on curve',
  'corrupted s': 'addr(c*pk+s*g)!=_uWitness',
  "A's proof on B": 'Second mul check failed',
  'wrong drand round': 'InvalidDrandSignature',
  'repeat on Fulfilled A': 'RequestNotPending(2)',
} as const;
type Case = keyof typeof EXPECTED;

/** The public test key the regtest worker proves with (tools/vrf-vectors-go). */
function regtestKey(): ProvingKey {
  const fixture = JSON.parse(readFileSync(new URL('../../tools/vrf-vectors-go/coordinator-vectors.json', import.meta.url), 'utf8'));
  return ProvingKey.fromHex(fixture.vectors[0].vrf.secretKey);
}

main(async () => {
  const demo = await connect('rejections');
  const relay = drandRelay();

  // Request A, and take its proof from the operator's fulfillment.
  const { requestId: requestIdA } = await demo.request('rejections A');
  const a = await demo.waitFulfilled(requestIdA);
  const fulfillA = await demo.client.getTransaction({ hash: a.fulfillTx });
  const { proof: proofA } = decodeFulfill(fulfillA.input);

  // Request B, still Pending while the rejections land.
  const { requestId: requestIdB } = await demo.request('rejections B');
  const b = await demo.getRequest(requestIdB);
  const signatureB = await drandSignature(relay, b.targetRound);
  const signatureEarlier = await drandSignature(relay, b.targetRound - 1n);

  // B's own valid proof, when this chain's Proving Key is the public test key.
  let proofB: OnChainProof | undefined;
  if (demo.regtest) {
    const key = regtestKey();
    const { keyHash } = await demo.read<{ keyHash: Hex }>('getProvingKey', [b.keyId]);
    if (key.keyHash.toLowerCase() === keyHash.toLowerCase()) {
      const alphaB = alphaOf({ chainId: demo.chainId, coordinator: demo.coordinator, requester: b.requester, requestId: requestIdB, targetRound: b.targetRound, signature: signatureB });
      const { proof } = key.prove(BigInt(alphaB));
      proofB = { ...proof, uWitness: proof.uWitness as `0x${string}` };
    }
  }
  const isolated = proofB !== undefined;
  if (isolated) {
    console.log('isolated: each case is B\'s valid fulfillment with one thing changed');
  } else {
    console.log('not isolated: no Proving Key on this chain, so the cases are built from A\'s proof (the first failing check is the same)');
  }
  const base = proofB ?? proofA;
  const data: Record<Case, Hex> = {
    'corrupted gamma': encodeFulfill(requestIdB, { ...base, gamma: [base.gamma[0] + 1n, base.gamma[1]] }, signatureB),
    'corrupted s': encodeFulfill(requestIdB, { ...base, s: base.s + 1n }, signatureB),
    "A's proof on B": encodeFulfill(requestIdB, proofA, signatureB),
    'wrong drand round': encodeFulfill(requestIdB, base, signatureEarlier as Signature),
    'repeat on Fulfilled A': fulfillA.input,
  };

  // Broadcast one block before B becomes Fulfillable, so they land in its first
  // Fulfillable block, before the operator's worker sends its own fulfillment. On
  // regtest the script mines that block itself; on a live chain the worker can win the
  // race, which the script detects below.
  const firstFulfillableBlock = BigInt(b.requestBlock) + BigInt(b.confirmations);
  await demo.untilBlock(firstFulfillableBlock - 1n);
  const raced = () => new Error('the operator\'s worker fulfilled B before the rejections landed, so they would not test what they claim; rerun rejections');
  if ((await demo.getRequest(requestIdB)).status !== Status.Pending) throw raced();
  const nonce = await demo.client.getTransactionCount({ address: demo.account.address, blockTag: 'pending' });
  const sent: { case: Case; tx: Hex }[] = [];
  for (const [i, name] of (Object.keys(EXPECTED) as Case[]).entries()) {
    sent.push({ case: name, tx: await demo.broadcast(name, { to: demo.coordinator, data: data[name], gas: REJECTION_GAS_LIMIT, nonce: nonce + i }) });
  }
  const receipts = await Promise.all(sent.map(item => demo.mined(item.tx)));

  const fulfilledB = await demo.waitFulfilled(requestIdB);
  check(fulfilledB.request.status === Status.Fulfilled, 'B is still fulfilled by the operator afterwards');
  if (receipts.some(receipt => receipt.blockNumber >= fulfilledB.fulfillReceipt.blockNumber)) throw raced();

  const rejections: { case: Case; tx: Hex; expected: string; error: string }[] = [];
  for (const [i, item] of sent.entries()) {
    const receipt = receipts[i]!;
    check(receipt.status === 'reverted', `${item.case}: mined in block ${receipt.blockNumber} and reverted`);
    check(receipt.gasUsed < REJECTION_GAS_LIMIT, `${item.case}: used ${receipt.gasUsed} of its ${REJECTION_GAS_LIMIT} gas, so it failed its check, not out of gas`);
    check(receipt.blockNumber >= firstFulfillableBlock, `${item.case}: landed while B was Fulfillable and Pending`);
    const error = await demo.revertOf(item.tx);
    check(error === EXPECTED[item.case], `${item.case}: reverted with ${error} (expected ${EXPECTED[item.case]})`);
    rejections.push({ ...item, expected: EXPECTED[item.case], error });
  }
  result({ requestIdA, requestIdB, fulfillTxA: a.fulfillTx, fulfillTxB: fulfilledB.fulfillTx, isolated, rejections });
});
