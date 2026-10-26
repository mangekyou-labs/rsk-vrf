# Coordinator deploy and Safe hand-off

A one-off deployer EOA deploys and configures the coordinator, then offers ownership to the Safe. The Safe accepts in a separate transaction, and a check confirms the result. The plan values (drand evmnet config, fee `2e13`, Callback Gas Cap `200000`) live in `contracts/script/DeployPlan.sol`.

## 1. Deploy

From the repository root, with the Safe address and the Proving Key's public point:

```sh
RPC_URL=https://public-node.testnet.rsk.co \
  contracts/script/deploy.sh <safe> <provingKeyX> <provingKeyY> --ledger
```

Any forge wallet flag works in place of `--ledger`, for example `--account deployer`. The script:

1. deploys the implementation and the ERC1967 proxy, with `initialize(owner = deployer)` adding drand config 0;
2. registers the Proving Key with Payee = Safe;
3. sets the fee and the Callback Gas Cap;
4. calls `transferOwnership(safe)`.

It then writes `deployments/<chainId>.json`. The record holds lowercase addresses, creation blocks and tx hashes, the config transactions, the commit SHA and the config read back from the chain. Only `deployments/31.json` is tracked by git. Set `DEPLOYMENT_FILE` to write elsewhere.

Rootstock takes legacy transactions only, and its block gas limit is 6.8M. The script sends legacy transactions with a 110% gas margin, because forge's default 130% puts the implementation's creation over that limit.

## 2. Verify (chain 31 only)

On chain 31, `deploy.sh` ends by running `contracts/script/verify.sh` on the record. That script verifies the implementation and the proxy on Blockscout (`rootstock-testnet.blockscout.com`) and on Sourcify. The record's `verification` links point at both. If an explorer was down, rerun it by hand:

```sh
contracts/script/verify.sh ../deployments/31.json
```

Neither explorer indexes rskj regtest, so verification is not rehearsed in CI. Only the proxy's constructor arguments were checked offline, against a regtest broadcast.

## 3. Safe hand-off and check

The Safe signers call `acceptOwnership()` on the proxy. Then run:

```sh
cd contracts
forge script script/CheckDeployment.s.sol:CheckDeployment --rpc-url "$RPC_URL" \
  --sig "run(string)" ../deployments/31.json
```

The check reverts with `Mismatch("<field>")` on the first value that differs. It compares:

- the chain ID;
- `owner == safe` and an empty `pendingOwner`;
- the ERC1967 implementation slot;
- the drand config;
- the fee, Callback Gas Cap, round offset, timeout and confirmations;
- the active Proving Key and its Payee.

Expected values come from the record, and the record must also match `DeployPlan.sol`. Before the Safe accepts, the check fails with `Mismatch("owner")`.

`worker/integration/deploy.test.ts` rehearses the deploy, hand-off and check on rskj regtest in CI, using a Safe stand-in contract.
