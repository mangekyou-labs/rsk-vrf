#!/usr/bin/env bash
# Verifies the implementation and the proxy from a deployment record on Blockscout and
# Sourcify. Chain 31 only: neither explorer indexes rskj regtest, so this step is not
# rehearsed in CI. deploy.sh calls it; rerun it by hand if an explorer was down.
#
# Usage: contracts/script/verify.sh ../deployments/31.json
set -euo pipefail

if [ $# -ne 1 ]; then
  sed -n '6p' "$0" >&2
  exit 2
fi
cd "$(dirname "$0")/.."
record=$1

chain_id=$(jq -r .chainId "$record")
implementation=$(jq -r .contracts.implementation.address "$record")
proxy=$(jq -r .contracts.proxy.address "$record")
deployer=$(jq -r .deployer "$record")
drand=$(jq -r '.config.drand | "([\(.publicKey | join(","))],\(.genesis),\(.period))"' "$record")

# The proxy's constructor arguments, rebuilt from the record: initialize(owner = deployer, drand).
init=$(cast calldata "initialize(address,(uint256[4],uint64,uint64))" "$deployer" "$drand")
proxy_args=$(cast abi-encode "constructor(address,bytes)" "$implementation" "$init")

for verifier in blockscout sourcify; do
  flags=(--chain "$chain_id" --verifier "$verifier" --watch)
  if [ "$verifier" = blockscout ]; then
    flags+=(--verifier-url https://rootstock-testnet.blockscout.com/api/)
  fi
  forge verify-contract "${flags[@]}" "$implementation" src/VRFCoordinator.sol:VRFCoordinator
  forge verify-contract "${flags[@]}" --constructor-args "$proxy_args" "$proxy" \
    lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy
done
