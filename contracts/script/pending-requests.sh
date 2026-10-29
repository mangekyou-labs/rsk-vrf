#!/usr/bin/env bash
# Lists the Pending requests of one Proving Key, for the runbooks in docs/runbooks/.
# stdout has one line per request: <requestId> deadline <block> refundable <when>.
# stderr names the key, its keyId and its state.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: RPC_URL=<rpc> contracts/script/pending-requests.sh <deployment record> <keyHash>
  LOG_BLOCK_SPAN (default 5000) is the block range of each log read.
EOF
  exit 2
}

[ $# -eq 2 ] && [ -n "${RPC_URL:-}" ] || usage
record=$1 key_hash=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')
proxy=$(jq -er .contracts.proxy.address "$record")
from=$(jq -er .contracts.proxy.block "$record")
chain_id=$(jq -er .chainId "$record")
[ "$(cast chain-id --rpc-url "$RPC_URL")" = "$chain_id" ] || { echo "RPC_URL is not chain $chain_id of $record" >&2; exit 1; }
latest=$(cast block-number --rpc-url "$RPC_URL")
span=${LOG_BLOCK_SPAN:-5000}

# All logs of one event from the proxy's creation block to the latest block, as one JSON array.
logs() {
  local start=$from end
  while [ "$start" -le "$latest" ]; do
    end=$((start + span - 1))
    [ "$end" -le "$latest" ] || end=$latest
    cast logs --rpc-url "$RPC_URL" --json --address "$proxy" --from-block "$start" --to-block "$end" "$1"
    start=$((end + 1))
  done | jq -s 'add // []'
}
# Word n (from 0) of ABI-encoded hex.
word() { printf '0x%s' "${1:$((2 + 64 * $2)):64}"; }

# The coordinator has no keyHash-to-keyId view, so read it from KeyRegistered(keyId, keyHash, payee).
key_word=$(logs 'KeyRegistered(uint32,bytes32,address)' | jq -r --arg h "${key_hash#0x}" \
  '[.[] | select((.data[66:130] | ascii_downcase) == $h)][0].data[2:66] // empty')
[ -n "$key_word" ] || { echo "$key_hash is not a registered keyHash of $proxy" >&2; exit 1; }
key_id=$(cast to-dec "0x$key_word")
key=$(cast call --rpc-url "$RPC_URL" "$proxy" "$(cast calldata 'getProvingKey(uint32)' "$key_id")")
state_names=(None Active Draining Revoked Retired)
state=${state_names[$(cast to-dec "$(word "$key" 2)")]}
echo "Proving Key $key_id ($key_hash) is $state" >&2

# RandomnessRequested data: tag, keyId, targetRound, requestBlock, deadline, fee, callbackGasCap.
count=0
for request_id in $(logs 'RandomnessRequested(bytes32 indexed,address indexed,bytes32,uint32,uint64,uint48,uint48,uint96,uint32)' \
  | jq -r --arg k "$key_word" '.[] | select(.data[66:130] == $k) | .topics[1]'); do
  record_hex=$(cast call --rpc-url "$RPC_URL" "$proxy" "$(cast calldata 'getRequest(bytes32)' "$request_id")")
  # Request: requester, status, callbackGasCap, requestBlock, drandConfigId, fee, targetRound, deadline, ...
  [ "$(cast to-dec "$(word "$record_hex" 1)")" = 1 ] || continue
  deadline=$(cast to-dec "$(word "$record_hex" 7)")
  if [ "$state" = Revoked ]; then when='now (KeyRevoked)'
  elif [ "$latest" -gt "$deadline" ]; then when='now (Deadline)'
  else when="after block $deadline (Deadline)"; fi
  echo "$request_id deadline $deadline refundable $when"
  count=$((count + 1))
done
echo "$count Pending at block $latest" >&2
