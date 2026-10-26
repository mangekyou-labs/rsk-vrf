# Two worker hosts, one per region: the Primary Worker answers at once and the
# Backup Worker waits 100 blocks. Each has its own KMS Fulfiller key.
provider "aws" {
  alias  = "primary"
  region = var.primary_region

  default_tags {
    tags = { Project = "rsk-vrf" }
  }
}

provider "aws" {
  alias  = "backup"
  region = var.backup_region

  default_tags {
    tags = { Project = "rsk-vrf" }
  }
}

locals {
  compose           = file("${path.module}/compose/compose.yaml")
  worker_repository = "ghcr.io/${var.ghcr_owner}/rsk-vrf-worker"
}

module "primary" {
  source    = "./modules/worker-host"
  providers = { aws = aws.primary }

  name         = "primary"
  grace_blocks = 0

  compose             = local.compose
  rsk_network         = var.rsk_network
  instance_type       = var.instance_type
  data_volume_gb      = var.data_volume_gb
  worker_image        = var.worker_image
  worker_repository   = local.worker_repository
  coordinator_address = var.coordinator_address
  drand_pin           = var.drand_pin
  proving_key_hashes  = var.proving_key_hashes
}

module "backup" {
  source    = "./modules/worker-host"
  providers = { aws = aws.backup }

  name         = "backup"
  grace_blocks = 100

  compose             = local.compose
  rsk_network         = var.rsk_network
  instance_type       = var.instance_type
  data_volume_gb      = var.data_volume_gb
  worker_image        = var.worker_image
  worker_repository   = local.worker_repository
  coordinator_address = var.coordinator_address
  drand_pin           = var.drand_pin
  proving_key_hashes  = var.proving_key_hashes
}
