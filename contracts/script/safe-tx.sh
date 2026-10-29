#!/usr/bin/env bash
# Prints an Admin Safe transaction to the coordinator of a deployment record, for the
# runbooks in docs/runbooks/. It first does an eth_call of the transaction from the Admin
# Safe, so a transaction that would revert is never given to the signers.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/deployment-env.sh"

usage() {
  cat >&2 <<'EOF'
Usage: RPC_URL=<rpc> contracts/script/safe-tx.sh <deployment record> <action>
  register <x> <y>   registerProvingKey([x, y], <Admin Safe>): the new key becomes Active
                     and the old Active key becomes Draining
  revoke <keyHash>   revoke(keyHash): the key becomes Revoked
  withdraw-fees      withdrawFees(): pays the Admin Safe its Payee balance
EOF
  exit 2
}

[ $# -ge 2 ] && [ -n "${RPC_URL:-}" ] || usage
deployment_file=$1 action=$2
shift 2
load_deployment "$deployment_file"

case "$action" in
  register)
    [ $# -eq 2 ] || usage
    data=$(cast calldata 'registerProvingKey(uint256[2],address)' "[$1,$2]" "$safe")
    summary="registerProvingKey, keyHash $(cast keccak "$(cast abi-encode 'f(uint256,uint256)' "$1" "$2")"), Payee $safe"
    ;;
  revoke)
    [ $# -eq 1 ] || usage
    data=$(cast calldata 'revoke(bytes32)' "$1")
    summary="revoke, keyHash $1"
    ;;
  withdraw-fees)
    [ $# -eq 0 ] || usage
    data=$(cast calldata 'withdrawFees()')
    balance=$(cast call --rpc-url "$RPC_URL" "$proxy" 'payeeBalance(address)(uint256)' "$safe" | cut -d' ' -f1)
    summary="withdrawFees, Payee $safe, balance $balance wei"
    # withdrawFees() does nothing for a zero balance, so a transaction is not necessary.
    [ "$balance" != 0 ] || { echo "$summary: nothing to withdraw, so do not propose it." >&2; exit 1; }
    ;;
  *) usage ;;
esac

if ! reason=$(cast call --rpc-url "$RPC_URL" --from "$safe" "$proxy" "$data" 2>&1); then
  echo "$summary: the call reverts when the Admin Safe sends it, so do not propose it." >&2
  echo "$reason" >&2
  exit 1
fi
echo "$summary" >&2
echo "Propose this transaction in the Admin Safe (chain $chain_id). Each signer compares it before signing:" >&2
echo "to:    $proxy"
echo "value: 0"
echo "data:  $data"
