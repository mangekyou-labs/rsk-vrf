# Sourced by the runbook scripts (safe-tx.sh, pending-requests.sh). Not for direct use.
# load_deployment <deployment file> reads the coordinator from a deployment record and
# makes sure that RPC_URL is the chain of the record. It sets:
#   proxy       the coordinator proxy address
#   proxy_block the block that created the proxy
#   safe        the Admin Safe address
#   chain_id    the chain of the record

load_deployment() {
  local deployment_file=$1
  proxy=$(jq -er .contracts.proxy.address "$deployment_file")
  proxy_block=$(jq -er .contracts.proxy.block "$deployment_file")
  safe=$(jq -er .safe "$deployment_file")
  chain_id=$(jq -er .chainId "$deployment_file")
  [ "$(cast chain-id --rpc-url "$RPC_URL")" = "$chain_id" ] || {
    echo "RPC_URL is not chain $chain_id of $deployment_file" >&2
    exit 1
  }
}
