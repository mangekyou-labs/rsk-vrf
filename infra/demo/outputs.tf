output "instance_id" {
  value = aws_instance.host.id
}

output "parameter_path" {
  value = local.parameter_path
}

output "log_group" {
  value = aws_cloudwatch_log_group.host.name
}
