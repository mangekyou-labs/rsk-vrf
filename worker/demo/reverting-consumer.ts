// Demo: a consumer whose callback always reverts. The coordinator records
// CallbackFailed, yet the request is Fulfilled and the fee settles to the Payee.
// Unaudited testnet pilot; do not use for value.
import { encodeDeployData, encodeFunctionData, parseEventLogs, stringToHex, type Address } from 'viem';

import { artifact, check, connect, coordinatorAbi, main, result, Status } from './lib.ts';

main(async () => {
  const demo = await connect('reverting-consumer');
  const read = (functionName: string, args: unknown[], blockNumber?: bigint) => demo.client.readContract({ address: demo.coordinator, abi: coordinatorAbi, functionName, args, blockNumber } as never) as Promise<unknown>;
  const consumer = artifact('RevertingConsumer');
  const deployed = await demo.send('deploy RevertingConsumer', { data: encodeDeployData({ abi: consumer.abi, bytecode: consumer.bytecode, args: [demo.coordinator] }), gas: 1_000_000n });
  const address = deployed.contractAddress as Address;
  console.log(`RevertingConsumer at ${address}`);

  const fee = await read('fee', []) as bigint;
  const requested = await demo.send('request', { to: address, data: encodeFunctionData({ abi: consumer.abi, functionName: 'request', args: [stringToHex('reverting', { size: 32 })] }), value: fee, gas: 500_000n });
  const requestId = demo.requested(requested);
  console.log(`requestId ${requestId}`);
  const { keyId } = await demo.getRequest(requestId);
  const { payee } = await read('getProvingKey', [keyId]) as { payee: Address };

  const { request, fulfillTx, fulfillReceipt } = await demo.waitFulfilled(requestId);
  const failed = parseEventLogs({ abi: coordinatorAbi, logs: fulfillReceipt.logs, eventName: 'CallbackFailed' });
  check(failed.some(event => (event.args as { requestId: string }).requestId === requestId), 'the coordinator emitted CallbackFailed for the request');
  check(request.status === Status.Fulfilled, 'the request is Fulfilled anyway');
  // Compare around the fulfill block, so other activity before or after cannot hide the credit.
  const before = await read('payeeBalance', [payee], fulfillReceipt.blockNumber - 1n) as bigint;
  const after = await read('payeeBalance', [payee], fulfillReceipt.blockNumber) as bigint;
  check(after - before >= request.fee, `the fee of ${request.fee} wei settled to the Payee ${payee}`);
  console.log('next: the Payee withdraws with withdraw-fees');
  result({ consumer: address, requestId, beta: request.beta, payee, fee: request.fee, deployTx: deployed.transactionHash, requestTx: requested.transactionHash, fulfillTx });
});
