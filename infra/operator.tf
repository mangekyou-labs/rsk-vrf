# The operator role administers the Fulfiller keys and writes secrets and
# parameters, but can never sign as a Fulfiller or read a Proving Key.
data "aws_caller_identity" "current" {
  provider = aws.primary
}

data "aws_partition" "current" {
  provider = aws.primary
}

locals {
  account_arn     = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}"
  fulfiller_keys  = [module.primary.fulfiller_key_arn, module.backup.fulfiller_key_arn]
  worker_hosts    = [module.primary.instance_arn, module.backup.instance_arn]
  worker_regions  = [var.primary_region, var.backup_region]
  ssm_arn_prefix  = [for r in local.worker_regions : "arn:${data.aws_partition.current.partition}:ssm:${r}:${data.aws_caller_identity.current.account_id}"]
  secrets_by_name = [for r in local.worker_regions : "arn:${data.aws_partition.current.partition}:secretsmanager:${r}:${data.aws_caller_identity.current.account_id}:secret:rsk-vrf/proving-key/*"]
}

data "aws_iam_policy_document" "operator_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = ["${local.account_arn}:root"]
    }
    condition {
      test     = "Bool"
      variable = "aws:MultiFactorAuthPresent"
      values   = ["true"]
    }
  }
}

resource "aws_iam_role" "operator" {
  provider             = aws.primary
  name                 = "rsk-vrf-operator"
  description          = "Administers rsk-vrf Fulfiller keys, secrets and parameters. Cannot kms:Sign."
  assume_role_policy   = data.aws_iam_policy_document.operator_trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "operator" {
  statement {
    sid    = "NeverSignAsAFulfiller"
    effect = "Deny"
    actions = [
      "kms:Sign",
      "kms:CreateGrant",
      "kms:PutKeyPolicy",
    ]
    resources = ["*"]
  }

  statement {
    sid = "AdministerFulfillerKeys"
    actions = [
      "kms:DescribeKey",
      "kms:GetPublicKey",
      "kms:GetKeyPolicy",
      "kms:ListResourceTags",
      "kms:ListAliases",
      "kms:EnableKey",
      "kms:DisableKey",
      "kms:TagResource",
      "kms:UntagResource",
      "kms:ScheduleKeyDeletion",
      "kms:CancelKeyDeletion",
    ]
    resources = local.fulfiller_keys
  }

  statement {
    sid       = "WriteProvingKeys"
    actions   = ["secretsmanager:DescribeSecret", "secretsmanager:PutSecretValue", "secretsmanager:TagResource"]
    resources = local.secrets_by_name
  }

  statement {
    sid       = "ListSecrets"
    actions   = ["secretsmanager:ListSecrets"]
    resources = ["*"]
  }

  statement {
    sid = "WorkerParameters"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
      "ssm:PutParameter",
    ]
    resources = flatten([for p in local.ssm_arn_prefix : ["${p}:parameter/rsk-vrf", "${p}:parameter/rsk-vrf/*"]])
  }

  statement {
    sid       = "ReachHostsThroughSsm"
    actions   = ["ssm:StartSession", "ssm:SendCommand"]
    resources = concat(local.worker_hosts, ["arn:${data.aws_partition.current.partition}:ssm:*::document/AWS-RunShellScript", "arn:${data.aws_partition.current.partition}:ssm:*:*:document/SSM-SessionManagerRunShell"])
  }

  statement {
    sid = "SeeHostsAndSessions"
    actions = [
      "ec2:DescribeInstances",
      "ssm:DescribeInstanceInformation",
      "ssm:DescribeSessions",
      "ssm:GetCommandInvocation",
      "ssm:ListCommandInvocations",
      "ssm:TerminateSession",
      "ssm:ResumeSession",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "ReadLogs"
    actions   = ["logs:DescribeLogStreams", "logs:GetLogEvents", "logs:FilterLogEvents", "logs:StartLiveTail"]
    resources = [module.primary.log_group_arn, "${module.primary.log_group_arn}:*", module.backup.log_group_arn, "${module.backup.log_group_arn}:*"]
  }
}

resource "aws_iam_role_policy" "operator" {
  provider = aws.primary
  name     = "rsk-vrf-operator"
  role     = aws_iam_role.operator.id
  policy   = data.aws_iam_policy_document.operator.json
}
