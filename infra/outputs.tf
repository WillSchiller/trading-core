output "instance_id" {
  description = "EC2 instance ID"
  value       = aws_instance.main.id
}

output "instance_public_ip" {
  description = "EC2 instance public IP address"
  value       = aws_eip.main.public_ip
}

output "instance_private_ip" {
  description = "EC2 instance private IP address"
  value       = aws_instance.main.private_ip
}

output "postgres_volume_id" {
  description = "EBS volume ID for Postgres data"
  value       = aws_ebs_volume.postgres_data.id
}

output "grafana_url" {
  description = "Grafana dashboard URL"
  value       = "http://${aws_eip.main.public_ip}:3000"
}

output "ecr_repository_url" {
  description = "ECR repository URL for Docker images"
  value       = aws_ecr_repository.app.repository_url
}

output "sns_topic_arn" {
  description = "SNS topic ARN for CloudWatch alerts"
  value       = aws_sns_topic.alerts.arn
}

output "ssh_command" {
  description = "SSH command to connect to the instance"
  value       = "ssh -i ~/.ssh/${var.project_name}.pem ubuntu@${aws_eip.main.public_ip}"
}
