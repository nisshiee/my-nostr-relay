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

# us-east-1プロバイダー（CloudFront用ACM証明書）
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

provider "vercel" {
  # VERCEL_API_TOKEN is required
}

data "aws_caller_identity" "current" {}

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

# ------------------------------------------------------------------------------
# CloudFront用ACM証明書 (us-east-1)
# CloudFrontではus-east-1リージョンの証明書が必須
# ------------------------------------------------------------------------------
resource "aws_acm_certificate" "cloudfront" {
  provider          = aws.us_east_1
  domain_name       = "relay.${local.domain_name}"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "nostr-relay-cloudfront"
  }
}

resource "aws_route53_record" "cloudfront_acm_validation" {
  for_each = {
    for dvo in aws_acm_certificate.cloudfront.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = module.domain.zone_id
}

resource "aws_acm_certificate_validation" "cloudfront" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.cloudfront.arn
  validation_record_fqdns = [for record in aws_route53_record.cloudfront_acm_validation : record.fqdn]
}

# ------------------------------------------------------------------------------
# API Module
# CloudFront Distribution、DynamoDB events テーブル、Route53レコードを管理
# v1リソース（API Gateway, Lambda, Lambda@Edge等）は廃止済み
# ------------------------------------------------------------------------------
module "api" {
  source                     = "./modules/api"
  domain_name                = local.domain_name
  zone_id                    = module.domain.zone_id
  cloudfront_certificate_arn = aws_acm_certificate_validation.cloudfront.certificate_arn
  relay_origin_domain        = module.ec2_relay.origin_domain_name
}

# ------------------------------------------------------------------------------
# EC2 Relay v2 Module
# axumベースの常駐WebSocketサーバー用EC2インフラストラクチャ
# ------------------------------------------------------------------------------
module "ec2_relay" {
  source = "./modules/ec2-relay"

  domain_name      = local.domain_name
  zone_id          = module.domain.zone_id
  events_table_arn = module.api.events_table_arn
  binary_bucket    = "nostr-relay-binary-${data.aws_caller_identity.current.account_id}"
}

module "web" {
  source      = "./modules/web"
  domain_name = local.domain_name
  zone_id     = module.domain.zone_id
}

module "github_actions" {
  source            = "./modules/github-actions"
  binary_bucket_arn = module.ec2_relay.binary_bucket_arn
}

# ------------------------------------------------------------------------------
# Outputs
# ------------------------------------------------------------------------------

output "nameservers" {
  value = module.domain.nameservers
}

output "cloudfront_distribution_id" {
  value = module.api.cloudfront_distribution_id
}

output "cloudfront_domain_name" {
  value = module.api.cloudfront_domain_name
}

output "ec2_relay_instance_id" {
  description = "relay-v2 EC2インスタンスID"
  value       = module.ec2_relay.instance_id
}

output "ec2_relay_elastic_ip" {
  description = "relay-v2 Elastic IP"
  value       = module.ec2_relay.elastic_ip
}

output "ec2_relay_binary_bucket" {
  description = "relay-v2バイナリ配布用S3バケット名"
  value       = module.ec2_relay.binary_bucket
}
