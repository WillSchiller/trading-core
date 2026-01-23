# Infrastructure

Terraform configuration for AWS deployment of the Dislocation Trader system.

## Overview

This Terraform configuration provisions:
- **VPC** with public subnet and internet gateway
- **EC2 instance** (t3.medium) with Docker and CloudWatch agent
- **EBS volume** (50GB gp3) for PostgreSQL data persistence
- **Security Groups** (SSH and Grafana access restricted to team IPs)
- **Elastic IP** for stable addressing
- **ECR repository** for Docker images
- **Secrets Manager** for all credentials
- **CloudWatch alarms** for CPU, memory, disk, and status checks
- **SNS topic** for alert notifications

## Prerequisites

1. **AWS CLI** configured with credentials
2. **Terraform** >= 1.6 installed
3. **S3 bucket** for Terraform state (see DEPLOYMENT.md)
4. **SSH key pair** generated

## Quick Start

```bash
# Copy example variables
cp terraform.tfvars.example terraform.tfvars

# Edit terraform.tfvars with your values
vim terraform.tfvars

# Initialize Terraform (specify region for state backend)
export AWS_DEFAULT_REGION=ap-southeast-1
terraform init -backend-config="region=$AWS_DEFAULT_REGION"

# Plan infrastructure
terraform plan -out=tfplan

# Apply infrastructure
terraform apply tfplan

# Get outputs
terraform output
```

## Files

| File | Purpose |
|------|---------|
| `main.tf` | Provider and backend configuration |
| `variables.tf` | Input variables |
| `network.tf` | VPC, subnet, internet gateway, route table |
| `security-group.tf` | Security group rules (SSH, Grafana, outbound) |
| `ec2.tf` | EC2 instance, IAM role, EBS volume, Elastic IP |
| `secrets.tf` | AWS Secrets Manager resources |
| `cloudwatch.tf` | CloudWatch log group, alarms, SNS topic |
| `ecr.tf` | ECR repository for Docker images |
| `outputs.tf` | Output values (IP, URLs, commands) |
| `user-data.sh` | EC2 initialization script |

## Variables

### Required Variables

```hcl
ssh_public_key        # Your SSH public key
allowed_ssh_cidrs     # List of IPs allowed to SSH
allowed_grafana_cidrs # List of IPs allowed to access Grafana
alert_email           # Email for CloudWatch alerts
```

### Optional Variables

```hcl
aws_region        = "ap-southeast-1"  # Singapore (default, for latency to Asian exchanges)
environment       = "production"
instance_type     = "t3.medium"
ebs_volume_size   = 50
project_name      = "dislocation-trader"
vpc_cidr          = "10.0.0.0/16"
subnet_cidr       = "10.0.1.0/24"
```

**Setting AWS Region:**

The region can be set via:
1. `terraform.tfvars`: `aws_region = "ap-southeast-1"`
2. Environment variable: `export TF_VAR_aws_region=ap-southeast-1`
3. Command line: `terraform apply -var="aws_region=ap-southeast-1"`

## Outputs

After `terraform apply`, you'll get:

```
instance_public_ip     # EC2 public IP
grafana_url            # http://<IP>:3000
ecr_repository_url     # ECR registry URL
ssh_command            # ssh -i ~/.ssh/<key> ubuntu@<IP>
sns_topic_arn          # CloudWatch alert topic ARN
```

## Security

### Security Group Rules

**Inbound:**
- SSH (22): Restricted to `allowed_ssh_cidrs`
- Grafana (3000): Restricted to `allowed_grafana_cidrs`
- All other inbound: DENY

**Outbound:**
- HTTPS (443): Allowed (CEX APIs, RPC providers)
- DNS (53): Allowed (TCP and UDP)
- NTP (123): Allowed (time sync)
- HTTP (80): Allowed (package updates)

### IAM Permissions

EC2 instance has IAM role with:
- **Secrets Manager**: Read secrets from `dislocation-trader/*`
- **CloudWatch**: Write logs and metrics
- **ECR**: Pull Docker images

### Encryption

- EBS volumes: Encrypted at rest (AES-256)
- ECR images: Encrypted at rest (AES-256)
- Secrets Manager: Encrypted at rest (AWS KMS)

## Maintenance

### Update Instance Type

```bash
# Edit terraform.tfvars
instance_type = "t3.large"

# Apply change (will stop/start instance)
terraform apply
```

### Update Security Group Rules

```bash
# Edit terraform.tfvars
allowed_ssh_cidrs = ["1.2.3.4/32", "5.6.7.8/32"]

# Apply change (no downtime)
terraform apply
```

### Destroy Infrastructure

```bash
# Backup data first!
terraform destroy
```

**Warning:** This will delete the EC2 instance and EBS volume. Take EBS snapshots before destroying.

## User Data Script

`user-data.sh` runs on first boot and:
1. Installs Docker, docker-compose, AWS CLI
2. Configures chrony (NTP)
3. Sets up fail2ban (SSH protection)
4. Formats and mounts EBS volume to `/data/postgres`
5. Installs CloudWatch agent
6. Enables unattended security updates

## CloudWatch Alarms

| Alarm | Threshold | Action |
|-------|-----------|--------|
| CPU High | > 80% for 5 min | SNS notification |
| Memory High | > 85% | SNS notification |
| Disk High | > 80% | SNS notification |
| Status Check Failed | Any failure | SNS notification |

## Terraform State

Terraform state is stored in S3:
- **Bucket**: `dislocation-trader-terraform-state`
- **Key**: `infrastructure/terraform.tfstate`
- **Region**: Set via `AWS_DEFAULT_REGION` env var or `-backend-config="region=..."`
- **Encryption**: AES256
- **Versioning**: Enabled

**Note:** Create the S3 bucket in your target region before running `terraform init`:
```bash
export AWS_DEFAULT_REGION=ap-southeast-1
aws s3 mb s3://dislocation-trader-terraform-state --region $AWS_DEFAULT_REGION
aws s3api put-bucket-versioning --bucket dislocation-trader-terraform-state --versioning-configuration Status=Enabled
```

## Troubleshooting

### Error: InvalidKeyPair.NotFound

**Solution:** Ensure `ssh_public_key` in `terraform.tfvars` is the full public key content.

### Error: ResourceAlreadyExists

**Solution:** Secrets already exist from previous deployment. Either:
1. Import existing secrets: `terraform import aws_secretsmanager_secret.postgres_password <ARN>`
2. Delete secrets via AWS Console (wait 7 days recovery period)

### Error: UnauthorizedOperation

**Solution:** AWS credentials don't have sufficient permissions. Required:
- EC2, VPC, EBS, IAM, Secrets Manager, CloudWatch, SNS, ECR

## References

- [Deployment Guide](../docs/DEPLOYMENT.md)
- [Operational Runbook](../docs/runbook.md)
- [Terraform AWS Provider Docs](https://registry.terraform.io/providers/hashicorp/aws/latest/docs)
