# The host-access role: a shell on the worker hosts, for Import Sync and
# debugging. A shell on a host runs as its host role, so this is equivalent to
# signing as either Fulfiller and reading every Proving Key. Grant it as such.
resource "aws_iam_role" "host_access" {
  provider             = aws.primary
  name                 = "rsk-vrf-host-access"
  description          = "Shell on the rsk-vrf worker hosts. Equivalent to signing as either Fulfiller and reading every Proving Key."
  assume_role_policy   = data.aws_iam_policy_document.operator_trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "host_access" {
  statement {
    sid     = "ReachHostsThroughSsm"
    actions = ["ssm:StartSession", "ssm:SendCommand"]
    resources = concat(local.worker_hosts, [
      "arn:${local.partition}:ssm:*::document/AWS-RunShellScript",
      "arn:${local.partition}:ssm:*:*:document/SSM-SessionManagerRunShell",
    ])
  }

  statement {
    sid       = "EndOwnSessions"
    actions   = ["ssm:TerminateSession", "ssm:ResumeSession"]
    resources = ["arn:${local.partition}:ssm:*:${local.account}:session/$${aws:userid}-*"]
  }

  statement {
    sid = "SeeHostsAndCommands"
    actions = [
      "ec2:DescribeInstances",
      "ssm:DescribeInstanceInformation",
      "ssm:DescribeSessions",
      "ssm:GetCommandInvocation",
      "ssm:ListCommandInvocations",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "host_access" {
  provider = aws.primary
  name     = "rsk-vrf-host-access"
  role     = aws_iam_role.host_access.id
  policy   = data.aws_iam_policy_document.host_access.json
}
