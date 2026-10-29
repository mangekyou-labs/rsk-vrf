# Demo walkthrough

Testnet pilot, not externally audited; do not use for value.

The scripts in `worker/demo/` drive a deployed coordinator end to end. Each script prints that banner, an explorer link for every transaction it sends, an `ok:` line for each check it asserts, and a final `RESULT {json}` line. A failed check prints `FAILED` and exits 1.

On chain 31 the links go to `https://rootstock-testnet.blockscout.com/tx/<hash>`. On chain 30 they go to `rootstock.blockscout.com`. Any other chain prints the bare hash, unless you set `EXPLORER_TX_URL`.

## Setup

The scripts read the coordinator address from the deployment record that `contracts/script/deploy.sh` writes (see [the deploy guide](development/deploy.md)). Any chain with a record and a funded key works.

```sh
(cd contracts && forge build)   # the scripts deploy the demo consumers from contracts/out
cd worker && npm ci
export RPC_URL=<an RPC of chain 31 that serves eth_getLogs>
export DEMO_PRIVATE_KEY=0x...   # a throwaway key holding faucet tRBTC
```

| Variable | Meaning |
| --- | --- |
| `RPC_URL` | JSON-RPC endpoint. Required. The scripts find the fulfill transaction with `eth_getLogs`, which the public node (`https://public-node.testnet.rsk.co`) does not serve. Use an RPC that serves it. |
| `DEMO_PRIVATE_KEY` | Sender key. It pays the fees and gas. Required. |
| `DEPLOYMENT_FILE` | Deployment record. Defaults to `deployments/<chainId>.json`. |
| `DRAND_RELAY_URL` | drand HTTP endpoint for `recompute-beta` and `rejections`. Defaults to the evmnet chain on `api.drand.sh`. |
| `GO_VRF_URL` | Go test relay for the noble and Go cross-check in `recompute-beta`. |
| `EXPLORER_TX_URL` | Explorer transaction URL prefix. Overrides the default. |
| `POLL_MS` | How often to poll off regtest. Default 10000. On regtest (chain 33) the scripts mine their own blocks. |
| `REQUEST_ID` | Request for `recompute-beta`; if unset, the script makes a new one. For `withdraw-fees`, the request whose fee was credited: the script withdraws for the Payee of the Proving Key that served it. |
| `PAYEE`, `WITHDRAW_TX` | Used by `withdraw-fees`; see below. |

Each fulfillment needs the operator's worker to be running against the same coordinator. On testnet a request waits for its confirmations and drand round, which takes a few minutes.

## The scripts

Run each one from `worker/` with `npm run demo:<name>`.

1. **`dice`** deploys `DemoDice` and rolls with the exact fee. When the worker fulfills, the callback stores Beta and emits `Rolled`. The script checks that the stored Beta matches the coordinator's, and that `face(requestId)` is in 1..6 and equals `deriveRandomInRange(requestId, keccak256("rsk-vrf/demo/dice"), 1, 6)`.
2. **`read-path`** has the EOA call `request(tag)` without a callback. While the request is Pending, `deriveRandomBytes` reverts with `RequestPending`. After fulfillment the script reads the request through `deriveRandomBytes`, `deriveRandom` and `deriveRandomInRange(1, 100)`.
3. **`reverting-consumer`** deploys `RevertingConsumer`, whose callback always reverts. Fulfillment emits `CallbackFailed`, the request is still Fulfilled, and the fee is credited to the Payee in the fulfill block.
4. **`withdraw-fees`** withdraws the fees credited to a Payee. Set `REQUEST_ID` to the request whose fee was credited (for example the one `reverting-consumer` printed). The script looks up the Proving Key that served it and withdraws for that key's Payee. That key need not be the Active key any more. `PAYEE` names the Payee directly instead.
   - If `DEMO_PRIVATE_KEY` is the Payee, it sends `withdrawFees()` itself.
   - Otherwise (for example, when the Payee is the Admin Safe), it prints the Safe transaction: to the coordinator, value 0, data `0x476343ee`. It then exits with code 3. Propose and execute that transaction in the Safe, then rerun with `WITHDRAW_TX=<hash>` to verify it.
   - Either way, the script checks that `FeesWithdrawn` was emitted and that the Payee balance is zero afterwards.
5. **`recompute-beta`** recomputes a request's Beta without the worker's code. It decodes the proof and drand signature from the fulfill calldata and checks the proof's public key against the registered key hash. It checks the signature against `DRAND_RELAY_URL` for the request's target round and rebuilds Alpha. On every chain it then verifies the proof (Gamma, c, s) over that Alpha and the Proving Key's public key with its own ECVRF verifier, `worker/demo/ecvrf.ts`. That verifier follows `VRF.sol` with noble primitives and shares no code with the worker's prover. Finally it derives Beta from Gamma, which must equal the stored Beta. `RESULT` reports `proofVerified: true`.
6. **`rejections`** shows the coordinator rejecting bad fulfillments. Each one is sent as a real transaction with an explicit gas limit of 1,000,000 (`REJECTION_GAS_LIMIT`) and mined as reverted. The script reads back each error by replaying the transaction at its block, and asserts it is the case's expected error below.

   | Case | Kind | Expected error |
   | --- | --- | --- |
   | corrupted gamma | invalid | `gamma is not on curve` |
   | corrupted s | invalid | `addr(c*pk+s*g)!=_uWitness` |
   | A's proof on B | mismatched | `Second mul check failed` |
   | wrong drand round | mismatched | `InvalidDrandSignature` |
   | repeat on Fulfilled A | repeated | `RequestNotPending(2)` |

   **Isolation.** On regtest the Proving Key is the public test key, so the script proves B itself, producing the same proof the operator later sends. Each case on B is then that valid fulfillment with exactly one thing changed:
   - corrupted gamma changes only Gamma's x;
   - corrupted s changes only s;
   - A's proof on B swaps in A's proof;
   - wrong drand round swaps in the previous round's signature.

   `RESULT` reports `isolated: true`. On other chains the key is secret, so the script falls back to building the cases from A's proof. It prints `not isolated` and reports `isolated: false`. Those cases are then also over the wrong Alpha, but the first check they fail, and so the expected error, is the same.

   **Timing.** The script fulfills request A first, then sends all five transactions in the first block where request B is Fulfillable, so they land before the operator fulfills B. On regtest the script mines that block itself. On a live chain the worker may fulfill B first. The script detects this: B is no longer Pending before it broadcasts, or a rejection lands in or after B's fulfill block. It then stops with "the operator's worker fulfilled B before the rejections landed ... rerun rejections". Rerun it.

