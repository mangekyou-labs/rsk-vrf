# Runbook: compromise

Use this runbook when a secret or a signer is possibly exposed. There are three cases:

1. [The Proving Key leaked](#1-the-proving-key-leaked). Do Revocation first.
2. [A Fulfiller key leaked](#2-a-fulfiller-key-leaked). Nothing changes on chain.
3. [The device of an Admin Safe signer is lost](#3-the-device-of-an-admin-safe-signer-is-lost).

Signs of a leaked Proving Key are a `foreign_fulfillment` Page (a Fulfiller that is not in `OWN_FULFILLER_ADDRESSES` fulfilled a request) or an access to `rsk-vrf/proving-key/*` that is not from a host role. If you are not sure, treat the key as leaked. A Revocation that was not necessary costs one Rotation. A leaked key that stays Active can do a Selective Abort.

This is a testnet pilot. The coordinator is not externally audited.

Set these first, from the repository root:

```sh
export RPC_URL=https://public-node.testnet.rsk.co   # operator reads and sends only; the workers never use it
RECORD=deployments/31.json
PROXY=$(jq -r .contracts.proxy.address "$RECORD")
LOGS_RPC_URL=<an RPC of chain 31 that serves eth_getLogs>
```

The public node does not serve `eth_getLogs`. `pending-requests.sh` and the demo scripts read event logs, so run them with `RPC_URL="$LOGS_RPC_URL"`. Check it first:

```sh
cast logs --rpc-url "$LOGS_RPC_URL" --address "$PROXY" \
  --from-block "$(jq .contracts.proxy.block "$RECORD")" --to-block "$(jq .contracts.proxy.block "$RECORD")"
```

Verify: the command prints the logs of the proxy creation and no error.

## 1. The Proving Key leaked

1. **Revoke the key first.** Do this before all other steps. Get the transaction for the Admin Safe:

   ```sh
   LEAKED=0x...   # keyHash of the leaked key
   contracts/script/safe-tx.sh "$RECORD" revoke "$LEAKED"
   ```

   If the script prints `the call reverts when the Admin Safe sends it`, read the reason. `UnknownKey` means the keyHash is wrong. `InvalidKeyTransition` means the key is already Revoked or Retired.

   Otherwise, in safe.rootstock.io, open the Admin Safe, then **New transaction**, then **Transaction Builder**. Enter the `to` address, value `0` and the `data` as custom data. Each signer compares `to` and `data` with the script output before signing. Execute the transaction.

   Verify:

   ```sh
   RPC_URL="$LOGS_RPC_URL" contracts/script/pending-requests.sh "$RECORD" "$LEAKED"         # stderr: Proving Key <keyId> (<LEAKED>) is Revoked
   cast call --rpc-url "$RPC_URL" "$PROXY" 'activeKeyId()(uint32)'   # 0 if the leaked key was the Active Key
   ```

   Both workers send a `key_registry_changed` Page for `KeyStateChanged`. The workers stop all proofs for the Revoked key. If `activeKeyId()` is `0`, there is no Active Key and all new requests revert. Do step 2 immediately.

2. **Do the Rotation.** Do [rotation.md](rotation.md) from step 2 to step 6. Step 6.3 does not apply, because a Revoked key fulfills nothing. Step 7 does not apply, because step 4 below deletes the leaked secret.

   Verify: `cast call --rpc-url "$RPC_URL" "$PROXY" 'activeKeyId()(uint32)'` prints the new keyId, and the test request of rotation.md step 6.2 is Fulfilled under the new keyHash.

3. **Refund every Pending request of the Revoked key.** A request bound to a Revoked key is refundable at once. Anyone can call `timeoutRefund`. The Escrow goes back to the Requester, not to the caller. Send the refunds from the Operator Funding Wallet:

   ```sh
   RPC_URL="$LOGS_RPC_URL" contracts/script/pending-requests.sh "$RECORD" "$LEAKED" | while read -r id _; do
     cast send --rpc-url "$RPC_URL" --ledger "$PROXY" 'timeoutRefund(bytes32)' "$id"
   done
   ```

   Each line of the list must show `refundable now (KeyRevoked)`. If a line shows a different text, the key is not Revoked. Do step 1 again.

   Verify: `RPC_URL="$LOGS_RPC_URL" contracts/script/pending-requests.sh "$RECORD" "$LEAKED"` prints no lines and `0 Pending` on stderr. A Requester can also refund before you. That is correct.

4. **Delete the leaked secret, review CloudTrail and rotate IAM.**

   1. Delete the secret in both regions at once, with the operator role:

      ```sh
      aws secretsmanager delete-secret --region eu-central-1 --secret-id "rsk-vrf/proving-key/$LEAKED" --force-delete-without-recovery
      aws secretsmanager delete-secret --region us-east-1    --secret-id "rsk-vrf/proving-key/$LEAKED" --force-delete-without-recovery
      ```

      Then remove `$LEAKED` from `proving_key_hashes` in `infra/terraform.tfvars`, and do `terraform plan`. If you do not remove it, the next apply makes the secret again, with no value.

      Verify: `aws secretsmanager describe-secret --region <region> --secret-id "rsk-vrf/proving-key/$LEAKED"` fails with `ResourceNotFoundException` in both regions, and the plan shows no change to the Proving Key secrets. Destroy the two offline `age` backups of the leaked key.

   2. Find each read of a Proving Key secret since the leaked key was made:

      ```sh
      for region in eu-central-1 us-east-1; do
        aws cloudtrail lookup-events --region "$region" --start-time <date the key was made> \
          --lookup-attributes AttributeKey=EventName,AttributeValue=GetSecretValue \
          --query 'Events[].[EventTime,Username,Resources[0].ResourceName]' --output text
      done
      ```

      Also look up `StartSession` (shells on the hosts) and `AssumeRole` for `rsk-vrf-host-access`.

      Verify: each `GetSecretValue` comes from the host role of that region. Each `StartSession` has a known person and reason. Write down each event that does not.

   3. Rotate the access that the review names. The two roles trust each identity in the account that has MFA, so the access is set on the identity, not on the role. For each identity that the review names, remove its permission to assume `rsk-vrf-host-access` and `rsk-vrf-operator`, deactivate its access keys and replace its MFA device. If the leak came through a host shell, also do [section 2](#2-a-fulfiller-key-leaked) for that host, because a host shell can sign as its Fulfiller.

      Verify: `aws iam list-access-keys --user-name <user>` shows each old key as `Inactive`, and an `aws sts assume-role` to each role with the old credentials fails.

5. **Post an Incident Note with the reason for the Revocation, not more than 24 hours after step 1.**

   ```sh
   gh issue create --repo mangekyou-labs/rsk-vrf --label incident \
     --title "Revocation of Proving Key <keyId>" --body-file revocation-note.md
   ```

   Verify: `gh issue list --repo mangekyou-labs/rsk-vrf --label incident --limit 1` shows the issue.

### Incident Note template: Revocation

```markdown
## What happened

On <date, UTC> the Admin Safe revoked Proving Key <keyId> (keyHash <LEAKED>).

Reason: <what was exposed, how we found it, and when>.

- Revocation transaction: <explorer link>
- New Active Key: <newId>, keyHash <NEW>, from block <block>

## Effect on requests

The Revoked key can fulfill nothing. Its <n> Pending requests were refunded to their Requesters with `timeoutRefund` (reason KeyRevoked):

| requestId | Refund transaction |
| --- | --- |
| <requestId> | <explorer link> |

Requests that the key fulfilled before the Revocation keep their Beta. <State if the leak makes any of them doubtful, and why.>

## What we changed

<CloudTrail review result. Access removed. Other changes.>
```

## 2. A Fulfiller key leaked

A Fulfiller has no authority over outputs. A leaked Fulfiller can spend its own RBTC and send fulfillments that the coordinator still verifies. Nothing changes on chain. The other host is the Backup Worker (or the Primary Worker) while you do this.

Set `HOST` to `primary` (eu-central-1) or `backup` (us-east-1), and `REGION` to its region.

1. **Disable the KMS key.** With the operator role:

   ```sh
   KEY_ARN=$(cd infra && terraform output -json hosts | jq -r ".$HOST.fulfiller_key_arn")
   aws kms disable-key --region "$REGION" --key-id "$KEY_ARN"
   ```

   Verify: `aws kms describe-key --region "$REGION" --key-id "$KEY_ARN" --query KeyMetadata.KeyState` prints `"Disabled"`. The worker on this host can no longer send fulfillments. Its CloudWatch log `/rsk-vrf/$HOST` shows the failures.

2. **Make sure that the other host fulfills the requests.** Read the last fulfillments of the other host:

   ```sh
   aws logs tail /rsk-vrf/<other host> --region <other region> --since 30m --filter-pattern poll_result
   ```

   Verify: requests are fulfilled. If the disabled host was the Primary Worker, the Backup Worker fulfills each request after `GRACE_BLOCKS` (100 blocks).

3. **Make a new Fulfiller key with Terraform.** The old key has `prevent_destroy`, so remove it from the Terraform state. It stays in AWS, disabled. Then apply to make a new key, with the same key policy, and to move the alias to it:

   ```sh
   cd infra
   terraform state rm "module.$HOST.aws_kms_key.fulfiller"
   terraform plan -out=tfplan && terraform apply tfplan
   cd ..
   ```

   Verify: the plan creates one `aws_kms_key.fulfiller`, updates one `aws_kms_alias.fulfiller` and changes nothing else. `aws kms describe-key --region "$REGION" --key-id "alias/rsk-vrf-$HOST-fulfiller" --query KeyMetadata.KeyId` prints a key that is not the old one.

4. **Fund the new Fulfiller.** Get its address with the `docker run` command in [infra/README.md](../../infra/README.md), "After the first apply", step 1, with `KEY=alias/rsk-vrf-$HOST-fulfiller`. Send RBTC from the Operator Funding Wallet:

   ```sh
   cast send --rpc-url "$RPC_URL" --ledger <new Fulfiller> --value 0.01ether
   ```

   Verify: `cast balance --rpc-url "$RPC_URL" --ether <new Fulfiller>` prints the amount.

5. **Update `OWN_FULFILLER_ADDRESSES` on both hosts, then restart.** Remove the old address, so a fulfillment from the leaked Fulfiller gives a `foreign_fulfillment` Page. With the operator role:

   ```sh
   aws ssm put-parameter --region eu-central-1 --overwrite --name /rsk-vrf/primary/OWN_FULFILLER_ADDRESSES --value 0xPRIMARY,0xBACKUP
   aws ssm put-parameter --region us-east-1    --overwrite --name /rsk-vrf/backup/OWN_FULFILLER_ADDRESSES  --value 0xPRIMARY,0xBACKUP
   ```

   Then restart both hosts with the host-access role. Restart the host that did not change first:

   ```sh
   aws ssm send-command --region <region> --instance-ids <instance_id> \
     --document-name AWS-RunShellScript --parameters 'commands=["systemctl restart rsk-vrf"]'
   ```

   Verify: `aws logs tail /rsk-vrf/$HOST --region "$REGION" --since 10m --filter-pattern polling` shows a new `polling` line, and the next fulfillment of this host comes from the new Fulfiller (`cast tx --rpc-url "$RPC_URL" <fulfill transaction> from`).

6. **Find the cause.** Do [section 1](#1-the-proving-key-leaked), steps 4.2 and 4.3, for `kms:Sign` and `StartSession` in place of `GetSecretValue`. A host shell can read the Proving Key. If a shell on the host is not explained, treat the Proving Key as leaked and do section 1.

   Verify: each event has a known person and reason, or you started section 1.

7. **Post a short Incident Note.** Use the template below.

   Verify: `gh issue list --repo mangekyou-labs/rsk-vrf --label incident --limit 1` shows the issue.

The RBTC on the old Fulfiller stays there while its key is disabled. Keep each Fulfiller balance small.

### Incident Note template: Fulfiller key

```markdown
## What happened

On <date, UTC> we disabled the Fulfiller key of the <primary|backup> worker (<old address>). Reason: <what was exposed>.

A Fulfiller has no authority over outputs. The Proving Key <is not | is also> affected. <If it is, link the Revocation note.>

## Effect on requests

From block <block> to block <block>, the <other> worker fulfilled the requests. <No request missed its Deadline. | List each missed Deadline and link its note.>

The new Fulfiller is <new address>.
```

## 3. The device of an Admin Safe signer is lost

The Admin Safe is 2-of-3. One lost device does not let anyone act as Admin alone, but a second loss stops the Admin. Replace the signer at once.

1. **Replace the signer.** The two remaining signers use safe.rootstock.io: **Settings**, then **Setup**, then **Manage signers**, then **Replace signer** on the lost signer. Enter the address of the new signer (a new hardware wallet). Keep the threshold at 2. Both remaining signers sign and execute.

   Verify:

   ```sh
   SAFE=$(jq -r .safe "$RECORD")
   cast call --rpc-url "$RPC_URL" "$SAFE" 'getOwners()(address[])'     # the two remaining signers and the new signer
   cast call --rpc-url "$RPC_URL" "$SAFE" 'getThreshold()(uint256)'    # 2
   cast call --rpc-url "$RPC_URL" "$PROXY" 'owner()(address)'          # still the Admin Safe
   ```

2. **Look for Admin Safe transactions that you did not expect.** Open the transaction history of the Admin Safe, and read the `key_registry_changed` Pages since the loss.

   Verify: each transaction since the loss has two known signers. If a Key Registry change is not explained, do [section 1](#1-the-proving-key-leaked) for the key it added.

3. **Post a short Incident Note.** Use the template below.

   ```sh
   gh issue create --repo mangekyou-labs/rsk-vrf --label incident \
     --title "Admin Safe signer replaced" --body-file safe-signer-note.md
   ```

   Verify: `gh issue list --repo mangekyou-labs/rsk-vrf --label incident --limit 1` shows the issue.

### Incident Note template: Admin Safe signer

```markdown
## What happened

On <date, UTC> the device of one Admin Safe signer (<old signer address>) was lost. The Admin Safe is 2-of-3, so one signer alone cannot act as Admin.

- Replacement transaction: <explorer link>
- New signer: <new signer address>
- Threshold: 2 of 3

## Effect on the coordinator

<Each Admin Safe transaction since the loss has two known signers. | List each transaction that was not expected, and link the Revocation note.>
```

## Walkthrough record

**2026-10-29, rskj regtest and a dry run.**

- `worker/integration/runbooks.test.ts` ("runbook tools on real rskj") does section 1, steps 1 to 3, on rskj regtest, with a Safe stand-in contract in place of the Admin Safe. It deploys with `deploy.sh`, then makes a request, does the Rotation, and revokes the old key with `safe-tx.sh`. Results:
  - `pending-requests.sh` lists the request of the Revoked key.
  - `timeoutRefund` refunds it at once with reason KeyRevoked, before its Deadline.
  - The list is then empty.
  - An unknown keyHash is an error, not an empty list.
- By hand on rskj regtest, against a deployment from `deploy.sh`: the `revoke` transaction from `safe-tx.sh`, `activeKeyId()` after the Revocation of the Active Key (it printed `0`), and the refund loop of step 3 with `cast send` (with a test key in place of `--ledger`). After the loop, the request status was `3` (Refunded) and the list showed `0 Pending`.
- `worker/integration/regtest.test.ts` ("worker regtest: key rotation and revocation") covers the worker side: after the Revocation the worker stops, and the Pending request is refunded before its Deadline. `worker/integration/watchdog.test.ts` covers the `key_registry_changed` and `foreign_fulfillment` Pages, and that a refund after a Revocation is not a missed Deadline.
- Dry run only (no AWS account, Terraform, `age` or Safe UI on the walkthrough machine): section 1, steps 4 and 5; all of section 2; all of section 3.
- Not confirmed: the Terraform steps of section 2, step 3 (`terraform state rm` of the old key, then a new key and the alias moved). Do them in a test account before they are necessary, and correct this runbook.
- Fixes folded in: the refund loop reads the list from `pending-requests.sh`, which shows if a request is refundable now. `safe-tx.sh` refuses a `revoke` for a key that is not registered or not Active or Draining.
