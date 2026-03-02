terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "domain_name" {
  type = string
}

variable "zone_id" {
  type = string
}

# Route53レコード: relay.nostr.nisshiee.org → CloudFront
resource "aws_route53_record" "relay" {
  name    = "relay.${var.domain_name}"
  type    = "A"
  zone_id = var.zone_id

  alias {
    name                   = aws_cloudfront_distribution.relay.domain_name
    zone_id                = aws_cloudfront_distribution.relay.hosted_zone_id
    evaluate_target_health = false
  }
}
