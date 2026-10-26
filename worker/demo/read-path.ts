// Demo: an EOA requests randomness with no callback and reads it back through the
// coordinator's derive views. Unaudited testnet pilot; do not use for value.
import { encodeFunctionData, stringToHex, type Hex } from 'viem';

import { check, connect, coordinatorAbi, describeRevert, main, result } from './lib.ts';

main(async () => {
  const demo = await connect('read-path');
  const read = (functionName: string, args: unknown[]) => demo.client.readContract({ address: demo.coordinator, abi: coordinatorAbi, functionName, args } as never) as Promise<unknown>;
  const fee = await read('fee', []) as bigint;
  const requested = await demo.send('request', { to: demo.coordinator, data: encodeFunctionData({ abi: coordinatorAbi, functionName: 'request', args: [stringToHex('read-path', { size: 32 })] }), value: fee, gas: 400_000n });
  const requestId = demo.requested(requested);
  console.log(`requestId ${requestId}`);

  // Each consumer names its own context, so one Beta yields independent values.
  const context = stringToHex('rsk-vrf/demo/read-path', { size: 32 });
  let pendingRevert = '';
  try { await read('deriveRandomBytes', [requestId, context]); } catch (error) { pendingRevert = describeRevert(error); }
  check(pendingRevert === 'RequestPending', `the derive views refuse a Pending request (${pendingRevert || 'no revert'})`);

  const { request, fulfillTx } = await demo.waitFulfilled(requestId);
  check(request.requester === demo.account.address && request.callbackGasCap === 0, 'the EOA is the requester and there is no callback');
  const randomBytes = await read('deriveRandomBytes', [requestId, context]) as Hex;
  const random = await read('deriveRandom', [requestId, context]) as bigint;
  const inRange = await read('deriveRandomInRange', [requestId, context, 1n, 100n]) as bigint;
  check(random === BigInt(randomBytes), 'deriveRandom is deriveRandomBytes as a uint256');
  check(inRange >= 1n && inRange <= 100n, `deriveRandomInRange(1, 100) = ${inRange}`);
  console.log(`deriveRandomBytes ${randomBytes}`);
  result({ requestId, beta: request.beta, context, randomBytes, random, inRange, pendingRevert, requestTx: requested.transactionHash, fulfillTx });
});
