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

# us-east-1プロバイダー（Lambda@EdgeとCloudFront証明書用）
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
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

module "api" {
  source                     = "./modules/api"
  domain_name                = local.domain_name
  zone_id                    = module.domain.zone_id
  certificate_arn            = module.domain.certificate_arn
  cloudfront_certificate_arn = aws_acm_certificate_validation.cloudfront.certificate_arn

  # NIP-11 リレー情報設定
  relay_name             = "nisshieeのプライベートリレー(beta)"
  relay_description      = "試験運用中のため、無断でイベント削除・サービス停止する可能性があります。また、正常な動作を保証していません。"
  relay_pubkey           = "73491509b8e2d80840873b5a13ba98a5d1ac3a16c9292e106b1f2eda31152c52"
  relay_contact          = "mailto:nostr-relay-admin@nisshiee.org"
  relay_icon             = "https://www.gravatar.com/avatar/c48758d8162582b770092002effb7dff"
  relay_banner           = "https://nisshiee.org/ogimage.png"
  relay_privacy_policy   = "https://nostr.nisshiee.org/relay/privacy"
  relay_terms_of_service = "https://nostr.nisshiee.org/relay/terms"
  relay_posting_policy   = "https://nostr.nisshiee.org/relay/posting-policy"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }
}

module "web" {
  source      = "./modules/web"
  domain_name = local.domain_name
  zone_id     = module.domain.zone_id
}

output "nameservers" {
  value = module.domain.nameservers
}

output "cloudfront_distribution_id" {
  value = module.api.cloudfront_distribution_id
}

output "cloudfront_domain_name" {
  value = module.api.cloudfront_domain_name
}


