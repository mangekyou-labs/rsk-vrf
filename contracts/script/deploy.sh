#!/usr/bin/env bash
# Deploys and configures the coordinator, offers ownership to the Safe, writes
# deployments/<chainId>.json and, on chain 31, verifies both contracts.
#
# Usage: RPC_URL=<rpc> contracts/script/deploy.sh <safe> <provingKeyX> <provingKeyY> <wallet flags...>
#   The wallet flags go to forge and pick the one-off deployer EOA, for example
#   `--ledger`, `--account deployer` or `--private-key <key>`.
#   DEPLOYMENT_FILE overrides the record path (relative to contracts/).
set -euo pipefail

if [ $# -lt 4 ] || [ -z "${RPC_URL:-}" ]; then
  sed -n '5,8p' "$0" >&2
  exit 2
fi
safe=$1 x=$2 y=$3
shift 3
cd "$(dirname "$0")/.."

chain_id=$(cast chain-id --rpc-url "$RPC_URL")
export DEPLOYMENT_FILE=${DEPLOYMENT_FILE:-../deployments/$chain_id.json}
mkdir -p "$(dirname "$DEPLOYMENT_FILE")"

# Rootstock takes legacy transactions only. --slow sends each one after the last is mined.
# Forge's default 130% gas margin puts the implementation's creation above Rootstock's
# 6.8M block gas limit; 110% stays under it.
forge script script/DeployCoordinator.s.sol:DeployCoordinator --rpc-url "$RPC_URL" \
  --broadcast --legacy --slow --gas-estimate-multiplier 110 \
  --sig "run(address,uint256[2])" "$safe" "[$x,$y]" "$@"
python3 script/write-deployment.py "$DEPLOYMENT_FILE" "broadcast/DeployCoordinator.s.sol/$chain_id/run-latest.json"

if [ "$chain_id" = 31 ]; then
  script/verify.sh "$DEPLOYMENT_FILE"
fi
echo "Recorded $DEPLOYMENT_FILE. Next: the Safe calls acceptOwnership, then run CheckDeployment."
