# One worker host: rskj and the worker under Docker Compose, the rskj database
# on its own gp3 volume, reached through SSM only.
terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  prefix         = "rsk-vrf-${var.name}"
  region         = data.aws_region.current.region
  account        = data.aws_caller_identity.current.account_id
  partition      = data.aws_partition.current.partition
  parameter_path = "/rsk-vrf/${var.name}"
  log_group      = "/rsk-vrf/${var.name}"
}

# --- Network: one public subnet. Inbound is rskj P2P on 50505 only. ---

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "host" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = local.prefix }
}

resource "aws_internet_gateway" "host" {
  vpc_id = aws_vpc.host.id
  tags   = { Name = local.prefix }
}

resource "aws_subnet" "host" {
  vpc_id                  = aws_vpc.host.id
  cidr_block              = var.vpc_cidr
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true
  tags                    = { Name = local.prefix }
}

resource "aws_route_table" "host" {
  vpc_id = aws_vpc.host.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.host.id
  }

  tags = { Name = local.prefix }
}

resource "aws_route_table_association" "host" {
  subnet_id      = aws_subnet.host.id
  route_table_id = aws_route_table.host.id
}

resource "aws_security_group" "host" {
  name        = local.prefix
  description = "rskj P2P in; everything out. No SSH: use SSM."
  vpc_id      = aws_vpc.host.id
  tags        = { Name = local.prefix }
}

resource "aws_vpc_security_group_ingress_rule" "rskj_p2p" {
  for_each = toset(["tcp", "udp"])

  security_group_id = aws_security_group.host.id
  description       = "rskj peers (${each.key})"
  ip_protocol       = each.key
  from_port         = 50505
  to_port           = 50505
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.host.id
  description       = "Peers, drand, GHCR, healthchecks and AWS APIs"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# --- Host ---

data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

resource "aws_ebs_volume" "data" {
  availability_zone = aws_subnet.host.availability_zone
  size              = var.data_volume_gb
  type              = "gp3"
  encrypted         = true
  tags              = { Name = "${local.prefix}-data" }
}

resource "aws_instance" "host" {
  ami                     = data.aws_ssm_parameter.ubuntu.value
  instance_type           = var.instance_type
  subnet_id               = aws_subnet.host.id
  vpc_security_group_ids  = [aws_security_group.host.id]
  iam_instance_profile    = aws_iam_instance_profile.host.name
  disable_api_termination = true

  # IMDSv2 only. Two hops so the worker container can reach the role credentials.
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 30
    encrypted   = true
  }

  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    compose          = var.compose
    data_device      = "/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${replace(aws_ebs_volume.data.id, "-", "")}"
    region           = local.region
    log_group        = aws_cloudwatch_log_group.host.name
    rsk_network      = var.rsk_network
    parameter_path   = "${local.parameter_path}/"
    image_parameter  = aws_ssm_parameter.worker_image.name
    image_repository = var.worker_repository
    fulfiller_key    = aws_kms_alias.fulfiller.arn
  })

  tags = { Name = local.prefix }

  lifecycle {
    # A newer Ubuntu AMI must not replace a synced host; roll AMIs deliberately.
    ignore_changes = [ami]
  }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.host.id
}
