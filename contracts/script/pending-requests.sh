#!/usr/bin/env bash
# Lists the Pending requests of one Proving Key, for the runbooks in docs/runbooks/.
# stdout has one line per request: <requestId> deadline <block> refundable <when>.
# stderr names the key, its keyId and its state.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/deployment-env.sh"

usage() {
  cat >&2 <<'EOF'
Usage: RPC_URL=<rpc> contracts/script/pending-requests.sh <deployment record> <keyHash>
  LOG_BLOCK_SPAN (default 5000) is the block range of each log read.
EOF
  exit 2
}

[ $# -eq 2 ] && [ -n "${RPC_URL:-}" ] || usage
deployment_file=$1 key_hash=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')
load_deployment "$deployment_file"
latest=$(cast block-number --rpc-url "$RPC_URL")
span=${LOG_BLOCK_SPAN:-5000}

# Word indexes (from 0) in the ABI-encoded data that this script reads.
# KeyRegistered(uint32 keyId, bytes32 keyHash, address payee)
KEY_REGISTERED_KEY_ID=0
KEY_REGISTERED_KEY_HASH=1
# RandomnessRequested data: tag, keyId, targetRound, requestBlock, deadline, fee, callbackGasCap
REQUESTED_KEY_ID=1
# getProvingKey(uint32): keyHash, payee, state, ...
PROVING_KEY_STATE=2
# getRequest(bytes32): requester, status, callbackGasCap, requestBlock, drandConfigId, fee,
# targetRound, deadline, ...
REQUEST_STATUS=1
REQUEST_DEADLINE=7
STATUS_PENDING=1

# All logs of one event from the proxy's creation block to the latest block, as one JSON array.
logs() {
  local start=$proxy_block end
  while [ "$start" -le "$latest" ]; do
    end=$((start + span - 1))
    [ "$end" -le "$latest" ] || end=$latest
    cast logs --rpc-url "$RPC_URL" --json --address "$proxy" --from-block "$start" --to-block "$end" "$1"
    start=$((end + 1))
  done | jq -s 'add // []'
}
# Word n (from 0) of ABI-encoded hex, as 0x-prefixed hex.
word() { printf '0x%s' "${1:$((2 + 64 * $2)):64}"; }
# The same for jq: word n of the .data of a log, without 0x.
JQ_WORD='def word($n): .data[2 + 64 * $n : 66 + 64 * $n];'

# The coordinator has no keyHash-to-keyId view, so read it from KeyRegistered.
key_id_word=$(logs 'KeyRegistered(uint32,bytes32,address)' | jq -r --arg h "${key_hash#0x}" \
  --argjson id "$KEY_REGISTERED_KEY_ID" --argjson hash "$KEY_REGISTERED_KEY_HASH" \
  "$JQ_WORD"' [.[] | select((word($hash) | ascii_downcase) == $h) | word($id)][0] // empty')
[ -n "$key_id_word" ] || { echo "$key_hash is not a registered keyHash of $proxy" >&2; exit 1; }
key_id=$(cast to-dec "0x$key_id_word")
proving_key_hex=$(cast call --rpc-url "$RPC_URL" "$proxy" "$(cast calldata 'getProvingKey(uint32)' "$key_id")")
state_names=(None Active Draining Revoked Retired)
state=${state_names[$(cast to-dec "$(word "$proving_key_hex" "$PROVING_KEY_STATE")")]}
echo "Proving Key $key_id ($key_hash) is $state" >&2

count=0
for request_id in $(logs 'RandomnessRequested(bytes32 indexed,address indexed,bytes32,uint32,uint64,uint48,uint48,uint96,uint32)' \
  | jq -r --arg k "$key_id_word" --argjson id "$REQUESTED_KEY_ID" "$JQ_WORD"' .[] | select(word($id) == $k) | .topics[1]'); do
  request_hex=$(cast call --rpc-url "$RPC_URL" "$proxy" "$(cast calldata 'getRequest(bytes32)' "$request_id")")
  [ "$(cast to-dec "$(word "$request_hex" "$REQUEST_STATUS")")" = "$STATUS_PENDING" ] || continue
  deadline=$(cast to-dec "$(word "$request_hex" "$REQUEST_DEADLINE")")
  if [ "$state" = Revoked ]; then when='now (KeyRevoked)'
  elif [ "$latest" -gt "$deadline" ]; then when='now (Deadline)'
  else when="after block $deadline (Deadline)"; fi
  echo "$request_id deadline $deadline refundable $when"
  count=$((count + 1))
done
echo "$count Pending at block $latest" >&2
