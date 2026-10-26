// Demo: the Payee withdraws its settled fees. When DEMO_PRIVATE_KEY is the Payee it
// sends withdrawFees() itself; otherwise (the Payee is the Admin Safe) it prints the
// Safe transaction and exits 3, and rerun with WITHDRAW_TX it verifies that transaction.
// Unaudited testnet pilot; do not use for value.
import { encodeFunctionData, getAddress, parseEventLogs, type Address, type Hex, type TransactionReceipt } from 'viem';

import { check, connect, coordinatorAbi, main, result } from './lib.ts';

main(async () => {
  const demo = await connect('withdraw-fees');
  const read = (functionName: string, args: unknown[], blockNumber?: bigint) => demo.client.readContract({ address: demo.coordinator, abi: coordinatorAbi, functionName, args, blockNumber } as never) as Promise<unknown>;
  const keyId = await read('activeKeyId', []) as number;
  const payee = getAddress(process.env.PAYEE ?? (await read('getProvingKey', [keyId]) as { payee: Address }).payee);
  const data = encodeFunctionData({ abi: coordinatorAbi, functionName: 'withdrawFees' });
  console.log(`Payee ${payee} has ${await read('payeeBalance', [payee]) as bigint} wei to withdraw`);

  let receipt: TransactionReceipt;
  const given = process.env.WITHDRAW_TX as Hex | undefined;
  if (given) {
    receipt = await demo.mined(given);
    console.log(`withdrawal: ${demo.link(given)}`);
  } else if (payee === demo.account.address) {
    receipt = await demo.send('withdrawFees', { to: demo.coordinator, data, gas: 100_000n });
  } else {
    console.log('The Payee is not DEMO_PRIVATE_KEY, so propose this transaction from the Payee (the Admin Safe):');
    console.log(`  to:    ${demo.coordinator}`);
    console.log('  value: 0');
    console.log(`  data:  ${data}  (withdrawFees())`);
    console.log('Then rerun with WITHDRAW_TX=<its transaction hash> to verify it.');
    process.exitCode = 3;
    return;
  }

  check(receipt.status === 'success', 'the withdrawal succeeded');
  const [event] = parseEventLogs({ abi: coordinatorAbi, logs: receipt.logs, eventName: 'FeesWithdrawn' })
    .filter(log => log.address.toLowerCase() === demo.coordinator.toLowerCase());
  const args = event?.args as { payee: Address; amount: bigint } | undefined;
  check(args !== undefined && getAddress(args.payee) === payee && args.amount > 0n, `FeesWithdrawn paid ${args?.amount ?? 0n} wei to the Payee`);
  check(await read('payeeBalance', [payee], receipt.blockNumber) === 0n, 'the Payee balance is zero after the withdrawal');
  result({ payee, amount: args.amount, withdrawTx: receipt.transactionHash });
});
