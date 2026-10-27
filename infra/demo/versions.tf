terraform {
  required_version = ">= 1.11, < 2.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.70"
    }
  }

  # Local state: the demo is one person's, and state holds no secret values.
}

provider "aws" {
  region = var.region

  default_tags {
    tags = { Project = "rsk-vrf", Stack = "demo" }
  }
}
