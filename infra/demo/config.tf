# Worker configuration, Proving Key placeholders and logs.
#
# As in infra/: secrets are created with a placeholder and set out of band
# (README.md); Terraform ignores later changes, so no secret enters state.

locals {
  # The worker reads every parameter directly under parameter_path as an
  # environment variable of the same name.
  config = {
    WORKER_ID            = "demo"
    GRACE_BLOCKS         = "0"
    RSK_RPC_URL          = var.rsk_rpc_url
    COORDINATOR_ADDRESS  = var.coordinator_address
    DRAND_PIN_PUBLIC_KEY = var.drand_pin.public_key
    DRAND_PIN_GENESIS    = tostring(var.drand_pin.genesis)
    DRAND_PIN_PERIOD     = tostring(var.drand_pin.period)
  }

  # Set out of band. The worker refuses to start while any holds the placeholder.
  # FULFILLER_PRIVATE_KEY stands in for the KMS key of the production hosts:
  # use a testnet-only key.
  secret_config = toset([
    "FULFILLER_PRIVATE_KEY",
    "ALERT_PAGE_URL",
    "ALERT_WARNING_URL",
    "HEALTHCHECKS_PING_URL",
  ])

  placeholder = "unset: put the real value with aws ssm put-parameter --overwrite"
}

resource "aws_ssm_parameter" "config" {
  for_each = local.config

  name           = "${local.parameter_path}/${each.key}"
  type           = "String"
  insecure_value = each.value
}

resource "aws_ssm_parameter" "secret_config" {
  for_each = local.secret_config

  name  = "${local.parameter_path}/${each.key}"
  type  = "SecureString"
  value = local.placeholder

  lifecycle {
    ignore_changes = [value]
  }
}

# Read by the host's rsk-vrf-up before each start. It sits one level down, so
# the worker's non-recursive read skips it.
resource "aws_ssm_parameter" "worker_image" {
  name           = "${local.parameter_path}/host/WORKER_IMAGE"
  type           = "String"
  insecure_value = var.worker_image
}

# Empty secrets: put each Proving Key with aws secretsmanager put-secret-value.
resource "aws_secretsmanager_secret" "proving_key" {
  for_each = toset(var.proving_key_hashes)

  name                    = "rsk-vrf/proving-key/${each.key}"
  description             = "rsk-vrf demo Proving Key ${each.key}"
  recovery_window_in_days = 0
}

resource "aws_cloudwatch_log_group" "host" {
  name              = local.log_group
  retention_in_days = 7
}
