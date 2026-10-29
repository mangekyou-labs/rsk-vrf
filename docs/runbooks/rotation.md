# Runbook: Rotation of the Proving Key

Use this runbook to replace the Active Key in the routine course of operation. The old key becomes a Draining Key and fulfills only the requests already bound to it. To respond to a compromised Proving Key, use [compromise.md](compromise.md). Revocation is not Rotation.

This is a testnet pilot. The coordinator is not externally audited.

## Before you start

You need:

- The Admin Safe (2-of-3) and two of its signers.
- The `rsk-vrf-operator` role (MFA) for Secrets Manager and CloudWatch Logs.
- The `rsk-vrf-host-access` role (MFA) for a shell on the hosts.
- The credentials you use for Terraform (see [infra/README.md](../../infra/README.md)).
- The Admin's machine, with `node` (24 or later), `age`, Foundry (`cast`) and `jq`, and two offline backup media.
- A funded throwaway key for the test request (see [docs/demo.md](../demo.md)).

Run all commands from the repository root. Set these first:

```sh
export RPC_URL=https://public-node.testnet.rsk.co   # operator reads and sends only; the workers never use it
RECORD=deployments/31.json
PROXY=$(jq -r .contracts.proxy.address "$RECORD")
OLD=0x...                                            # keyHash of the Active Key now
```

The deploy and hand-off of the coordinator are in [docs/development/deploy.md](../development/deploy.md).

## Steps

1. **Announce the Rotation in the Warn channel.** Post this text in the chat webhook channel:

   ```text
   Rotation of the Proving Key starts now. Old keyHash: <OLD>. Expect key_registry_changed Pages from both workers.
   ```

   Verify: the message is in the channel.

2. **Generate the new Proving Key on the Admin's machine.** Use a directory on an encrypted disk. `keygen` refuses to write the secret to a terminal.

   ```sh
   umask 077
   (cd worker && npm ci)
   node worker/src/main.ts keygen > proving-key.hex 2> proving-key.pub
   cat proving-key.pub
   NEW=$(sed -n 's/^keyHash: //p' proving-key.pub)
   ```

   `proving-key.pub` holds `publicKey: [<x>, <y>]` and `keyHash: <NEW>`. It is not secret.

   Verify: `wc -c < proving-key.hex` prints `67` (0x, 64 hex digits and a newline), and `echo "$NEW"` prints a keyHash.

3. **Write the secret to Secrets Manager in both regions, then to the two offline media.**

   1. Add the new keyHash (lowercase) to `proving_key_hashes` in `infra/terraform.tfvars`. Keep the old keyHash in the list. Then, with the Terraform credentials:

      ```sh
      cd infra && terraform plan -out=tfplan && terraform apply tfplan && cd ..
      ```

      Verify: the plan creates exactly two `aws_secretsmanager_secret.proving_key` resources (one for each host) and changes nothing else.

   2. With the operator role, put the secret in both regions:

      ```sh
      aws secretsmanager put-secret-value --region eu-central-1 --secret-id "rsk-vrf/proving-key/$NEW" --secret-string file://proving-key.hex
      aws secretsmanager put-secret-value --region us-east-1    --secret-id "rsk-vrf/proving-key/$NEW" --secret-string file://proving-key.hex
      ```

      Verify: each command prints a `VersionId`.

   3. Write the `age` backup to each medium. Use a different passphrase store for each medium:

      ```sh
      age -p -o "/Volumes/BACKUP-A/proving-key-$NEW.age" proving-key.hex
      age -p -o "/Volumes/BACKUP-B/proving-key-$NEW.age" proving-key.hex
      ```

   4. Decrypt each backup and compare it with the original:

      ```sh
      age -d "/Volumes/BACKUP-A/proving-key-$NEW.age" | cmp - proving-key.hex && echo BACKUP-A matches
      age -d "/Volumes/BACKUP-B/proving-key-$NEW.age" | cmp - proving-key.hex && echo BACKUP-B matches
      ```

      Verify: both lines print `matches`. If one does not, write that backup again.

   5. Delete `proving-key.hex` from the Admin's machine. Keep `proving-key.pub`.

