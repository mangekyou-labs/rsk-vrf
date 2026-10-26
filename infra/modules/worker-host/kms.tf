# The Fulfiller key. Only this host's role may sign with it; the key policy
# denies kms:Sign to every other principal, whatever IAM grants them.
data "aws_iam_policy_document" "fulfiller_key" {
  statement {
    sid       = "AccountAdministersThroughIam"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account}:root"]
    }
  }

  statement {
    sid       = "OnlyThisHostSigns"
    effect    = "Deny"
    actions   = ["kms:Sign"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    condition {
      test     = "ArnNotEquals"
      variable = "aws:PrincipalArn"
      values   = [aws_iam_role.host.arn]
    }
  }
}

resource "aws_kms_key" "fulfiller" {
  description              = "rsk-vrf ${var.name} Fulfiller (secp256k1)"
  customer_master_key_spec = "ECC_SECG_P256K1"
  key_usage                = "SIGN_VERIFY"
  deletion_window_in_days  = 30
  policy                   = data.aws_iam_policy_document.fulfiller_key.json

  lifecycle {
    # Deleting the key strands whatever RBTC its Fulfiller EOA holds.
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "fulfiller" {
  name          = "alias/${local.prefix}-fulfiller"
  target_key_id = aws_kms_key.fulfiller.key_id
}
