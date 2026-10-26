#!/usr/bin/env bash
# Verifies the implementation and the proxy from a deployment record on Blockscout and
# Sourcify, and adds each explorer link to the record once that verification succeeds.
# Chain 31 only: neither explorer indexes rskj regtest, so this step is not rehearsed in CI.
# deploy.sh calls it; rerun it by hand if an explorer was down.
set -euo pipefail

usage() {
  echo "Usage: contracts/script/verify.sh <deployments/31.json>" >&2
  exit 2
}

[ $# -eq 1 ] || usage
# Resolve against the caller's directory before the cd below.
record=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
cd "$(dirname "$0")/.."

chain_id=$(jq -r .chainId "$record")
implementation=$(jq -r .contracts.implementation.address "$record")
proxy=$(jq -r .contracts.proxy.address "$record")
deployer=$(jq -r .deployer "$record")
drand=$(jq -r '.config.drand | "([\(.publicKey | join(","))],\(.genesis),\(.period))"' "$record")

# The proxy's constructor arguments, rebuilt from the record: initialize(owner = deployer, drand).
init=$(cast calldata "initialize(address,(uint256[4],uint64,uint64))" "$deployer" "$drand")
proxy_args=$(cast abi-encode "constructor(address,bytes)" "$implementation" "$init")
echo "Proxy constructor arguments: $proxy_args"

blockscout=https://rootstock-testnet.blockscout.com

link() { # <verifier> <address>
  case $1 in
    blockscout) echo "$blockscout/address/$2?tab=contract" ;;
    sourcify) echo "https://repo.sourcify.dev/$chain_id/$2" ;;
  esac
}

# Every verifier runs for both contracts even after a failure; the exit status reports any.
failed=0
for verifier in blockscout sourcify; do
  flags=(--chain "$chain_id" --verifier "$verifier" --watch)
  if [ "$verifier" = blockscout ]; then
    flags+=(--verifier-url "$blockscout/api/")
  fi
  for contract in implementation proxy; do
    if [ "$contract" = implementation ]; then
      address=$implementation
      target=(src/VRFCoordinator.sol:VRFCoordinator)
    else
      address=$proxy
      flags_extra=(--constructor-args "$proxy_args")
      target=(lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy)
    fi
    if forge verify-contract "${flags[@]}" ${flags_extra[@]+"${flags_extra[@]}"} "$address" "${target[@]}"; then
      jq --arg c "$contract" --arg v "$verifier" --arg url "$(link "$verifier" "$address")" \
        '.contracts[$c].verification[$v] = $url' "$record" >"$record.tmp"
      mv "$record.tmp" "$record"
    else
      echo "$contract: $verifier verification failed" >&2
      failed=1
    fi
    flags_extra=()
  done
done
exit "$failed"
