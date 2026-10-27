output "hosts" {
  description = "Per worker: instance, public IP, Fulfiller key alias, parameter path."
  value = {
    for name, m in { primary = module.primary, backup = module.backup } : name => {
      instance_id            = m.instance_id
      public_ip              = m.public_ip
      fulfiller_key_arn      = m.fulfiller_key_arn
      fulfiller_key_alias    = m.fulfiller_key_alias
      parameter_path         = m.parameter_path
    }
  }
}

output "operator_role_arn" {
  value = aws_iam_role.operator.arn
}

output "host_access_role_arn" {
  description = "Shell on the hosts. Equivalent to signing as either Fulfiller."
  value       = aws_iam_role.host_access.arn
}
