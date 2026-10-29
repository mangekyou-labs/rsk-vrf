# Drill log: failover, Rotation and Revocation

Use this template to log the pre-demo drill on chain 31: a failover to the Backup Worker, then a Rotation with a request pending, then a Revocation with a request pending and its refund. Copy it to a new issue (or a file in the drill PR) and fill it in while you do the drill. Do not fill in values afterwards from memory.

This is a testnet pilot. The coordinator is not externally audited.

## How to fill it in

- Write each time in UTC, `HH:MM:SS`, from one clock.
- **Block** is the block of the transaction. For a step with no transaction, use `cast block-number --rpc-url "$RPC_URL"` when the step ends.
- **Tx** is the explorer link `https://rootstock-testnet.blockscout.com/tx/<hash>`. Write `none` for a step with no transaction. For a Safe transaction, also write the Safe transaction link.
- **Outcome** is what the Verify line of the runbook step showed: `ok`, or the text that was different.
- **Runbook change** is the change that you made to the runbook during the drill, or `none`. Change the runbook in the same PR as the log, so that the log and the runbook agree.

## Drill

| Field | Value |
| --- | --- |
| Date (UTC) | <date> |
| Operator | <name> |
| Admin Safe signers | <signer>, <signer> |
| Deployment record | `deployments/31.json` at commit <commit> |
| Active Key before the drill | <keyId>, keyHash <keyHash> |
| Announcement | <link to the announcement in the Warn channel> |

## 1. Failover to the Backup Worker

Runbook: [outage.md, section 8.1](outage.md#81-failover-drill). Stop the Primary Worker, make a request, and make sure that the Backup Worker fulfills it after `GRACE_BLOCKS`.

Pending request: <requestId>, Deadline block <deadline>.

| Step | Runbook step | Start | End | Block | Tx | Outcome | Runbook change |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Announce the drill | outage.md 8.1.1 | <start> | <end> | <block> | none | <outcome> | <change> |
| Stop only the Primary Worker (`docker compose ... stop worker`) | outage.md 8.1.2 | <start> | <end> | <block> | none | <outcome> | <change> |
| Heartbeat Page for `primary` (expected) | outage.md 8 | <start> | <end> | <block> | none | <outcome> | <change> |
| Make the request | outage.md 8.1.3, [demo.md](../demo.md) `dice` | <start> | <end> | <block> | <link> | <outcome> | <change> |
| Backup Worker fulfills the request | outage.md 8.1.3 | <start> | <end> | <block> | <link> | <outcome> | <change> |
| Restart the Primary Worker | outage.md 8.1.4 | <start> | <end> | <block> | none | <outcome> | <change> |
| Post the Incident Note | outage.md 1.5 | <start> | <end> | <block> | none | <link to the issue> | <change> |

Blocks from the request to the fulfillment: <n> (`GRACE_BLOCKS` is 100).

## 2. Rotation with a request pending

Runbook: [rotation.md](rotation.md). Make a request under the old key before step 5, and make sure that it is still Pending when the Admin Safe registers the new key.

Pending request: <requestId>, bound to Proving Key <oldId>, Deadline block <deadline>.

| Step | Runbook step | Start | End | Block | Tx | Outcome | Runbook change |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Announce the Rotation | rotation.md 1 | <start> | <end> | <block> | none | <outcome> | <change> |
| Generate the new Proving Key | rotation.md 2 | <start> | <end> | <block> | none | <outcome> | <change> |
| Write the secret and the offline backups | rotation.md 3 | <start> | <end> | <block> | none | <outcome> | <change> |
| `check-key` on both hosts | rotation.md 4 | <start> | <end> | <block> | none | <outcome> | <change> |
| Make the pending request | [demo.md](../demo.md) `read-path` | <start> | <end> | <block> | <link> | <outcome> | <change> |
| Register the new key from the Admin Safe | rotation.md 5 | <start> | <end> | <block> | <link> | <outcome> | <change> |
| Both workers hold both keys | rotation.md 6.1 | <start> | <end> | <block> | none | <outcome> | <change> |
| Test request under the new keyHash | rotation.md 6.2 | <start> | <end> | <block> | <link> | <outcome> | <change> |
| The pending request is Fulfilled with the old key | rotation.md 6.3 | <start> | <end> | <block> | <link> | <outcome> | <change> |
| Delete the online secret of the Retired key | rotation.md 7 | <start> | <end> | <block> | none | <outcome> | <change> |
| Post the public note | rotation.md 8 | <start> | <end> | <block> | none | <link to the issue> | <change> |

New Active Key: <newId>, keyHash <NEW>, from block <block>.

## 3. Revocation with a request pending and its refund

Runbook: [compromise.md, section 1](compromise.md#1-the-proving-key-leaked). Make a request under the key that the drill revokes, and make sure that it is still Pending when the Admin Safe revokes the key. Then refund it.

Pending request: <requestId>, bound to Proving Key <keyId>, Deadline block <deadline>.

| Step | Runbook step | Start | End | Block | Tx | Outcome | Runbook change |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Make the pending request | [demo.md](../demo.md) `read-path` | <start> | <end> | <block> | <link> | <outcome> | <change> |
| Revoke the key from the Admin Safe | compromise.md 1.1 | <start> | <end> | <block> | <link> | <outcome> | <change> |
| `key_registry_changed` Page from both workers | compromise.md 1.1 | <start> | <end> | <block> | none | <outcome> | <change> |
| Rotation to a new Active Key | compromise.md 1.2 | <start> | <end> | <block> | <link> | <outcome> | <change> |
| Refund the pending request (`timeoutRefund`, reason KeyRevoked) | compromise.md 1.3 | <start> | <end> | <block> | <link> | <outcome> | <change> |
| Delete the secret of the Revoked key | compromise.md 1.4.1 | <start> | <end> | <block> | none | <outcome> | <change> |
| CloudTrail review | compromise.md 1.4.2 | <start> | <end> | <block> | none | <outcome> | <change> |
| Post the Incident Note | compromise.md 1.5 | <start> | <end> | <block> | none | <link to the issue> | <change> |

Blocks from the Revocation to the refund: <n>. Requests that missed a Deadline in the drill: <n>.

## Summary

- Total time, first step to last step: <duration>
- Runbook changes made during the drill: <n>, in <link to the PR>
- Steps that did not pass: <none | list each step and what happened>
