// Demo: a consumer contract rolls a die. Its callback stores the verified Beta and the
// face comes from the coordinator's deriveRandomInRange(1, 6).
// Unaudited testnet pilot; do not use for value.
import { encodeDeployData, encodeFunctionData, parseEventLogs, stringToHex, type Address, type Hex } from 'viem';

import { artifact, check, connect, main, result } from './lib.ts';

main(async () => {
  const demo = await connect('dice');
  const dice = artifact('DemoDice');
  const deployed = await demo.send('deploy DemoDice', { data: encodeDeployData({ abi: dice.abi, bytecode: dice.bytecode, args: [demo.coordinator] }), gas: 1_500_000n });
  const address = deployed.contractAddress as Address;
  console.log(`DemoDice at ${address}`);

  const fee = await demo.fee();
  const rolled = await demo.send('roll', { to: address, data: encodeFunctionData({ abi: dice.abi, functionName: 'roll', args: [stringToHex('dice', { size: 32 })] }), value: fee, gas: 500_000n });
  const requestId = demo.requested(rolled);
  console.log(`requestId ${requestId}`);

  const { request, fulfillTx, fulfillReceipt } = await demo.waitFulfilled(requestId);
  const stored = await demo.client.readContract({ address, abi: dice.abi, functionName: 'betaOf', args: [requestId] }) as Hex;
  check(stored === request.beta, 'the callback stored the coordinator\'s Beta');
  const events = parseEventLogs({ abi: dice.abi, logs: fulfillReceipt.logs, eventName: 'Rolled' });
  check(events.length === 1, 'DemoDice emitted Rolled inside the fulfill transaction');
  const context = await demo.client.readContract({ address, abi: dice.abi, functionName: 'ROLL_CONTEXT' }) as Hex;
  const face = await demo.client.readContract({ address, abi: dice.abi, functionName: 'face', args: [requestId] }) as bigint;
  const derived = await demo.read<bigint>('deriveRandomInRange', [requestId, context, 1n, 6n]);
  check(face >= 1n && face <= 6n, `the face ${face} is between 1 and 6`);
  check(face === derived, 'the face equals deriveRandomInRange(requestId, ROLL_CONTEXT, 1, 6)');
  console.log(`rolled a ${face}`);
  result({ dice: address, requestId, beta: request.beta, face, deployTx: deployed.transactionHash, requestTx: rolled.transactionHash, fulfillTx });
});