4. **Do a dry run of `check-key` on both hosts.** The secret must load before you register the key. On each host, open a shell with the host-access role (`aws ssm start-session --region <eu-central-1|us-east-1> --target <instance_id>`), then:

   ```sh
   cd /opt/rsk-vrf
   sudo docker compose --env-file host.env --env-file worker-image.env run --rm --no-deps worker src/main.ts check-key <NEW>
   ```

   Verify: each host prints `check-key: rsk-vrf/proving-key/<NEW> loads and matches keyHash <NEW>`. If a host prints `cannot load`, do step 3.2 again for its region. Do not continue until both hosts pass.

5. **Register the new key from the Admin Safe.** The Payee is the Admin Safe. The new key becomes the Active Key and the old key becomes a Draining Key.

   ```sh
   contracts/script/safe-tx.sh "$RECORD" register <x> <y>
   ```

   The script does a call from the Admin Safe first. If the call reverts, it prints the reason and no transaction. Do not propose it. Find the cause.

   Otherwise it prints a summary with the keyHash and the Payee, then the `to`, `value` and `data` lines. Make sure the keyHash in the summary is `<NEW>`. In safe.rootstock.io, open the Admin Safe, then **New transaction**, then **Transaction Builder**. Enter the `to` address, value `0` and the `data` as custom data. Each signer compares `to` and `data` with the script output before signing. Execute the transaction.

   Verify:

   ```sh
   contracts/script/pending-requests.sh "$RECORD" <NEW>   # stderr: Proving Key <newId> (<NEW>) is Active
   contracts/script/pending-requests.sh "$RECORD" "$OLD"  # stderr: Proving Key <oldId> (<OLD>) is Draining
   cast call --rpc-url "$RPC_URL" "$PROXY" 'activeKeyId()(uint32)'   # prints <newId>
   ```

   Each worker also sends a `key_registry_changed` Page for `KeyRegistered` and for `KeyStateChanged`. This is expected.

6. **Make sure that both workers hold both keys and that a test request is fulfilled under the new keyHash.**

   1. Read the `key_sync` lines of each worker with the operator role:

      ```sh
      aws logs tail /rsk-vrf/primary --region eu-central-1 --since 15m --filter-pattern key_sync
      aws logs tail /rsk-vrf/backup  --region us-east-1    --since 15m --filter-pattern key_sync
      ```

      Verify: on each host, the latest lines show `"keyHash":"<NEW>","held":true` and `"keyHash":"<OLD>","held":true`. A line with `"held":false` means that the host did not load the key. Do step 4 again on that host, then restart it (`aws ssm send-command --region <region> --instance-ids <instance_id> --document-name AWS-RunShellScript --parameters 'commands=["systemctl restart rsk-vrf"]'`).

   2. Make a test request with the dice demo:

      ```sh
      DEMO_PRIVATE_KEY=0x... npm run demo:dice --prefix worker   # reads deployments/31.json
      ```

      Verify: the script prints `requestId <requestId>` and ends with a `RESULT` line. Read the key of the request:

      ```sh
      cast call --rpc-url "$RPC_URL" "$PROXY" 'getRequest(bytes32)((address,uint8,uint32,uint48,uint8,uint96,uint64,uint48,uint16,uint32,bytes32))' <requestId>
      ```

      The second field is `2` (Fulfilled) and the tenth field is `<newId>`.

   3. Make sure that no request of the old key stays Pending past its Deadline:

      ```sh
      contracts/script/pending-requests.sh "$RECORD" "$OLD"
      ```

      Verify: each listed request becomes Fulfilled before its Deadline. If a request misses its Deadline, use [outage.md](outage.md), section 5.

