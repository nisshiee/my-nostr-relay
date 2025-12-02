# ------------------------------------------------------------------------------
# CloudFront Distribution
#
# relay.nostr.nisshiee.org用のCloudFront Distributionを構築
# - デフォルトオリジン: WebSocket API Gateway
# - NIP-11オリジン: Lambda Function URL (OAC経由)
# - Lambda@Edgeでルーティング
#
# 要件: 6.1, 6.3
# ------------------------------------------------------------------------------

# ------------------------------------------------------------------------------
# CloudFront Distribution
# ------------------------------------------------------------------------------
resource "aws_cloudfront_distribution" "relay" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "Nostr Relay CloudFront Distribution"
  aliases         = ["relay.${var.domain_name}"]

  # --------------------------------------
  # デフォルトオリジン: WebSocket API Gateway
  # API Gateway WebSocket APIのエンドポイントはwss://id.execute-api.region.amazonaws.com
  # $defaultステージへのパスはorigin_pathで指定
  # --------------------------------------
  origin {
    origin_id   = "websocket"
    domain_name = "${aws_apigatewayv2_api.relay.id}.execute-api.ap-northeast-1.amazonaws.com"
    origin_path = "/${aws_apigatewayv2_stage.default.name}"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # --------------------------------------
  # NIP-11オリジン: Lambda Function URL
  # Lambda@Edgeからの動的オリジン切り替えで使用
  # 注意: Lambda@Edgeで動的にオリジンを変更する場合、このオリジン定義は
  # CloudFrontの設定として残すが、実際のルーティングはLambda@Edgeが行う
  # --------------------------------------
  origin {
    origin_id   = "nip11"
    domain_name = replace(replace(aws_lambda_function_url.nip11_info.function_url, "https://", ""), "/", "")

    custom_origin_config {
      http_port              = 443
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # --------------------------------------
  # デフォルトキャッシュビヘイビア (WebSocket)
  # --------------------------------------
  default_cache_behavior {
    target_origin_id       = "websocket"
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]

    # WebSocket接続のためキャッシュを無効化
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host_header.id

    # Lambda@Edgeでルーティング
    lambda_function_association {
      event_type   = "origin-request"
      lambda_arn   = aws_lambda_function.edge_router.qualified_arn
      include_body = false
    }
  }

  # --------------------------------------
  # SSL証明書 (us-east-1のACM証明書が必要)
  # --------------------------------------
  viewer_certificate {
    acm_certificate_arn      = var.cloudfront_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  # --------------------------------------
  # 配信制限 (PriceClass)
  # --------------------------------------
  restrictions {
    geo_restriction {
      restriction_type = "blacklist"
      locations        = ["CN", "RU", "KP"]
    }
  }

  tags = {
    Name = "nostr-relay"
  }

  # Lambda@EdgeはCloudFront Distributionより先に作成される必要がある
  depends_on = [aws_lambda_function.edge_router]
}

# ------------------------------------------------------------------------------
# AWS管理キャッシュポリシー参照
# ------------------------------------------------------------------------------
data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host_header" {
  name = "Managed-AllViewerExceptHostHeader"
}

# ------------------------------------------------------------------------------
# CloudFront証明書変数（us-east-1で作成されたACM証明書）
# ------------------------------------------------------------------------------
variable "cloudfront_certificate_arn" {
  type        = string
  description = "CloudFront用ACM証明書ARN（us-east-1リージョン）"
}

# ------------------------------------------------------------------------------
# CloudFront Distribution出力
# ------------------------------------------------------------------------------
output "cloudfront_distribution_id" {
  value       = aws_cloudfront_distribution.relay.id
  description = "CloudFront Distribution ID"
}

output "cloudfront_domain_name" {
  value       = aws_cloudfront_distribution.relay.domain_name
  description = "CloudFront Distribution Domain Name"
}
