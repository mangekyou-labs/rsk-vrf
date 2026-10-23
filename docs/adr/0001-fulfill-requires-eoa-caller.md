# `fulfill` requires an EOA caller

Rootstock has no EIP-150 63/64 gas rule, and its maximum call depth is 400 (RSKIP150). A call made at that depth fails without running the callee. Because fulfillment is permissionless, a Fulfiller could call `fulfill` from about depth 399 for roughly 400k gas. The consumer callback would then fail silently, while the fulfillment and the Payee's fee still succeed. Ethereum's 63/64 rule makes this attack impractical; Rootstock has no such rule. We therefore require `msg.sender == tx.origin` in `fulfill`, so the callback always runs at depth 2. The cost is that Fulfillers must be EOAs submitting directly: no contract wallets, batchers or relaying contracts. Our workers are EOAs already.

## Considered Options

- **Detect a depth failure from the gas the callee used** (treat a failed call that consumed almost nothing as a depth failure and revert). Rejected because it's fragile: a consumer that reverts immediately looks the same, and it would let a Requester block its own fulfillment.
- **Accept the grief.** Rejected because no retry exists, so a failed callback can't be recovered from inside the callback path.
