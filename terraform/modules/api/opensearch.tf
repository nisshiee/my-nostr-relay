# ------------------------------------------------------------------------------
# OpenSearch Service ドメイン
#
# REQ（サブスクリプション）メッセージ処理のための検索エンジン
# DynamoDBを「真実の源」として維持し、OpenSearchは検索用のマテリアライズドビューとして機能
# 要件: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9
# ------------------------------------------------------------------------------

# ------------------------------------------------------------------------------
# Data Sources
# ------------------------------------------------------------------------------
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

# ------------------------------------------------------------------------------
# OpenSearch Serviceドメイン
# Task 1.1: OpenSearchドメインとEBS設定のTerraform定義
# ------------------------------------------------------------------------------
resource "aws_opensearch_domain" "nostr_relay" {
  domain_name    = "nostr-relay"
  engine_version = "OpenSearch_2.11"

  # シングルノード構成（無料枠対象）
  cluster_config {
    instance_type  = "t3.small.search"
    instance_count = 1
  }

  # EBSストレージ設定（gp3、10GB）
  ebs_options {
    ebs_enabled = true
    volume_type = "gp3"
    volume_size = 10
  }

  # at-rest暗号化を有効化
  encrypt_at_rest {
    enabled = true
  }

  # node-to-node暗号化を有効化
  node_to_node_encryption {
    enabled = true
  }

  # Task 1.2: パブリックアクセスエンドポイントとHTTPS強制
  domain_endpoint_options {
    enforce_https       = true
    tls_security_policy = "Policy-Min-TLS-1-2-2019-07"
  }

  # Task 1.2: リソースベースのアクセスポリシー
  # Lambda実行ロールからのみアクセスを許可
  access_policies = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = aws_iam_role.lambda_exec.arn }
      Action    = "es:*"
      Resource  = "arn:aws:es:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:domain/nostr-relay/*"
    }]
  })

  tags = {
    Name = "nostr-relay-opensearch"
  }
}

# ------------------------------------------------------------------------------
# IAM Policy for OpenSearch Access
# Task 1.2: Lambda関数にOpenSearchへのアクセス権限を付与
# ------------------------------------------------------------------------------
resource "aws_iam_policy" "lambda_opensearch" {
  name        = "nostr_relay_lambda_opensearch"
  description = "IAM policy for Lambda to access OpenSearch Service"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "es:ESHttpGet",
          "es:ESHttpHead",
          "es:ESHttpPost",
          "es:ESHttpPut",
          "es:ESHttpDelete"
        ]
        Resource = [
          aws_opensearch_domain.nostr_relay.arn,
          "${aws_opensearch_domain.nostr_relay.arn}/*"
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_opensearch" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = aws_iam_policy.lambda_opensearch.arn
}
