variable "aws_region" {
  description = "AWS region for deployment (set via TF_VAR_aws_region env var or terraform.tfvars)"
  type        = string
  default     = "eu-west-1"
}

variable "environment" {
  description = "Environment name (dev, staging, production)"
  type        = string
  default     = "production"
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.medium"
}

variable "ebs_volume_size" {
  description = "EBS volume size for Postgres data (GB)"
  type        = number
  default     = 50
}

variable "ssh_public_key" {
  description = "SSH public key for EC2 access"
  type        = string
}

variable "allowed_ssh_cidrs" {
  description = "List of CIDR blocks allowed to SSH to the instance"
  type        = list(string)
  default     = []
}

variable "allowed_grafana_cidrs" {
  description = "List of CIDR blocks allowed to access Grafana on port 3000"
  type        = list(string)
  default     = []
}

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
  default     = "dislocation-trader"
}

variable "vpc_cidr" {
  description = "CIDR block for VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "subnet_cidr" {
  description = "CIDR block for subnet"
  type        = string
  default     = "10.0.1.0/24"
}

variable "alert_email" {
  description = "Email address for CloudWatch alerts"
  type        = string
}
