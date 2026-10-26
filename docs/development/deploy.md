# Coordinator deploy and Safe hand-off

A one-off deployer EOA deploys and configures the coordinator, then offers the Admin role to the Admin Safe. The Admin Safe accepts in a separate transaction, and a check confirms the result. The plan values (drand evmnet config, fee `2e13`, Callback Gas Cap `200000`) live in `contracts/script/DeployPlan.sol`.

## 1. Deploy

Commit everything first. On chain 31 the record names the commit it was deployed from, so `deploy.sh` refuses to run from a tree with uncommitted changes. On other chains the record's commit is marked `<sha>-dirty` instead.

From the repository root, with the Admin Safe address and the Proving Key's public point:

```sh
RPC_URL=https://public-node.testnet.rsk.co \
  contracts/script/deploy.sh <safe> <provingKeyX> <provingKeyY> --ledger
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

Rootstock takes legacy transactions only, and its block gas limit is 6.8M. The script sends legacy transactions with a 110% gas margin, because forge's default 130% puts the implementation's creation over that limit.

## 2. Verify (chain 31 only)

On chain 31, `deploy.sh` ends by running `contracts/script/verify.sh` on the record. That script verifies the implementation and the proxy on Blockscout (`rootstock-testnet.blockscout.com`) and on Sourcify. It adds a link to the record's `verification` object only after that verifier succeeds. A failed verifier does not stop the others, and the script then exits non-zero. Rerun it by hand once the explorer is back:

```sh
contracts/script/verify.sh deployments/31.json
```

Neither explorer indexes rskj regtest, so verification is not rehearsed in CI. Only the proxy's constructor arguments were checked offline, against a regtest broadcast.

The Rootstock Explorer (`explorer.testnet.rootstock.io`) is best-effort and is not scripted. If you want it as well, verify both contracts through its web form, using the same sources and the proxy constructor arguments that `verify.sh` prints. Blockscout and Sourcify are the links of record.

On the first deploy, open the proxy on Blockscout and confirm that it is shown as a proxy with the implementation's ABI (the read and write tabs list the coordinator's functions). If it is not, do not continue until Blockscout links the proxy to the implementation.

## 3. Safe hand-off and check

The Admin Safe signers call `acceptOwnership()` on the proxy. Then run the check, passing the Admin Safe address from your own records rather than copying it from the deployment record:

```sh
cd contracts
forge script script/CheckDeployment.s.sol:CheckDeployment --rpc-url "$RPC_URL" \
  --sig "run(string,address)" ../deployments/31.json <safe>
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

`worker/integration/deploy.test.ts` rehearses the deploy, hand-off and check on rskj regtest in CI, using a Safe stand-in contract.

## Reading the record

The worker can take the coordinator address from the record: set `COORDINATOR_DEPLOYMENT_FILE=deployments/31.json` in place of `COORDINATOR_ADDRESS` (see `worker/README.md`). The demo (#39) and the README (#40) will read the same file once those tickets land.
