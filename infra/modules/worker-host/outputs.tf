output "instance_id" {
  value = aws_instance.host.id
}

output "instance_arn" {
  value = aws_instance.host.arn
}

output "public_ip" {
  value = aws_instance.host.public_ip
}

output "fulfiller_key_arn" {
  value = aws_kms_key.fulfiller.arn
}

output "fulfiller_key_alias" {
  value = aws_kms_alias.fulfiller.name
}

output "parameter_path" {
  value = local.parameter_path
}

output "log_group_arn" {
  value = aws_cloudwatch_log_group.host.arn
}