7. **`missed-deadlines`** reports the missed-Deadline count for the walkthrough. It reads the record and takes a block range, `<record> <fromBlock> <toBlock>`, and an `--exclude <from>-<to>` for each announced outage window. It prints each request with a Deadline in the range that is still Pending after its Deadline or was refunded after it, as `<requestId> deadline <block> <Pending|Refunded>`, then the count. The rule is the worker's `missed_deadline` rule, so a refund after a Revocation is not counted. The target is 0 outside the announced window. See [outage.md, section 7](runbooks/outage.md#7-count-the-missed-deadlines). It sends no transaction and needs no `DEMO_PRIVATE_KEY`. `worker/integration/runbooks.test.ts` runs it on regtest, not `demo.test.ts`.

## Timeout Refund

No script covers the timeout Refund, because a request is refunded only if no worker fulfills it before its Deadline (1,200 blocks). The outage window of the rollout does this scenario with `cast`: a demo request with both workers stopped, `timeoutRefund` after the Deadline, and the `missed_deadline` Page with the withheld proof. See [outage.md, section 8.2](runbooks/outage.md#82-outage-window). The Revocation drill also refunds a request, after a Revocation and before its Deadline ([compromise.md](runbooks/compromise.md), section 1).

## The noble and Go cross-check

The worker proves with noble (TypeScript). The reference is Chainlink's Go VRF code in `tools/vrf-vectors-go`. When `GO_VRF_URL` points at that tool's test relay, `recompute-beta` does two more things:
- it asks the Go verifier to verify the on-chain proof and return the same Beta;
- it asks the Go prover for the proof of the same Alpha and checks that it matches, byte for byte, the proof the worker sent.

The Go relay proves with the public test key and signs with the public test drand beacon. So the byte-for-byte comparison can only work on regtest, where the worker uses that same key and beacon. `worker/integration/demo.test.ts` sets that up. On testnet the Proving Key is secret and the beacon is the real evmnet chain, so the script skips the comparison and says so.

## On regtest

`worker/integration/demo.test.ts` runs every script against rskj regtest, as part of `npm run test:integration`. It deploys with `deploy.sh`, and uses a Safe stand-in as the Admin and Payee. It runs the worker in the background and asserts each script's `RESULT` line, including the Safe withdrawal flow. CI runs it in the "Worker on rskj regtest" job; see [the worker README](../worker/README.md#offline-full-loop) to run it locally.

## Results

Fill in this section after the final demo run on chain 31, against the Active Key after the drill Rotation. Copy each link from the script output. Do not fill in a value that a script did not print.

Testnet pilot, not externally audited; do not use for value.

| Field | Value |
| --- | --- |
| Date (UTC) | <date> |
| Coordinator (proxy) | <explorer link> |
| Active Key | <keyId>, keyHash <keyHash> |
| Drill log | <link to the drill log, see [runbooks/drill-log.md](runbooks/drill-log.md)> |

| Scenario | Script | What the link shows | Explorer link |
| --- | --- | --- | --- |
| On-chain verification | `dice` | The fulfill transaction: the coordinator verifies the proof and stores Beta | <explorer link> |
| Deterministic output | `recompute-beta` | The fulfill transaction whose Beta the script recomputes (`proofVerified: true`) | <explorer link> |
| Callback path | `dice` | The fulfill transaction that emits `Rolled` | <explorer link> |
| Read path | `read-path` | The fulfill transaction of the request that the script reads with `deriveRandomBytes` | <explorer link> |
| Fee settlement: fee credited | `reverting-consumer` | The fulfill transaction that emits `CallbackFailed` and credits the fee to the Payee | <explorer link> |
| Fee settlement: fees withdrawn | `withdraw-fees` | The transaction that emits `FeesWithdrawn` | <explorer link> |
| Timeout Refund | `timeoutRefund` after the outage window | The refund transaction (see the outage Incident Note) | <explorer link> |
| Rejection: invalid, corrupted gamma | `rejections` | Reverted with `gamma is not on curve` | <explorer link> |
| Rejection: invalid, corrupted s | `rejections` | Reverted with `addr(c*pk+s*g)!=_uWitness` | <explorer link> |
| Rejection: mismatched, A's proof on B | `rejections` | Reverted with `Second mul check failed` | <explorer link> |
| Rejection: mismatched, wrong drand round | `rejections` | Reverted with `InvalidDrandSignature` | <explorer link> |
| Rejection: repeated, on Fulfilled A | `rejections` | Reverted with `RequestNotPending(2)` | <explorer link> |

`rejections` reported `isolated: <true|false>` (see "Isolation" above).

Missed Deadline count outside the announced outage window, from `missed-deadlines <record> <fromBlock> <toBlock> --exclude <window>`: <n> (target 0). <List each missed Deadline and link its Incident Note. | None.>

Outage window Incident Note: <link to the issue>.
