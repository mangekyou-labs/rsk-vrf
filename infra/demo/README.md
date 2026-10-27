# Demo host

A small, separate stack for testnet demos. It runs the worker alone on one
`t3.micro`. The worker reads Rootstock through a public RPC node and signs with
a Fulfiller private key that SSM Parameter Store keeps. Use the production stack
in [`infra/`](../README.md) for mainnet.

|                    | Demo (this directory)                  | Production (`infra/`)                       |
| ------------------ | -------------------------------------- | ------------------------------------------- |
| Hosts              | 1 `t3.micro`, `us-east-1`              | Primary Worker and Backup Worker, 2 regions |
| Rootstock node     | public RPC (`rsk_rpc_url`)             | own rskj on each host                       |
| Fulfiller key      | private key in an SSM SecureString     | KMS key, the key never leaves KMS           |
| Disk               | 10 GB root                             | root plus a 200 GB data volume per host     |
| Terraform state    | local file                             | S3 backend                                  |

## Cost

On-demand prices in `us-east-1`, about 730 hours a month:

| Item                         | Monthly |
| ---------------------------- | ------- |
| `t3.micro`, standard credits | $7.59   |
| 10 GB gp3 root volume        | $0.80   |
| Public IPv4 address          | $3.65   |
| Each Proving Key secret      | $0.40   |
| SSM parameters, logs         | ~$0     |

That is about $12 a month for one Proving Key. A new AWS account on the Free
plan gets credits that pay for this for some months.

## Apply

Use an AWS account, or a region, that does not hold the production stack. The
Proving Key secret names are the same in both stacks, so they would collide.

```sh
cd infra/demo
cp terraform.tfvars.example terraform.tfvars   # then fill it in
terraform init
terraform plan -out tfplan
terraform apply tfplan
```

The state file stays in this directory. Keep it; `terraform destroy` needs it.

## After the first apply

The worker does not start until these steps are done. Terraform creates each
secret with a placeholder and does not read it back after that.

1. Put the Fulfiller private key. Use a key that holds testnet funds only.
   Read it from a file, so that it does not go into your shell history:

   ```sh
   aws ssm put-parameter --overwrite --type SecureString \
     --name /rsk-vrf/demo/FULFILLER_PRIVATE_KEY --value "file://fulfiller.key"
   ```

2. Put the alert URLs. Free services are sufficient for a demo, for example
   an [ntfy.sh](https://ntfy.sh) topic for alerts and a
   [healthchecks.io](https://healthchecks.io) check for the heartbeat:

   ```sh
   for name in ALERT_PAGE_URL ALERT_WARNING_URL HEALTHCHECKS_PING_URL; do
     aws ssm put-parameter --overwrite --type SecureString \
       --name "/rsk-vrf/demo/$name" --value "<url>"
   done
   ```

3. Put each Proving Key:

   ```sh
   aws secretsmanager put-secret-value \
     --secret-id "rsk-vrf/proving-key/<keyHash>" --secret-string "file://proving.key"
   ```

4. Send testnet RBTC to the Fulfiller address from
   [faucet.rootstock.io](https://faucet.rootstock.io).

5. Restart the worker:

   ```sh
   aws ssm send-command --document-name AWS-RunShellScript \
     --instance-ids "$(terraform output -raw instance_id)" \
     --parameters 'commands=["systemctl restart rsk-vrf"]'
   ```

6. Read the logs. You see `key_sync` and then `polling`:

   ```sh
   aws logs tail "$(terraform output -raw log_group)" --follow
   ```

## Deploying a new worker image

Set `worker_image` in `terraform.tfvars` to the new digest, apply, then restart
the worker as in step 5. The host refuses an image that is not a
`ghcr.io/<ghcr_owner>/rsk-vrf-worker@sha256:` digest.

## Taking it down

```sh
terraform destroy
```

This deletes the Proving Key secrets at once, with no recovery window. Keep a
copy of each Proving Key if you need it again.

## Things to know

- Anyone who can read `/rsk-vrf/demo/FULFILLER_PRIVATE_KEY`, or who can open
  a shell on the host, can sign as the Fulfiller. Do not use a key that holds
  mainnet funds.
- A public RPC node can limit the rate of requests. If the logs show RPC
  errors, set `rsk_rpc_url` to a different node.
- The host has 1 GB of memory and 1 GB of swap. This is sufficient for the
  worker alone, not for rskj.
