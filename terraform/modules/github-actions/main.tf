variable "binary_bucket_arn" {
  description = "S3バイナリバケットのARN"
  type        = string
}

# GitHub ActionsのOIDCプロバイダー
resource "aws_iam_openid_connect_provider" "github_actions" {
  url = "https://token.actions.githubusercontent.com"

  client_id_list = [
    "sts.amazonaws.com",
  ]

  # GitHub Actionsの既知のサムプリント
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd"
  ]

  tags = {
    Name = "GitHub Actions OIDC Provider"
  }
}

# GitHub Actions用IAMロール
resource "aws_iam_role" "github_actions_deploy" {
  name = "nostr-relay-github-actions-deploy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = aws_iam_openid_connect_provider.github_actions.arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          }
          StringLike = {
            "token.actions.githubusercontent.com:sub" = [
              "repo:nisshiee/my-nostr-relay:ref:refs/heads/*",
              "repo:nisshiee/my-nostr-relay:environment:*"
            ]
          }
        }
      }
    ]
  })

  tags = {
    Name = "GitHub Actions Deploy Role"
  }
}

# S3アクセス用ポリシー
resource "aws_iam_role_policy" "s3_access" {
  name = "s3-binary-access"
  role = aws_iam_role.github_actions_deploy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:PutObjectAcl"
        ]
        Resource = "${var.binary_bucket_arn}/*"
      }
    ]
  })
}

output "github_actions_role_arn" {
  description = "GitHub Actions用IAMロールのARN"
  value       = aws_iam_role.github_actions_deploy.arn
}

output "oidc_provider_arn" {
  description = "OIDC プロバイダーのARN"
  value       = aws_iam_openid_connect_provider.github_actions.arn
}