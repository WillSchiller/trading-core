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
    bucket  = "blockhelixasia"
    key     = "dislocation-trader/terraform.tfstate"
    region  = "ap-southeast-1"
    encrypt = true
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
