terraform {
  required_version = ">= 1.11, < 2.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.70"
    }
  }

  # State holds no secret values, but it is shared: keep it in S3.
  # terraform init -backend-config=backend.hcl (see backend.hcl.example).
  backend "s3" {}
}
