# The demo host: the worker alone on one small instance, reading Rootstock
# through a public RPC and signing with a Fulfiller private key held in SSM.
# No rskj node, no KMS key, no Backup Worker. For testnet demos only; mainnet
# uses the two-region stack in infra/.

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  name           = "rsk-vrf-demo"
  region         = data.aws_region.current.region
  account        = data.aws_caller_identity.current.account_id
  partition      = data.aws_partition.current.partition
  parameter_path = "/rsk-vrf/demo"
  log_group      = "/rsk-vrf/demo"
}

# --- Network: one public subnet. Nothing inbound: the worker only calls out. ---

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "host" {
  cidr_block           = "10.38.0.0/24"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = local.name }
}

resource "aws_internet_gateway" "host" {
  vpc_id = aws_vpc.host.id
  tags   = { Name = local.name }
}

resource "aws_subnet" "host" {
  vpc_id                  = aws_vpc.host.id
  cidr_block              = aws_vpc.host.cidr_block
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true
  tags                    = { Name = local.name }
}

resource "aws_route_table" "host" {
  vpc_id = aws_vpc.host.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.host.id
  }

  tags = { Name = local.name }
}

resource "aws_route_table_association" "host" {
  subnet_id      = aws_subnet.host.id
  route_table_id = aws_route_table.host.id
}

resource "aws_security_group" "host" {
  name        = local.name
  description = "Nothing in; everything out. No SSH: use SSM."
  vpc_id      = aws_vpc.host.id
  tags        = { Name = local.name }
}

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.host.id
  description       = "RPC, drand, GHCR, healthchecks and AWS APIs"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# --- Host ---

data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

resource "aws_instance" "host" {
  ami                    = data.aws_ssm_parameter.ubuntu.value
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.host.id
  vpc_security_group_ids = [aws_security_group.host.id]
  iam_instance_profile   = aws_iam_instance_profile.host.name

  # Standard credits: a busy CPU slows down instead of adding charges.
  credit_specification {
    cpu_credits = "standard"
  }

  # IMDSv2 only. Two hops so the worker container can reach the role credentials.
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 10
    encrypted   = true
  }

  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    compose          = file("${path.module}/compose.yaml")
    region           = local.region
    log_group        = aws_cloudwatch_log_group.host.name
    parameter_path   = "${local.parameter_path}/"
    image_parameter  = aws_ssm_parameter.worker_image.name
    image_repository = "ghcr.io/${var.ghcr_owner}/rsk-vrf-worker"
  })

  tags = { Name = local.name }
}

# --- IAM: SSM access, its own parameters, the Proving Key secrets, its logs. ---

data "aws_iam_policy_document" "host_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "host" {
  name               = "${local.name}-host"
  assume_role_policy = data.aws_iam_policy_document.host_trust.json
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.host.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "host" {
  statement {
    sid = "LoadProvingKeys"
    # DescribeSecret tells an empty secret apart from a missing one.
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = ["arn:${local.partition}:secretsmanager:${local.region}:${local.account}:secret:rsk-vrf/proving-key/*"]
  }

  statement {
    sid     = "LoadConfiguration"
    actions = ["ssm:GetParametersByPath", "ssm:GetParameter"]
    resources = [
      "arn:${local.partition}:ssm:${local.region}:${local.account}:parameter${local.parameter_path}",
      "arn:${local.partition}:ssm:${local.region}:${local.account}:parameter${local.parameter_path}/*",
    ]
  }

  statement {
    sid       = "ShipLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.host.arn}:*"]
  }
}

resource "aws_iam_role_policy" "host" {
  name   = "${local.name}-host"
  role   = aws_iam_role.host.id
  policy = data.aws_iam_policy_document.host.json
}

resource "aws_iam_instance_profile" "host" {
  name = "${local.name}-host"
  role = aws_iam_role.host.name
}
