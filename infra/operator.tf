# The operator role manages the Fulfiller keys, the Proving Key secrets and the
# alert parameters, but can never sign as a Fulfiller or read a Proving Key.
# It has no shell on the hosts and cannot choose the image they run: either
# would let it sign as a Fulfiller through the host. That power is the
# separate host-access role (host-access.tf).
data "aws_caller_identity" "current" {
  provider = aws.primary
}

data "aws_partition" "current" {
  provider = aws.primary
}

locals {
  partition       = data.aws_partition.current.partition
  account         = data.aws_caller_identity.current.account_id
  account_arn     = "arn:${local.partition}:iam::${local.account}"
  worker_hosts    = [module.primary.instance_arn, module.backup.instance_arn]
  worker_regions  = [var.primary_region, var.backup_region]
  ssm_arn_prefix  = [for r in local.worker_regions : "arn:${local.partition}:ssm:${r}:${local.account}"]
  kms_keys        = [for r in local.worker_regions : "arn:${local.partition}:kms:${r}:${local.account}:key/*"]
  secrets_by_name = [for r in local.worker_regions : "arn:${local.partition}:secretsmanager:${r}:${local.account}:secret:rsk-vrf/proving-key/*"]
}

# Both roles need MFA and are assumed from this account only.
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
  description          = "Manages rsk-vrf Fulfiller keys, Proving Key secrets and alert parameters. Cannot sign, read Proving Keys or reach the hosts."
  assume_role_policy   = data.aws_iam_policy_document.operator_trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "operator" {
  # PutKeyPolicy stays denied: the key policies are what keep kms:Sign to the
  # host role, so whoever can rewrite one can sign.
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

  # The image a host runs decides what signs with its Fulfiller key.
  statement {
    sid    = "NeverChooseTheHostImage"
    effect = "Deny"
    actions = [
      "ssm:PutParameter",
      "ssm:DeleteParameter",
      "ssm:DeleteParameters",
      "ssm:LabelParameterVersion",
    ]
    resources = [for p in local.ssm_arn_prefix : "${p}:parameter/rsk-vrf/*/host/*"]
  }

  # Only keys tagged Project=rsk-vrf, so other keys in the account stay out of reach.
  statement {
    sid = "ManageFulfillerKeys"
    actions = [
      "kms:DescribeKey",
      "kms:GetPublicKey",
      "kms:GetKeyPolicy",
      "kms:ListResourceTags",
      "kms:EnableKey",
      "kms:DisableKey",
      "kms:TagResource",
      "kms:UntagResource",
      "kms:ScheduleKeyDeletion",
      "kms:CancelKeyDeletion",
    ]
    resources = local.kms_keys
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Project"
      values   = ["rsk-vrf"]
    }
  }

  # A new key is inert until a Terraform change points a host at it, and gets
  # the default key policy (IAM decides, and this role is denied kms:Sign).
  statement {
    sid       = "CreateFulfillerKeys"
    actions   = ["kms:CreateKey"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:KeySpec"
      values   = ["ECC_SECG_P256K1"]
    }
    condition {
      test     = "StringEquals"
      variable = "kms:KeyUsage"
      values   = ["SIGN_VERIFY"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Project"
      values   = ["rsk-vrf"]
    }
    condition {
      test     = "Bool"
      variable = "kms:BypassPolicyLockoutSafetyCheck"
      values   = ["false"]
    }
  }

  # Tagging inside CreateKey is authorized as kms:TagResource on the new key.
  # Limited to secp256k1 signing keys, so no other kind of key can be tagged in.
  statement {
    sid       = "TagNewFulfillerKeys"
    actions   = ["kms:TagResource"]
    resources = local.kms_keys
    condition {
      test     = "StringEquals"
      variable = "kms:KeySpec"
      values   = ["ECC_SECG_P256K1"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Project"
      values   = ["rsk-vrf"]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["Project", "Name"]
    }
  }

  # A key another project tagged is never retagged into this one.
  statement {
    sid       = "NeverAdoptOtherProjectsKeys"
    effect    = "Deny"
    actions   = ["kms:TagResource", "kms:UntagResource"]
    resources = ["*"]
    condition {
      test     = "Null"
      variable = "aws:ResourceTag/Project"
      values   = ["false"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "aws:ResourceTag/Project"
      values   = ["rsk-vrf"]
    }
  }

  statement {
    sid       = "ListKeys"
    actions   = ["kms:ListKeys", "kms:ListAliases"]
    resources = ["*"]
  }

  # Write-only: no secretsmanager:GetSecretValue.
  statement {
    sid = "ManageProvingKeySecrets"
    actions = [
      "secretsmanager:DescribeSecret",
      "secretsmanager:CreateSecret",
      "secretsmanager:PutSecretValue",
      "secretsmanager:DeleteSecret",
      "secretsmanager:RestoreSecret",
      "secretsmanager:TagResource",
    ]
    resources = local.secrets_by_name
  }

  statement {
    sid       = "ListSecrets"
    actions   = ["secretsmanager:ListSecrets"]
    resources = ["*"]
  }

  statement {
    sid = "ReadWorkerParameters"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
    ]
    resources = flatten([for p in local.ssm_arn_prefix : ["${p}:parameter/rsk-vrf", "${p}:parameter/rsk-vrf/*"]])
  }

  statement {
    sid       = "SetAlertParameters"
    actions   = ["ssm:PutParameter"]
    resources = concat(module.primary.operator_parameter_arns, module.backup.operator_parameter_arns)
  }

  statement {
    sid       = "SeeHosts"
    actions   = ["ec2:DescribeInstances", "ssm:DescribeInstanceInformation"]
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
