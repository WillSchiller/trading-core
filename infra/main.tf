terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Backend uses partial configuration - set region via:
  #   terraform init -backend-config="region=$AWS_REGION"
  # Or set AWS_DEFAULT_REGION environment variable
  backend "s3" {
    bucket  = "dislocation-trader-terraform-state"
    key     = "infrastructure/terraform.tfstate"
    encrypt = true
    # region is set via -backend-config or AWS_DEFAULT_REGION env var
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "dislocation-trader"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
