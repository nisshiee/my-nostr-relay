# ------------------------------------------------------------------------------
# Task 1.6: バイナリ配布用S3バケット作成
#
# 要件:
# - S3バケットを作成
# - EC2からのGetObjectを許可するバケットポリシー
# - SSM Run Commandでバイナリ更新を実行するドキュメント定義
#
# Requirements: 2.3, 2.4
# ------------------------------------------------------------------------------

# ------------------------------------------------------------------------------
# S3バケット
#
# HTTP APIサーバーのRustバイナリを格納する
# バージョニング有効化によりロールバックが可能
# ------------------------------------------------------------------------------
resource "aws_s3_bucket" "binary" {
  bucket = var.binary_bucket

  tags = {
    Name = "nostr-relay-ec2-search-binary"
  }
}

# バージョニング設定
# バイナリのロールバックを可能にする
resource "aws_s3_bucket_versioning" "binary" {
  bucket = aws_s3_bucket.binary.id

  versioning_configuration {
    status = "Enabled"
  }
}

# パブリックアクセスブロック
# セキュリティベストプラクティスとして全パブリックアクセスをブロック
resource "aws_s3_bucket_public_access_block" "binary" {
  bucket = aws_s3_bucket.binary.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# サーバーサイド暗号化設定
# デフォルトでSSE-S3暗号化を有効化
resource "aws_s3_bucket_server_side_encryption_configuration" "binary" {
  bucket = aws_s3_bucket.binary.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# バケットポリシー
# EC2インスタンスからのGetObjectを許可
resource "aws_s3_bucket_policy" "binary" {
  bucket = aws_s3_bucket.binary.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowEC2GetObject"
        Effect = "Allow"
        Principal = {
          AWS = aws_iam_role.ec2_search.arn
        }
        Action = [
          "s3:GetObject",
          "s3:GetObjectVersion"
        ]
        Resource = "${aws_s3_bucket.binary.arn}/*"
      },
      {
        Sid    = "AllowEC2ListBucket"
        Effect = "Allow"
        Principal = {
          AWS = aws_iam_role.ec2_search.arn
        }
        Action   = "s3:ListBucket"
        Resource = aws_s3_bucket.binary.arn
      }
    ]
  })

  # パブリックアクセスブロック設定後にポリシーを適用
  depends_on = [aws_s3_bucket_public_access_block.binary]
}

# ------------------------------------------------------------------------------
# SSM Run Command ドキュメント
#
# EC2インスタンス上のバイナリを更新するためのSSMドキュメント
# 実行コマンド例:
#   aws ssm send-command \
#     --document-name "nostr-relay-ec2-search-update-binary" \
#     --targets "Key=instanceids,Values=<instance-id>"
#
# Requirements: 2.4
# ------------------------------------------------------------------------------
resource "aws_ssm_document" "update_binary" {
  name            = "nostr-relay-ec2-search-update-binary"
  document_type   = "Command"
  document_format = "YAML"

  content = yamlencode({
    schemaVersion = "2.2"
    description   = "EC2検索APIサーバーのバイナリを更新する（S3から再ダウンロード→サービス再起動）"
    parameters = {
      BinaryBucket = {
        type        = "String"
        description = "バイナリを格納しているS3バケット名"
        default     = var.binary_bucket
      }
      BinaryKey = {
        type        = "String"
        description = "S3バケット内のバイナリのキー（パス）"
        default     = var.binary_key
      }
      BinaryName = {
        type        = "String"
        description = "バイナリのファイル名"
        default     = var.binary_name
      }
    }
    mainSteps = [
      {
        action = "aws:runShellScript"
        name   = "updateBinary"
        inputs = {
          runCommand = [
            "#!/bin/bash",
            "set -euo pipefail",
            "",
            "# パラメータを取得",
            "BINARY_BUCKET='{{ BinaryBucket }}'",
            "BINARY_KEY='{{ BinaryKey }}'",
            "BINARY_NAME='{{ BinaryName }}'",
            "AWS_REGION='${data.aws_region.current.name}'",
            "",
            "echo 'Starting binary update at '$(date)",
            "",
            "# サービスを停止",
            "echo 'Stopping nostr-api service...'",
            "systemctl stop nostr-api",
            "",
            "# 新しいバイナリをダウンロード",
            "echo 'Downloading new binary from S3...'",
            "aws s3 cp \"s3://$BINARY_BUCKET/$BINARY_KEY\" \"/opt/nostr-api/$BINARY_NAME\" --region \"$AWS_REGION\"",
            "",
            "# 権限を設定",
            "chown nostr-api:nostr-api \"/opt/nostr-api/$BINARY_NAME\"",
            "chmod 755 \"/opt/nostr-api/$BINARY_NAME\"",
            "",
            "# サービスを再起動",
            "echo 'Starting nostr-api service...'",
            "systemctl start nostr-api",
            "",
            "# ステータスを確認",
            "echo 'Update completed at '$(date)",
            "systemctl status nostr-api --no-pager"
          ]
        }
      }
    ]
  })

  tags = {
    Name = "nostr-relay-ec2-search-update-binary"
  }
}

# ------------------------------------------------------------------------------
# Outputs
# ------------------------------------------------------------------------------

output "binary_bucket_arn" {
  description = "バイナリ配布用S3バケットのARN"
  value       = aws_s3_bucket.binary.arn
}

output "binary_bucket_domain_name" {
  description = "バイナリ配布用S3バケットのドメイン名"
  value       = aws_s3_bucket.binary.bucket_domain_name
}

output "ssm_document_name" {
  description = "バイナリ更新用SSMドキュメント名"
  value       = aws_ssm_document.update_binary.name
}

output "ssm_document_arn" {
  description = "バイナリ更新用SSMドキュメントのARN"
  value       = aws_ssm_document.update_binary.arn
}
