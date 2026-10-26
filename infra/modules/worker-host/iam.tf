# The host role: SSM access, its own parameters and Fulfiller key, the
# Proving Key secrets in its region, and its log group. Nothing else.
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
  name               = "${local.prefix}-host"
  assume_role_policy = data.aws_iam_policy_document.host_trust.json
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.host.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "host" {
  statement {
    sid       = "SignAsThisFulfiller"
    actions   = ["kms:Sign", "kms:GetPublicKey"]
    resources = [aws_kms_key.fulfiller.arn]
  }

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
  name   = "${local.prefix}-host"
  role   = aws_iam_role.host.id
  policy = data.aws_iam_policy_document.host.json
}

resource "aws_iam_instance_profile" "host" {
  name = "${local.prefix}-host"
  role = aws_iam_role.host.name
}