7. **When the old key is Retired, delete its online secret.** A Draining Key becomes a Retired Key 2400 blocks after the Rotation (about 20 hours on testnet).

   1. Make sure that the old key is Retired:

      ```sh
      contracts/script/pending-requests.sh "$RECORD" "$OLD"
      ```

      Verify: stderr shows `is Retired` and `0 Pending`. If it shows `is Draining`, wait.

   2. Remove the old keyHash from `proving_key_hashes` in `infra/terraform.tfvars`. Then, with the Terraform credentials:

      ```sh
      cd infra && terraform plan -out=tfplan && terraform apply tfplan && cd ..
      ```

      Verify: the plan destroys exactly the two `aws_secretsmanager_secret.proving_key` resources of `<OLD>` and changes nothing else. After the apply:

      ```sh
      aws secretsmanager describe-secret --region eu-central-1 --secret-id "rsk-vrf/proving-key/$OLD" --query DeletedDate
      aws secretsmanager describe-secret --region us-east-1    --secret-id "rsk-vrf/proving-key/$OLD" --query DeletedDate
      ```

      Each command prints a date (the secret is scheduled for deletion).

   3. Keep the two offline `age` backups of the old key until the pilot ends.

8. **Announce the Rotation in public.** A routine Rotation is not an incident. Do not use the `incident` label. Post a public note, so that consumers can match the new keyHash. Use the template below.

   ```sh
   gh issue create --repo mangekyou-labs/rsk-vrf \
     --title "Rotation: Proving Key <oldId> to <newId>" --body-file rotation-note.md
   gh issue close --repo mangekyou-labs/rsk-vrf <issue number> --reason completed
   ```

   Verify: `gh issue list --repo mangekyou-labs/rsk-vrf --state closed --search "Rotation: Proving Key <oldId> to <newId>" --limit 1` shows the issue, and it has no labels.

## Public note template: Rotation

```markdown
## What happened

On <date, UTC> the Admin Safe made Proving Key <newId> the Active Key. This was a routine Rotation. Proving Key <oldId> is not compromised.

- New keyHash: <NEW>
- Old keyHash: <OLD> (Draining from block <block>, Retired from block <block + 2400>)
- Admin Safe transaction: <explorer link>

## Effect on requests

Requests made before block <block> stay bound to Proving Key <oldId>, and the workers fulfill them with it. New requests are bound to Proving Key <newId>. No request was refunded because of the Rotation.
```

## Walkthrough record

**2026-10-29, rskj regtest and a dry run.**

- `worker/integration/runbooks.test.ts` ("runbook tools on real rskj") does steps 5 and 6 on rskj regtest, with a Safe stand-in contract in place of the Admin Safe. It deploys with `deploy.sh` and uses `safe-tx.sh` and `pending-requests.sh` as written here. Results:
  - Before the Admin Safe accepts ownership, `safe-tx.sh` refuses to print the transaction.
  - The `register` summary shows the keyHash and the Payee (the Admin Safe).
  - After the register, the old key is Draining, the new key is Active and `activeKeyId()` is the new keyId.
  - A second `register` of the same key is refused before it gets to the signers.
  - `pending-requests.sh` lists the request of the old key with its Deadline.
- `worker/integration/regtest.test.ts` ("worker regtest: key rotation and revocation") covers the worker side of step 6:
  - After the Rotation, the worker fulfills the Pending request with the old key and a new request with the new key.
  - The worker holds every Active and Draining key and follows `KeyStateChanged`.
  - A key that the secret store does not have is reported with `"held":false`.
- By hand on rskj regtest, against a deployment from `deploy.sh`: `node worker/src/main.ts keygen` with stdout to a file (67 bytes, and `proving-key.pub` gives the `publicKey` and `keyHash` lines that step 2 reads), then the `cast call` lines for `activeKeyId()` and `getRequest(bytes32)`. The status is the second field and the keyId is the tenth field, in the order of the `Request` struct.
- Dry run only (no AWS account, Terraform, `age` or Safe UI on the walkthrough machine): steps 1 to 4, 6.1, 7.2, 7.3 and 8. The commands come from [infra/README.md](../../infra/README.md) and the worker CLI (`worker/src/cli.ts`). Do them on testnet at the pre-demo drill, log each step in [drill-log.md](drill-log.md), and correct this runbook.
- Fixes folded in: `safe-tx.sh` now refuses a transaction that reverts from the Admin Safe. `pending-requests.sh` reads the keyId from `KeyRegistered`, because the coordinator has no view from keyHash to keyId.
