# Runbook: outage

Use this runbook when a worker, its rskj node, its balance or drand stops the fulfillment of requests. Each section starts from a Page, a Warn or a missing heartbeat.

This is a testnet pilot. The coordinator is not externally audited.

Each real incident gets a short Incident Note (an issue with the `incident` label). A missed Deadline gets the full note of [section 5](#5-a-request-missed-its-deadline) not more than 24 hours after the Deadline.

Set these first, from the repository root:

```sh
export RPC_URL=https://public-node.testnet.rsk.co   # operator reads and sends only; the workers never use it
RECORD=deployments/31.json
PROXY=$(jq -r .contracts.proxy.address "$RECORD")
```

The hosts are `primary` (eu-central-1) and `backup` (us-east-1). `terraform output hosts` (in `infra/`) gives the `instance_id` and the Fulfiller address of each host. Read the worker log with the operator role:

```sh
aws logs tail /rsk-vrf/<host> --region <region> --since 30m
```

## Which section to use

| Signal | Level | Section |
| --- | --- | --- |
| healthchecks.io: a check is down (the Dead-man's Switch) | Page | [1](#1-the-heartbeat-is-missing) |
| `node_unhealthy`, `rpc_unhealthy` | Warn | [2](#2-rskj-is-not-healthy) |
| `low_balance` | Page | [3](#3-the-fulfiller-balance-is-low) |
| `top_up_balance` | Warn | [3](#3-the-fulfiller-balance-is-low) |
| `drand_stall` | Warn | [4](#4-drand-stalls) |
| `pending_age` (threshold 25) | Warn | [4](#4-drand-stalls), then [1](#1-the-heartbeat-is-missing) |
| `pending_age` (threshold 50) | Page | [1](#1-the-heartbeat-is-missing) to [4](#4-drand-stalls): find the cause now |
| `missed_deadline` | Page | [5](#5-a-request-missed-its-deadline) |
| `foreign_fulfillment` | Page | [compromise.md](compromise.md), section 1 |
| `key_registry_changed` | Page | [6](#6-other-pages) |
| `missing_proving_key`, `drand_config_mismatch` | Page | [6](#6-other-pages) |

## 1. The heartbeat is missing

The worker pings healthchecks.io only after a completed poll. A missing heartbeat means that the worker on that host does not complete polls.

1. **Make sure that the other host fulfills the requests.** Read the log of the other host:

   ```sh
   aws logs tail /rsk-vrf/<other host> --region <other region> --since 15m --filter-pattern poll_result
   ```

   Verify: the other check in healthchecks.io is up, and the log shows `poll_result` lines. If the Primary Worker is down, the Backup Worker fulfills each request after 100 blocks (`GRACE_BLOCKS`). If both hosts are down, do this section for both at the same time.

2. **Find the cause on the failed host.**

   ```sh
   aws ec2 describe-instance-status --region <region> --instance-ids <instance_id> --include-all-instances
   aws logs tail /rsk-vrf/<host> --region <region> --since 30m --filter-pattern startup_failed
   aws logs tail /rsk-vrf/<host> --region <region> --since 30m --filter-pattern poll_failed
   ```

   Verify: you know if the instance is running and which error the worker logs. A `startup_failed` line names the setting or the secret that the worker cannot read. An error from the RPC means section 2.

3. **Restart the stack.** With the host-access role:

   ```sh
   aws ssm send-command --region <region> --instance-ids <instance_id> \
     --document-name AWS-RunShellScript --parameters 'commands=["systemctl restart rsk-vrf"]'
   ```

   Verify: `aws logs tail /rsk-vrf/<host> --region <region> --since 5m --filter-pattern polling` shows a new `polling` line with the correct `coordinator` and `workerId`, and the check in healthchecks.io is up again in less than 5 minutes.

4. **If the restart does not help, or the instance is not reachable, make the host again.** With the Terraform credentials:

   ```sh
   cd infra
   terraform plan -replace="module.<host>.aws_instance.host" -out=tfplan && terraform apply tfplan
   cd ..
   ```

   The plan must replace only the instance. The data volume, the Proving Key secrets and the Fulfiller key stay. Then do Import Sync and start the stack, as in [infra/README.md](../../infra/README.md), "Import Sync".

   Verify: as in step 3.

5. **Post a short Incident Note.** Use the template below.

   ```sh
   gh issue create --repo mangekyou-labs/rsk-vrf --label incident \
     --title "Worker stopped: <host>" --body-file heartbeat-note.md
   ```

   Verify: `gh issue list --repo mangekyou-labs/rsk-vrf --label incident --limit 1` shows the issue.

### Incident Note template: heartbeat

```markdown
## What happened

From <time, UTC> to <time, UTC>, the worker on <primary|backup> did not complete polls. Cause: <cause, from step 2>.

## Effect on requests

<The other host fulfilled all requests in that time. | List each request that the other host did not fulfill, and its result.> <No request missed its Deadline. | List each missed Deadline and link its note.>

## What we changed

<Restart, new instance, or other change.>
```

## 2. rskj is not healthy

`node_unhealthy` (reason `syncing`) means that the local rskj node is not at the chain head. `rpc_unhealthy` means that the worker cannot read from rskj.

Never set the worker to the public node to stop the alert. The worker must read the chain from its own node. Change nothing in `RSK_RPC_URL`. Terraform sets it to `http://rskj:4444`.

1. **Compare the local node with the chain.** In a shell on the host (`aws ssm start-session --region <region> --target <instance_id>`, with the host-access role):

   ```sh
   curl -s -X POST -H 'Content-Type: application/json' \
     --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' http://127.0.0.1:4444
   ```

   On your machine, `cast block-number --rpc-url "$RPC_URL"` gives the chain head.

   Verify: you know the gap in blocks. If `curl` gets no answer, rskj is stopped.

2. **Restart rskj.**

   ```sh
   cd /opt/rsk-vrf
   sudo docker compose --env-file host.env --env-file worker-image.env restart rskj
   ```

   Verify: after 10 minutes, the block number from step 1 is near the chain head and increases, and the alert stops.

3. **If rskj does not get near the chain head, do Import Sync.** Use the commands in [infra/README.md](../../infra/README.md), "Import Sync". The import takes some hours. The other host fulfills the requests in that time. Do Import Sync on one host at a time.

   Verify: as in step 2, then `aws logs tail /rsk-vrf/<host> --region <region> --since 5m --filter-pattern polling` shows a new `polling` line.

4. **Post a short Incident Note** if the node was not healthy for more than 1 hour, or if Import Sync was necessary. Use the template below.

   ```sh
   gh issue create --repo mangekyou-labs/rsk-vrf --label incident \
     --title "rskj not healthy: <host>" --body-file rskj-note.md
   ```

   Verify: `gh issue list --repo mangekyou-labs/rsk-vrf --label incident --limit 1` shows the issue. If the node was healthy again in less than 1 hour and Import Sync was not necessary, no note is necessary.

### Incident Note template: rskj

```markdown
## What happened

From <time, UTC> to <time, UTC>, the rskj node on <primary|backup> was not healthy (<node_unhealthy | rpc_unhealthy>). Cause: <cause>.

<Import Sync was necessary. It took <hours>. | Import Sync was not necessary.>

## Effect on requests

The other host fulfilled the requests in that time. <No request missed its Deadline. | List each missed Deadline and link its note.>

## What we changed

<Change, so that this does not occur again.>
```

## 3. The Fulfiller balance is low

`low_balance` (Page) means that the Fulfiller cannot pay for the reserve of fulfillments. `top_up_balance` (Warn) means that it will soon be low. The fields `balance`, `available` and `required` are in wei.

1. **Read the balance.**

   ```sh
   cast balance --rpc-url "$RPC_URL" --ether <Fulfiller address>
   ```

   Verify: the balance agrees with the `balance` field of the alert.

2. **Send RBTC from the Operator Funding Wallet.** Send more than `required` from the alert, so that the Warn also stops:

   ```sh
   cast send --rpc-url "$RPC_URL" --ledger <Fulfiller address> --value 0.01ether
   ```

   Verify: `cast balance --rpc-url "$RPC_URL" --ether <Fulfiller address>` shows the new amount, and the host sends no `low_balance` or `top_up_balance` alert in the next 10 minutes.

3. **If the balance becomes low again quickly, find the cause.** Look at the last transactions of the Fulfiller in the explorer. Many transactions with no fulfillment can mean that a person signs with the Fulfiller key. In that case, use [compromise.md](compromise.md), section 2.

   Verify: each transaction from the Fulfiller is a `fulfill` call from this worker.

## 4. drand stalls

`drand_stall` means that the target round of a request is past its time, but the worker cannot get the signature from the drand relays. The worker continues to try. The Deadline is long enough for a short stall.

Do not send a Refund because of a drand stall. The operator does not trigger Refunds for a drand stall. The request stays Pending, and the worker fulfills it when the round is available. After the Deadline, anyone can call `timeoutRefund`, and the Escrow goes back to the Requester.

1. **Read the health of each relay.**

   ```sh
   for relay in https://api.drand.sh https://api2.drand.sh https://api3.drand.sh; do
     curl -s "$relay/v2/beacons/evmnet/health"; echo " $relay"
     curl -s "$relay/v2/beacons/evmnet/rounds/latest" | jq -c '{round}'
   done
   ```

   Verify: you know which relays answer, and the latest round of each relay. Compare it with `targetRound` in the alert.

2. **If one relay is down and the others are up, wait.** The worker tries the other relays.

   Verify: in 15 minutes, the `poll_result` lines show the request as fulfilled, and the `drand_stall` alert stops.

3. **If all relays are down, or the latest round does not increase, drand stalls.** Wait. Read the drand status page and the drand channels for news. Read the Pending requests and their Deadlines:

   ```sh
   contracts/script/pending-requests.sh "$RECORD" <keyHash of the Active Key>
   ```

   Verify: each request is fulfilled when the round is available, or it gets to its Deadline. A request that gets to its Deadline is [section 5](#5-a-request-missed-its-deadline).

4. **Post a short Incident Note** if the stall was longer than 1 hour or if a request missed its Deadline. Use the template below. A missed Deadline also gets its own note from [section 5](#5-a-request-missed-its-deadline).

   ```sh
   gh issue create --repo mangekyou-labs/rsk-vrf --label incident \
     --title "drand stall: rounds <first> to <last>" --body-file drand-note.md
   ```

   Verify: `gh issue list --repo mangekyou-labs/rsk-vrf --label incident --limit 1` shows the issue. If the stall was shorter than 1 hour and no request missed its Deadline, no note is necessary.

### Incident Note template: drand stall

```markdown
## What happened

From <time, UTC> to <time, UTC>, the drand `evmnet` chain did not publish rounds <first> to <last> on the relays <list>. The workers could not fulfill the requests with these Target Rounds.

## Effect on requests

The operator did not refund requests because of the stall. <Each request was fulfilled when its round was available. | List each request that missed its Deadline and link its note.>

## What we changed

<Nothing, because the cause was outside the service. | Change.>
```

## 5. A request missed its Deadline

The `missed_deadline` Page holds the request, the Deadline, the block and the withheld proof (`proof`), if the worker made it. A missed Deadline is the worst incident of the pilot: the Requester can refund, and a person can say that the operator did a Selective Abort. The Incident Note shows the output that the worker had.

Post the Incident Note **not more than 24 hours after the Deadline**.

1. **Save the alert as a file.** Get the log line from CloudWatch with the operator role:

   ```sh
   aws logs filter-log-events --region <region> --log-group-name /rsk-vrf/<host> \
     --filter-pattern '"missed_deadline"' --query 'events[-1].message' --output text > missed-<requestId>.json
   jq '{requestId, deadline, block, proofUnavailable, keyHash: .proof.keyHash}' missed-<requestId>.json
   ```

   Verify: `requestId` is the one in the Page. If `proof` is `null`, read `proofUnavailable` (for example, the drand round was not available) and go to step 4.

2. **Check the withheld proof against the chain and drand.**

   ```sh
   RPC_URL="$RPC_URL" npm run demo:check-withheld-proof --prefix worker -- "$PWD/missed-<requestId>.json"
   ```

   The script checks that:

   - The proof is for the request on chain and for its registered Proving Key.
   - The drand signature is the one that the relay publishes for the target round.
   - The ECVRF proof verifies, and Beta follows from it.

   Verify: the script ends with `RESULT {"valid":true,...}`. If a check fails, the script stops with the failed check. Do not publish a proof that fails. Write the failure in the note.

3. **Find why the worker did not fulfill.** Use sections 1 to 4. A refund after a Revocation is not a missed Deadline, and the worker does not page it.

   Verify: you know the cause, and you can write it in the note. If you do not know the cause, write that in the note and continue to look for it.

4. **Post the Incident Note.**

   ```sh
   gh issue create --repo mangekyou-labs/rsk-vrf --label incident \
     --title "Missed Deadline: request <requestId>" --body-file missed-note.md
   ```

   If `proof` was `null`, post the note now without the proof, and add the proof when the worker has it.

   Verify: `gh issue list --repo mangekyou-labs/rsk-vrf --label incident --limit 1` shows the issue, and its time is less than 24 hours after the Deadline.

### Incident Note template: missed Deadline

````markdown
## What happened

Request <requestId> missed its Deadline (block <deadline>). The workers did not fulfill it. Cause: <cause, from outage.md sections 1 to 4>.

The Requester can refund the Escrow with `timeoutRefund`. <It is refunded in <explorer link>. | It is not refunded yet.>

## Withheld proof

The worker had this output. It was not sent on chain.

- keyHash: <keyHash> (Proving Key <keyId>)
- Beta: <beta>

```json
<the `proof` object from missed-<requestId>.json>
```

Check it yourself, from a clone of the repository (Node 24 or later):

```sh
npm ci --prefix worker
RPC_URL=https://public-node.testnet.rsk.co npm run demo:check-withheld-proof --prefix worker -- "$PWD/proof.json"
```

The script reads the request and the Proving Key from the chain and the drand signature from the relay. It ends with `RESULT {"valid":true,...}`.

## What we changed

<Change, so that this does not occur again.>
````

## 6. Other Pages

1. **`key_registry_changed`**: a `KeyRegistered` or `KeyStateChanged` event. It is expected only after an Admin Safe transaction that you know about (a Rotation or a Revocation). If you do not know the transaction, look at it in the Admin Safe history (`transactionHash` is in the Page). If the Admin Safe did not plan it, treat it as a compromise of the Admin Safe: use [compromise.md](compromise.md), section 3, step 2.

   Verify: the transaction is in the Admin Safe history and has two known signers, and `cast call --rpc-url "$RPC_URL" "$PROXY" 'activeKeyId()(uint256)'` prints the keyId that you expect.

2. **`missing_proving_key`**: a request is bound to a key that the worker does not hold. Do [rotation.md](rotation.md), step 4 (`check-key`), on that host. If the secret does not load, put it again from the offline backup (rotation.md, step 3.2), then restart the host.

   Verify: `check-key` prints `loads and matches keyHash <keyHash>`, `aws logs tail /rsk-vrf/<host> --region <region> --since 5m --filter-pattern key_sync` shows the key with `"held":true`, and the Page stops.

3. **`drand_config_mismatch`**: the request uses a drand config that is not the `drand_pin` of the worker. Compare the `drand_pin` in `infra/terraform.tfvars` with the drand config on chain. Change nothing on chain. The Admin Safe sets the drand config.

   Verify: you know which value is wrong. After the correction, the `drand_pin` agrees with the drand config on chain, and the Page stops.

4. **Post a short Incident Note** for each of these Pages, except a `key_registry_changed` Page for a planned Rotation or Revocation. Use the template below.

   ```sh
   gh issue create --repo mangekyou-labs/rsk-vrf --label incident \
     --title "<alert name>: <host>" --body-file page-note.md
   ```

   Verify: `gh issue list --repo mangekyou-labs/rsk-vrf --label incident --limit 1` shows the issue.

### Incident Note template: other Pages

```markdown
## What happened

At <time, UTC>, the worker on <primary|backup> sent a `<alert name>` Page. Cause: <cause>.

## Effect on requests

<No request missed its Deadline. | List each missed Deadline and link its note.>

## What we changed

<Change, so that this does not occur again.>
```

## 7. Count the missed Deadlines

The missed-Deadline count is reported, with a target of 0 outside an announced outage window. Count it for a block range, for example the blocks of the pilot:

```sh
RPC_URL="$RPC_URL" npm run demo:missed-deadlines --prefix worker -- "$PWD/$RECORD" <fromBlock> <toBlock> \
  --exclude <first block of the outage window>-<last block of the outage window>
```

The script counts each request with a Deadline in the range that the workers did not fulfill: it is still Pending after its Deadline, or it was refunded after its Deadline. It uses the same rule as the `missed_deadline` Page, so a refund after a Revocation is not counted. Each `--exclude` removes the requests with a Deadline in that window. You can give `--exclude` more than one time.

Verify: the script prints one line `<requestId> deadline <block> <Pending|Refunded>` for each missed Deadline, then `<count> missed Deadline in blocks <fromBlock>..<toBlock>`, then a `RESULT` line. Each missed Deadline outside the excluded windows has an Incident Note from [section 5](#5-a-request-missed-its-deadline).

## Walkthrough record

**2026-10-29, rskj regtest, unit tests and a dry run.**

- `worker/integration/runbooks.test.ts` ("runbook tools on real rskj", second test) does section 5, step 2. On rskj regtest, with a local drand relay, a request misses its Deadline and the worker sends a `missed_deadline` Page with the proof. Results:
  - `check-withheld-proof.ts` accepts the Page as a file and prints `RESULT {"valid":true,...}`.
  - It refuses a proof with a changed Beta.
  - It also accepts only the `proof` object, and it refuses a changed proof.
- `worker/integration/runbooks.test.ts` ("runbook tools on real rskj", `missed-deadlines`) does section 7 on rskj regtest. Of four requests, one is fulfilled, one stays Pending after its Deadline, one is refunded after its Deadline, and one has its Deadline after the range. Results:
  - `missed-deadlines.ts` counts 2: the Pending request and the refunded request.
  - With `--exclude` over the Deadline of the refunded request, it counts 1.
  - It refuses a range that ends before it starts.
- `worker/integration/watchdog.test.ts` covers the alerts of each section: `low_balance`, `top_up_balance`, `drand_stall`, `pending_age`, `node_unhealthy`, `rpc_unhealthy`, `missed_deadline` with the proof in the Page and the JSON log line, and no Page for a refund after a Revocation.
- `worker/integration/watchdog.test.ts` ("stops the healthchecks.io heartbeat when the node stops answering") and `worker/test/loop.test.ts` cover the Dead-man's Switch: a heartbeat only after a completed poll, and no heartbeat after a failed or stalled poll. `worker/integration/regtest.test.ts` covers the Backup Worker with `GRACE_BLOCKS` 100 and a drand stall with no refund.
- Dry run only (no AWS account, Terraform, healthchecks.io or live drand stall on the walkthrough machine): sections 1 to 4 and section 6. The commands come from [infra/README.md](../../infra/README.md) and the alert names from `worker/src/worker.ts`. Do them on testnet at the pre-demo drill and correct this runbook.
- Fixes folded in: the `demo:check-withheld-proof` script accepts the Page, the log line, or only the `proof` object.
