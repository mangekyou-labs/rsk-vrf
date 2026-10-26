// Demo: an EOA requests randomness with no callback and reads it back through the
// coordinator's derive views. Unaudited testnet pilot; do not use for value.
import { stringToHex, type Hex } from 'viem';

import { check, connect, describeRevert, main, result } from './lib.ts';

main(async () => {
  const demo = await connect('read-path');
  const { requestId, receipt: requested } = await demo.request('read-path');

  // Each consumer picks its own Derivation Context, so one Beta yields independent values.
  const context = stringToHex('rsk-vrf/demo/read-path', { size: 32 });
  let pendingRevert = '';
  try { await demo.read('deriveRandomBytes', [requestId, context]); } catch (error) { pendingRevert = describeRevert(error); }
  check(pendingRevert === 'RequestPending', `the derive views refuse a Pending request (${pendingRevert || 'no revert'})`);

  const { request, fulfillTx } = await demo.waitFulfilled(requestId);
  check(request.requester === demo.account.address && request.callbackGasCap === 0, 'the EOA is the requester and there is no callback');
  const randomBytes = await demo.read<Hex>('deriveRandomBytes', [requestId, context]);
  const random = await demo.read<bigint>('deriveRandom', [requestId, context]);
  const inRange = await demo.read<bigint>('deriveRandomInRange', [requestId, context, 1n, 100n]);
  check(random === BigInt(randomBytes), 'deriveRandom is deriveRandomBytes as a uint256');
  check(inRange >= 1n && inRange <= 100n, `deriveRandomInRange(1, 100) = ${inRange}`);
  console.log(`deriveRandomBytes ${randomBytes}`);
  result({ requestId, beta: request.beta, context, randomBytes, random, inRange, pendingRevert, requestTx: requested.transactionHash, fulfillTx });
});
