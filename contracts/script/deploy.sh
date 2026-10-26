#!/usr/bin/env bash
# Deploys and configures the coordinator, offers the Admin role to the Admin Safe, writes
# deployments/<chainId>.json and, on chain 31, verifies both contracts.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: RPC_URL=<rpc> contracts/script/deploy.sh <safe> <provingKeyX> <provingKeyY> <wallet flags...>
  The wallet flags go to forge and pick the one-off deployer EOA, for example
  `--ledger`, `--account deployer` or `--private-key <key>`.
  DEPLOYMENT_FILE overrides the record path (relative to contracts/).
EOF
  exit 2
}

if [ $# -lt 4 ] || [ -z "${RPC_URL:-}" ]; then
  usage
fi
safe=$1 key_x=$2 key_y=$3
shift 3
cd "$(dirname "$0")/.."

chain_id=$(cast chain-id --rpc-url "$RPC_URL")
# The chain 31 record names the commit it was deployed from, so refuse before broadcasting.
if [ "$chain_id" = 31 ] && [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  echo "The tree has uncommitted changes; commit them before deploying to chain 31." >&2
  exit 1
fi
export DEPLOYMENT_FILE=${DEPLOYMENT_FILE:-../deployments/$chain_id.json}
mkdir -p "$(dirname "$DEPLOYMENT_FILE")"

# Rootstock takes legacy transactions only. --slow sends each one after the last is mined.
# Forge's default 130% gas margin puts the implementation's creation above Rootstock's
# 6.8M block gas limit; 110% stays under it.
forge script script/DeployCoordinator.s.sol:DeployCoordinator --rpc-url "$RPC_URL" \
  --broadcast --legacy --slow --gas-estimate-multiplier 110 \
  --sig "run(address,uint256[2])" "$safe" "[$key_x,$key_y]" "$@"
python3 script/write-deployment.py "$DEPLOYMENT_FILE" "broadcast/DeployCoordinator.s.sol/$chain_id/run-latest.json"

if [ "$chain_id" = 31 ]; then
  script/verify.sh "$DEPLOYMENT_FILE"
fi
echo "Recorded $DEPLOYMENT_FILE. Next: the Admin Safe calls acceptOwnership, then run CheckDeployment."
