# ------------------------------------------------------------------------------
# Task 1.5: APIトークンのParameter Store登録
#
# 要件:
# - SecureString形式でAPIトークンを保存
# - EC2とLambda用のIAMポリシーを設定
#
# Requirements: 3.5
# ------------------------------------------------------------------------------

# ------------------------------------------------------------------------------
# SSM Parameter - APIトークン
#
# SecureString形式でAPIトークンを保存
# 初期値はプレースホルダー、実際の値はTerraform適用後に手動で設定
#
# 値の設定方法:
#   aws ssm put-parameter \
#     --name "/nostr-relay/ec2-search/api-token" \
#     --value "YOUR_SECURE_TOKEN" \
#     --type SecureString \
#     --overwrite
# ------------------------------------------------------------------------------
resource "aws_ssm_parameter" "api_token" {
  name        = var.parameter_store_path
  description = "EC2検索APIサーバー用の認証トークン（EC2およびLambda関数で使用）"
  type        = "SecureString"
  tier        = "Standard"

  # 初期値はプレースホルダー
  # セキュリティ上、実際のトークンはTerraform外で設定することを推奨
  # lifecycle.ignore_changesで、手動設定した値がterraform applyで上書きされないようにする
  value = "PLACEHOLDER_CHANGE_ME"

  tags = {
    Name = "nostr-relay-ec2-search-api-token"
  }

  lifecycle {
    # 初回作成後、値はTerraform外で管理するため変更を無視
    ignore_changes = [value]
  }
}

# ------------------------------------------------------------------------------
# IAM Policy - Lambda用Parameter Storeアクセス
#
# Lambda関数がEC2検索APIのトークンを取得するために必要
# このポリシーは別途Lambda IAMロールにアタッチする必要がある
# ------------------------------------------------------------------------------
resource "aws_iam_policy" "lambda_ssm_access" {
  name        = "nostr-relay-lambda-ssm-access"
  description = "Lambda関数がEC2検索API用のAPIトークンをParameter Storeから取得するためのポリシー"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "GetApiToken"
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters"
        ]
        Resource = aws_ssm_parameter.api_token.arn
      },
      {
        Sid    = "DecryptApiToken"
        Effect = "Allow"
        Action = [
          "kms:Decrypt"
        ]
        # デフォルトのAWS管理キーを使用
        # SecureStringのデフォルト暗号化キー
        Resource = "*"
        Condition = {
          StringEquals = {
            "kms:ViaService" = "ssm.${data.aws_region.current.name}.amazonaws.com"
          }
        }
      }
    ]
  })

  tags = {
    Name = "nostr-relay-lambda-ssm-access"
  }
}

# ------------------------------------------------------------------------------
# Outputs
# ------------------------------------------------------------------------------

output "api_token_parameter_arn" {
  description = "APIトークンパラメータのARN"
  value       = aws_ssm_parameter.api_token.arn
}

output "lambda_ssm_policy_arn" {
  description = "Lambda用SSMアクセスポリシーのARN（Lambda IAMロールにアタッチ用）"
  value       = aws_iam_policy.lambda_ssm_access.arn
}
