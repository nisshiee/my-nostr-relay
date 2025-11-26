terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    vercel = {
      source  = "vercel/vercel"
      version = "~> 1.0"
    }
  }

  backend "s3" {
    bucket = "nostr-relay-tfstate-426192960050"
    key    = "terraform.tfstate"
    region = "ap-northeast-1"
  }
}

provider "aws" {
  region = "ap-northeast-1"
}

provider "vercel" {
  # VERCEL_API_TOKEN is required
}

locals {
  domain_name = "nostr.nisshiee.org"
}

# ------------------------------------------------------------------------------
# Modules
# ------------------------------------------------------------------------------

module "domain" {
  source      = "./modules/domain"
  domain_name = local.domain_name
}

module "api" {
  source          = "./modules/api"
  domain_name     = local.domain_name
  zone_id         = module.domain.zone_id
  certificate_arn = module.domain.certificate_arn
}

module "web" {
  source      = "./modules/web"
  domain_name = local.domain_name
  zone_id     = module.domain.zone_id
}

output "nameservers" {
  value = module.domain.nameservers
}


