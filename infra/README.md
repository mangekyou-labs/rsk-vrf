# AWS hosting

Two worker hosts, `primary` (eu-central-1, `GRACE_BLOCKS=0`) and `backup`
(us-east-1, `GRACE_BLOCKS=100`). Each one is an m7i.large running rskj and the
worker under Docker Compose, with its own KMS Fulfiller key, Proving Key secrets,
SSM parameters and CloudWatch log group. The only inbound port is 50505 (rskj
peers); operators reach the hosts through SSM Session Manager, never SSH.

| Path | What it is |
| --- | --- |
| `main.tf`, `variables.tf` | The two regions and their inputs |
| `operator.tf` | `rsk-vrf-operator` role: key admin, writes Secrets and parameters, cannot sign |
| `modules/worker-host/` | One host: VPC, security group, EC2, data volume, KMS key, IAM, parameters, secrets, logs |
| `modules/worker-host/cloud-init.yaml.tftpl` | Mounts `/data`, installs Docker, writes the `rsk-vrf` systemd unit |
| `compose/compose.yaml` | rskj (`VETIVER-9.0.4`, pinned by digest) and the worker (pinned by digest) |

Secret values never pass through Terraform. It creates empty Secrets Manager
secrets and SecureString parameters holding the text `unset: ...`; the operator
puts the real values with the AWS CLI after apply, and Terraform ignores them
from then on.

## Before the first apply

1. An S3 bucket for state, with versioning on. Copy `backend.hcl.example` to
   `backend.hcl` and fill in the bucket.
2. A worker image digest. The `Worker image` workflow pushes
   `ghcr.io/<owner>/rsk-vrf-worker:sha-<commit>` from main and prints the digest
   in its job summary. The GHCR package must be public, or the hosts cannot pull it.
3. Copy `terraform.tfvars.example` to `terraform.tfvars` and fill in
   `worker_image` (the `@sha256:` form), `coordinator_address`, `drand_pin` and
   `proving_key_hashes` (lowercase keyHashes).

## Apply

```sh
cd infra
terraform init -backend-config=backend.hcl
terraform plan -out=tfplan
terraform apply tfplan
terraform output
```

Run this with administrator credentials. Day-to-day work afterwards uses the
operator role (`terraform output operator_role_arn`, MFA required).

## After the first apply

Run these once per host (`primary` in eu-central-1, `backup` in us-east-1).

1. Derive the Fulfiller address from the KMS public key, using the worker image:

   ```sh
   docker run --rm -e AWS_REGION=eu-central-1 -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN \
     -e KEY=alias/rsk-vrf-primary-fulfiller <worker_image> --input-type=module -e \
     "import { KMSClient } from '@aws-sdk/client-kms'; import { kmsAccount } from './src/kms-signer.ts'; \
      console.log((await kmsAccount({ kms: new KMSClient({}), keyId: process.env.KEY })).address)"
   ```

2. Put both Fulfiller addresses (comma-separated) in each host's
   `OWN_FULFILLER_ADDRESSES`, and the alert URLs:

   ```sh
   aws ssm put-parameter --region eu-central-1 --overwrite --name /rsk-vrf/primary/OWN_FULFILLER_ADDRESSES --value 0xPRIMARY,0xBACKUP
   aws ssm put-parameter --region eu-central-1 --overwrite --name /rsk-vrf/primary/ALERT_PAGE_URL --value https://ntfy.example/<topic>
   aws ssm put-parameter --region eu-central-1 --overwrite --name /rsk-vrf/primary/ALERT_WARNING_URL --value https://chat.example/webhook
   aws ssm put-parameter --region eu-central-1 --overwrite --name /rsk-vrf/primary/HEALTHCHECKS_PING_URL --value https://hc-ping.com/<uuid>
   # Optional, only if the ntfy topic needs a token:
   aws ssm put-parameter --region eu-central-1 --type SecureString --name /rsk-vrf/primary/ALERT_PAGE_TOKEN --value <token>
   ```

   Each host needs its own healthchecks check (1 minute period, 4 minute grace).

