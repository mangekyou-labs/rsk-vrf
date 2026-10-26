# Worker configuration, Proving Key placeholders and logs.
#
# Terraform owns the non-secret parameters. Anything secret is created here
# with a placeholder and set out of band (infra/README.md); Terraform ignores
# later changes to it, so no secret value ever enters code or state.

locals {
  # The worker reads every parameter directly under parameter_path as an
  # environment variable of the same name.
  config = {
    WORKER_ID            = var.name
    GRACE_BLOCKS         = tostring(var.grace_blocks)
    RSK_RPC_URL          = "http://rskj:4444"
    COORDINATOR_ADDRESS  = var.coordinator_address
    DRAND_PIN_PUBLIC_KEY = var.drand_pin.public_key
    DRAND_PIN_GENESIS    = tostring(var.drand_pin.genesis)
    DRAND_PIN_PERIOD     = tostring(var.drand_pin.period)
  }

  # Set out of band. The placeholder is not a URL, so the worker refuses to
  # start until each is set.
  secret_config = toset([
    "ALERT_PAGE_URL",
    "ALERT_WARNING_URL",
    "HEALTHCHECKS_PING_URL",
  ])

  placeholder = "unset: put the real value with aws ssm put-parameter --overwrite"

  # The only parameters the operator role may write. Anything that decides what
  # runs or what it talks to (WORKER_IMAGE, RSK_RPC_URL, COORDINATOR_ADDRESS)
  # stays Terraform's.
  operator_parameters = concat(tolist(local.secret_config), ["OWN_FULFILLER_ADDRESSES", "ALERT_PAGE_TOKEN"])
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

# Both Fulfiller addresses, known only once the KMS keys exist. Set out of band.
resource "aws_ssm_parameter" "own_fulfillers" {
  name           = "${local.parameter_path}/OWN_FULFILLER_ADDRESSES"
  type           = "String"
  insecure_value = local.placeholder

  lifecycle {
    ignore_changes = [insecure_value]
  }
}

# Read by the host's rsk-vrf-up before each start. It sits one level down, so
# the worker's non-recursive read skips it.
resource "aws_ssm_parameter" "worker_image" {
  name           = "${local.parameter_path}/host/WORKER_IMAGE"
  type           = "String"
  insecure_value = var.worker_image
}

# Empty secrets: the Proving Key itself is put with aws secretsmanager
# put-secret-value from the offline machine, never through Terraform.
resource "aws_secretsmanager_secret" "proving_key" {
  for_each = toset(var.proving_key_hashes)

  name        = "rsk-vrf/proving-key/${each.key}"
  description = "rsk-vrf Proving Key ${each.key}"
}

resource "aws_cloudwatch_log_group" "host" {
  name              = local.log_group
  retention_in_days = 90
}
