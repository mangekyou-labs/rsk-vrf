// Demo: the coordinator rejects invalid, mismatched and repeated fulfillments. Each one
// is a real transaction with an explicit gas limit, mined and reverted, and its error is
// read back by replaying it on its block.
// Unaudited testnet pilot; do not use for value.
import { decodeFunctionData, encodeFunctionData, stringToHex, type Address, type Hex } from 'viem';

import { check, connect, coordinatorAbi, main, result, sleep, Status } from './lib.ts';

const EVMNET_RELAY = 'https://api.drand.sh/04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3';
// Ample for a full proof check; a rejection must fail on its check, not run out of gas.
const GAS = 1_000_000n;

interface OnChainProof {
  pk: readonly [bigint, bigint]; gamma: readonly [bigint, bigint]; c: bigint; s: bigint; seed: bigint; uWitness: Address;
  cGammaWitness: readonly [bigint, bigint]; sHashWitness: readonly [bigint, bigint]; zInv: bigint;
}
type Signature = readonly [bigint, bigint];

main(async () => {
  const demo = await connect('rejections');
  const relay = (process.env.DRAND_RELAY_URL ?? EVMNET_RELAY).replace(/\/$/, '');
  const fee = await demo.client.readContract({ address: demo.coordinator, abi: coordinatorAbi, functionName: 'fee' }) as bigint;
  const request = async (tag: string) => demo.requested(await demo.send(`request ${tag}`, { to: demo.coordinator, data: encodeFunctionData({ abi: coordinatorAbi, functionName: 'request', args: [stringToHex(tag, { size: 32 })] }), value: fee, gas: 400_000n }));

  /** The drand signature of a round, waiting until the relay publishes it. */
  async function drandSignature(round: bigint): Promise<Signature> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${relay}/public/${round}`).catch(() => undefined);
      if (response?.ok) {
        const hex = ((await response.json()) as { signature: string }).signature.replace(/^0x/, '');
        return [BigInt(`0x${hex.slice(0, 64)}`), BigInt(`0x${hex.slice(64, 128)}`)];
      }
      if (attempt > 200) throw new Error(`${relay} has no round ${round}`);
      await sleep(3_000);
    }
  }

  // Request A, and take its proof from the operator's fulfillment.
  const requestIdA = await request('rejections A');
  const a = await demo.waitFulfilled(requestIdA);
  const fulfillA = await demo.client.getTransaction({ hash: a.fulfillTx });
  const [, proofA] = decodeFunctionData({ abi: coordinatorAbi, data: fulfillA.input }).args as unknown as [Hex, OnChainProof, Signature];

  // Request B, still Pending while the rejections land.
  const requestIdB = await request('rejections B');
  const b = await demo.getRequest(requestIdB);
  const signatureB = await drandSignature(b.targetRound);
  const signatureEarlier = await drandSignature(b.targetRound - 1n);
  const fulfill = (requestId: Hex, proof: OnChainProof, signature: Signature) => encodeFunctionData({ abi: coordinatorAbi, functionName: 'fulfill', args: [requestId, proof as never, signature as never] });
  const cases: { case: string; data: Hex }[] = [
    { case: 'corrupted gamma', data: fulfill(requestIdB, { ...proofA, gamma: [proofA.gamma[0] + 1n, proofA.gamma[1]] }, signatureB) },
    { case: 'corrupted s', data: fulfill(requestIdB, { ...proofA, s: proofA.s + 1n }, signatureB) },
    { case: "A's proof on B", data: fulfill(requestIdB, proofA, signatureB) },
    { case: 'wrong drand round', data: fulfill(requestIdB, proofA, signatureEarlier) },
    { case: 'repeat on Fulfilled A', data: fulfillA.input },
  ];

  // Broadcast one block before B may be fulfilled, so they land in its first eligible
  // block, before the operator's worker sends its own fulfillment. On regtest the script
  // mines that block itself; on a live chain this race is best-effort.
  const eligible = BigInt(b.requestBlock) + BigInt(b.confirmations);
  await demo.untilBlock(eligible - 1n);
  const nonce = await demo.client.getTransactionCount({ address: demo.account.address, blockTag: 'pending' });
  const sent: { case: string; tx: Hex }[] = [];
  for (const [i, item] of cases.entries()) {
    sent.push({ case: item.case, tx: await demo.broadcast(item.case, { to: demo.coordinator, data: item.data, gas: GAS, nonce: nonce + i }) });
  }

  const rejections: { case: string; tx: Hex; error: string }[] = [];
  for (const item of sent) {
    const receipt = await demo.mined(item.tx);
    check(receipt.status === 'reverted', `${item.case}: mined in block ${receipt.blockNumber} and reverted`);
    check(receipt.gasUsed < GAS, `${item.case}: used ${receipt.gasUsed} of its ${GAS} gas, so it failed its check, not out of gas`);
    const error = await demo.revertOf(item.tx);
    console.log(`${item.case}: ${error}`);
    rejections.push({ ...item, error });
  }

  const fulfilledB = await demo.waitFulfilled(requestIdB);
  check(fulfilledB.request.status === Status.Fulfilled, 'B is still fulfilled by the operator afterwards');
  for (const item of sent) {
    const receipt = await demo.client.getTransactionReceipt({ hash: item.tx });
    check(receipt.blockNumber >= eligible && receipt.blockNumber < fulfilledB.fulfillReceipt.blockNumber, `${item.case}: landed while B was eligible and Pending`);
  }
  result({ requestIdA, requestIdB, fulfillTxA: a.fulfillTx, fulfillTxB: fulfilledB.fulfillTx, rejections });
});