3. Put each Proving Key in both regions. Read the key from a file so it stays out
   of shell history:

   ```sh
   aws secretsmanager put-secret-value --region eu-central-1 --secret-id rsk-vrf/proving-key/<keyHash> --secret-string file://proving-key.hex
   aws secretsmanager put-secret-value --region us-east-1    --secret-id rsk-vrf/proving-key/<keyHash> --secret-string file://proving-key.hex
   ```

4. Fund both Fulfillers with RBTC.
5. Run Import Sync (below) on each host, then start the stack:

   ```sh
   aws ssm send-command --region eu-central-1 --instance-ids <instance_id> \
     --document-name AWS-RunShellScript --parameters 'commands=["systemctl restart rsk-vrf"]'
   ```

The worker reads its parameters only at start, so restart `rsk-vrf` after any
parameter or secret change.

## Import Sync

rskj's `--import` deletes the database and imports a snapshot on every start
while the flag is set, so it runs as a separate one-shot `rskj-import` service
that is never left running. In a shell on the host
(`aws ssm start-session --target <instance_id>`):

```sh
cd /opt/rsk-vrf
sudo docker compose --env-file host.env --env-file worker-image.env stop worker rskj
sudo docker compose --env-file host.env --env-file worker-image.env --profile import up -d rskj-import
sudo docker compose --env-file host.env --env-file worker-image.env --profile import logs -f rskj-import
# When the import has finished and the node is syncing blocks normally:
sudo docker compose --env-file host.env --env-file worker-image.env --profile import rm -sf rskj-import
sudo /usr/local/bin/rsk-vrf-up
```

## Deploying a new worker image

Set `worker_image` to the new digest, `terraform apply` (this only changes the
`/rsk-vrf/<host>/host/WORKER_IMAGE` parameter), then `systemctl restart rsk-vrf`
on each host. Roll `backup` first and check it before `primary`.

## Things to know

- The KMS keys have `prevent_destroy` and the instances have API termination
  protection. Losing a key loses its Fulfiller address.
- Only the host's own role can call `kms:Sign` on its key; the key policy denies
  everyone else, including the account root. The operator role cannot sign,
  create grants or change key policies. An operator with an SSM shell on a host
  can still use the host's role from that shell.
- The operator role can write Secrets but not read them.
- Instances ignore AMI updates. Replacing a host keeps its data volume and key,
  but rskj and the worker restart.
- rskj RPC is published on the host's loopback only (`127.0.0.1:4444`).

## Provisioning checklist

Fill these in during the first live apply on chain 31 (testnet).

| Check | primary | backup |
| --- | --- | --- |
| `terraform apply` date and commit | _TBD_ | _TBD_ |
| Worker image digest | _TBD_ | _TBD_ |
| Fulfiller address | _TBD_ | _TBD_ |
| `/data` mounted from the data volume (`lsblk`, `df -h /data`, `/etc/fstab` UUID entry) | _TBD_ | _TBD_ |
| rskj data under `/data/rskj`, owned by uid 1001 | _TBD_ | _TBD_ |
| Import Sync in Docker: start, finish, duration | _TBD_ | _TBD_ |
| rskj disk size after Import Sync (`du -sh /data/rskj`) | _TBD_ | _TBD_ |
| rskj disk growth per day on chain 31 (two `du` readings, 24 h apart) | _TBD_ | _TBD_ |
| Projected days until 250 GB is full | _TBD_ | _TBD_ |
| Node synced to the chain head (`eth_blockNumber` vs explorer) | _TBD_ | _TBD_ |
| A request fulfilled by the KMS Fulfiller on chain 31 (tx hash) | _TBD_ | _TBD_ |
| Worker and rskj logs arriving in CloudWatch (`/rsk-vrf/<host>`) | _TBD_ | _TBD_ |
| healthchecks pings arriving | _TBD_ | _TBD_ |
| Only 50505 open inbound (security group, external port scan) | _TBD_ | _TBD_ |
