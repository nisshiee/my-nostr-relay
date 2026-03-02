# ------------------------------------------------------------------------------
# CloudFront Distribution
#
# relay.nostr.nisshiee.org用のCloudFront Distribution
# オリジン: relay-v2 EC2インスタンス (HTTP, ポート3000)
# ------------------------------------------------------------------------------

resource "aws_cloudfront_distribution" "relay" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "Nostr Relay CloudFront Distribution"
  aliases         = ["relay.${var.domain_name}"]
  price_class     = "PriceClass_200"

  # オリジン: relay-v2 EC2インスタンス
  origin {
    origin_id   = "relay-v2"
    domain_name = var.relay_origin_domain

    custom_origin_config {
      http_port                = 3000
      https_port               = 443
      origin_protocol_policy   = "http-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60
      origin_keepalive_timeout = 60
    }
  }

  # デフォルトキャッシュビヘイビア（WebSocket + NIP-11）
  default_cache_behavior {
    target_origin_id       = "relay-v2"
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]

    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host_header.id
  }

  # SSL証明書 (us-east-1のACM証明書)
  viewer_certificate {
    acm_certificate_arn      = var.cloudfront_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  restrictions {
    geo_restriction {
      restriction_type = "whitelist"
      locations        = ["JP"]
    }
  }

  tags = {
    Name = "nostr-relay"
  }
}

# AWS管理キャッシュポリシー参照
data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host_header" {
  name = "Managed-AllViewerExceptHostHeader"
}

# 変数
variable "cloudfront_certificate_arn" {
  type        = string
  description = "CloudFront用ACM証明書ARN（us-east-1リージョン）"
}

variable "relay_origin_domain" {
  type        = string
  description = "relay-v2 EC2のオリジンドメイン名"
}

# 出力
output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.relay.id
}

output "cloudfront_domain_name" {
  value = aws_cloudfront_distribution.relay.domain_name
}
