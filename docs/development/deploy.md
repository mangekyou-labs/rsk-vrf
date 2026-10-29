# Coordinator deploy and Safe hand-off

A one-off deployer EOA deploys and configures the coordinator, then offers the Admin role to the Admin Safe. The Admin Safe accepts in a separate transaction, and a check confirms the result. The plan values (drand evmnet config, fee `2e13`, Callback Gas Cap `200000`) live in `contracts/script/DeployPlan.sol`.

Rootstock testnet is chain ID 31. Set the RPC first and check it:

```sh
export RPC_URL=https://public-node.testnet.rsk.co
cast chain-id --rpc-url "$RPC_URL"   # prints 31
```

The public node does not serve `eth_getLogs`. `deploy.sh`, `verify.sh`, `safe-tx.sh` and `CheckDeployment` do not need it. `pending-requests.sh` and the demo scripts do, so the runbooks and [the demo walkthrough](../demo.md) run them with an RPC that serves it. The workers read from the rskj node on their own host.

## Chain 31 rollout

Each step of the rollout (#41) and where it is done:

| #41 step | Section | Command |
| --- | --- | --- |
| 1. Create the Admin Safe | [1](#1-create-the-admin-safe) | safe.rootstock.io, then `cast call` |
| 1. Deploy | [2](#2-deploy) | `contracts/script/deploy.sh` |
| 1. Verify | [3](#3-verify-chain-31-only) | `contracts/script/verify.sh` |
| 1. Hand off, check, discard the deployer key, commit the record | [4](#4-safe-hand-off-and-check) | `contracts/script/safe-tx.sh <record> accept-ownership`, `CheckDeployment.s.sol` |
| 2. Gate | [demo.md](../demo.md) | `npm run demo:<name> --prefix worker` |
| 3. Drill: failover | [outage.md, section 8.1](../runbooks/outage.md#81-failover-drill) | `docker compose ... stop worker` |
| 3. Drill: Rotation with a request pending | [rotation.md](../runbooks/rotation.md) | `contracts/script/safe-tx.sh <record> register` |
| 3. Drill: Revocation with a request pending, and its refund | [compromise.md](../runbooks/compromise.md) | `contracts/script/safe-tx.sh <record> revoke`, `timeoutRefund` |
| 4. Outage window | [outage.md, section 8.2](../runbooks/outage.md#82-outage-window) | `docker compose ... stop worker`, `timeoutRefund` |
| 4. Count the missed Deadlines | [outage.md, section 7](../runbooks/outage.md#7-count-the-missed-deadlines) | `npm run demo:missed-deadlines --prefix worker` |
| 5. Final demo run | [demo.md](../demo.md) | `npm run demo:<name> --prefix worker` |

`contracts/script/rollout-wizard.sh` walks through these steps in order. It prints each command, waits for you, writes the times into the [drill log](../runbooks/drill-log.md), does not pass the gate until every demo script passes, and runs the missed-Deadline count. It never asks for a key: you sign on the Ledger and in the Safe UI, and you run the demo scripts in a second shell. It keeps its state in `.rollout-31/`, so a rerun resumes where it stopped (`--status` lists the stages).

## 1. Create the Admin Safe

The Admin Safe is a SafeL2 v1.4.1, 2-of-3. Each owner is a hardware wallet, and the three owners are held by at least two people.

1. Open safe.rootstock.io and select **Rootstock Testnet**. Connect one of the owner wallets.
2. Create a new Safe. Add the three owner addresses and set the threshold to 2. Pay for the creation with tRBTC from the testnet faucet.
3. Write down the Safe address in your own records, and set it in the shell:

   ```sh
   SAFE=0x...
   ```

Verify:

```sh
cast call    --rpc-url "$RPC_URL" "$SAFE" 'VERSION()(string)'        # prints "1.4.1"
cast storage --rpc-url "$RPC_URL" "$SAFE" 0                          # prints the singleton, see below
cast call    --rpc-url "$RPC_URL" "$SAFE" 'getThreshold()(uint256)'   # prints 2
cast call    --rpc-url "$RPC_URL" "$SAFE" 'getOwners()(address[])'    # prints the three owners
```

Slot 0 of a Safe proxy holds its singleton. It must be `0x00000000000000000000000029fcb43b46531bca003ddc8fcb67ffe91900c762`, the SafeL2 v1.4.1 singleton on chain 31. The non-L2 Safe v1.4.1 singleton is `0x41675c099f32341bf84bfc5382af534df5c7461a`. If slot 0 holds that address or any other, do not use the Safe. Create a new one.

## 2. Deploy

Commit everything first. On chain 31 the record names the commit it was deployed from, so `deploy.sh` refuses to run from a tree with uncommitted changes. On other chains the record's commit is marked `<sha>-dirty` instead.

From the repository root, with the Admin Safe address and the Proving Key's public point:

```sh
contracts/script/deploy.sh "$SAFE" <provingKeyX> <provingKeyY> --ledger
```

Any forge wallet flag works in place of `--ledger`, for example `--account deployer`. The script:

1. deploys the implementation and the ERC1967 proxy, with `initialize(owner = deployer)` adding drand config 0 and making the deployer the Admin;
2. registers the Proving Key, which becomes the Active Key, with Payee = Admin Safe;
3. sets the fee and the Callback Gas Cap;
4. calls `transferOwnership(safe)`, which offers the Admin role to the Admin Safe.

It then writes `deployments/<chainId>.json`. The record holds:

- lowercase addresses;
- creation blocks and tx hashes;
- the config transactions;
- the commit SHA;
- the config read back from the chain.

Only `deployments/31.json` is tracked by git. Set `DEPLOYMENT_FILE` to write elsewhere.

Rootstock takes legacy transactions only. The script sends legacy transactions with a 110% gas margin. The implementation's creation takes about 5.7M gas, and forge's default 130% margin puts it over the 6.8M block gas limit of rskj regtest. The testnet block gas limit is 12M, so the largest transaction (about 6.3M gas with the margin) fits. The deployer pays well under 0.001 tRBTC at the testnet minimum gas price.

## 3. Verify (chain 31 only)

On chain 31, `deploy.sh` ends by running `contracts/script/verify.sh` on the record. That script verifies the implementation and the proxy on Blockscout (`rootstock-testnet.blockscout.com`) and on Sourcify. It adds a link to the record's `verification` object only after that verifier succeeds. A failed verifier does not stop the others, and the script then exits non-zero. Rerun it by hand once the explorer is back:

```sh
contracts/script/verify.sh deployments/31.json
```

Neither explorer indexes rskj regtest, so verification is not rehearsed in CI. Only the proxy's constructor arguments were checked offline, against a regtest broadcast.

The Rootstock Explorer (`explorer.testnet.rootstock.io`) is best-effort and is not scripted. If you want it as well, verify both contracts through its web form, using the same sources and the proxy constructor arguments that `verify.sh` prints. Blockscout and Sourcify are the links of record.

On the first deploy, open the proxy on Blockscout and confirm that it is shown as a proxy with the implementation's ABI (the read and write tabs list the coordinator's functions). If it is not, do not continue until Blockscout links the proxy to the implementation.

## 4. Safe hand-off and check

Print the hand-off transaction:

```sh
contracts/script/safe-tx.sh deployments/31.json accept-ownership
```

The script does a call from the Admin Safe first. If the call reverts, it prints the reason and no transaction. Otherwise it prints the `to`, `value` and `data` lines. In safe.rootstock.io, open the Admin Safe, then **New transaction**, then **Transaction Builder**. Enter the `to` address, value `0` and the `data` as custom data. Each signer compares `to` and `data` with the script output before signing. Execute the transaction.

Then run the check, passing the Admin Safe address from your own records rather than copying it from the deployment record:

```sh
(cd contracts && forge script script/CheckDeployment.s.sol:CheckDeployment --rpc-url "$RPC_URL" \
  --sig "run(string,address)" ../deployments/31.json "$SAFE")
```

The check reverts with `Mismatch("<field>")` on the first value that differs. It compares:

- the chain ID;
- the record's Safe against the Admin Safe you passed;
- the Admin (`owner()`) against the Admin Safe, and an empty `pendingOwner`;
- the ERC1967 implementation slot;
- the drand config;
- the fee, Callback Gas Cap, round offset, Deadline (`timeoutBlocks`) and confirmations;
- the Active Key and its Payee.

Expected values come from the record, and the record must also match `DeployPlan.sol`. Before the Admin Safe accepts, the check fails with `Mismatch("owner")`.

Discard the deployer key only after the check passes and the Blockscout proxy view is confirmed. Until then it is the only key that can redo the deploy.

Then commit `deployments/31.json`. The explorer links of each contract are in its `verification` object, for example `https://rootstock-testnet.blockscout.com/address/<proxy>?tab=contract` and `https://repo.sourcify.dev/31/<proxy>`.

`worker/integration/deploy.test.ts` rehearses the deploy, hand-off and check on rskj regtest in CI, using a Safe stand-in contract. `worker/integration/runbooks.test.ts` does the hand-off with `safe-tx.sh accept-ownership`, and checks that a second hand-off is refused. Section 1 is not rehearsed, because regtest has no Safe.

## Reading the record

The worker can take the coordinator address from the record: set `COORDINATOR_DEPLOYMENT_FILE=deployments/31.json` in place of `COORDINATOR_ADDRESS` (see `worker/README.md`). The demo scripts read the same file through `DEPLOYMENT_FILE` (see [the demo walkthrough](../demo.md)).
