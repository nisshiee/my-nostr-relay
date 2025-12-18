# ------------------------------------------------------------------------------
# Budget Module
#
# AWS予算アラートに基づくサービス自動停止・復旧機能のインフラストラクチャ
# AWS Budgetの閾値超過時にSNSトピックへ通知を送信し、Shutdown Lambdaをトリガーする
# ------------------------------------------------------------------------------

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# ------------------------------------------------------------------------------
# Data Sources
# ------------------------------------------------------------------------------

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# ------------------------------------------------------------------------------
# 変数定義
# ------------------------------------------------------------------------------

variable "budget_limit_amount" {
  description = "月額予算閾値（USD）"
  type        = string
  default     = "10"
}

variable "slack_team_id" {
  description = "Slack Team ID（例: T07EA123LEP）"
  type        = string
}

variable "slack_channel_id" {
  description = "Slackチャンネル ID（例: C07EZ1ABC23）"
  type        = string
}

# ------------------------------------------------------------------------------
# Task 4.1: 予算アラート用SNSトピック
#
# 要件:
# - AWS Budgetからの通知を受け取るSNSトピックを作成
# - budgets.amazonaws.comからのPublishを許可するポリシーを設定
#
# Requirements: 2.1, 2.2
# ------------------------------------------------------------------------------

resource "aws_sns_topic" "budget_alert" {
  name = "nostr-relay-budget-alert"

  tags = {
    Name = "nostr-relay-budget-alert"
  }
}

# SNSトピックポリシー: AWS Budgetからの発行を許可
resource "aws_sns_topic_policy" "budget_alert" {
  arn = aws_sns_topic.budget_alert.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Id      = "BudgetAlertTopicPolicy"
    Statement = [
      {
        Sid    = "AllowBudgetPublish"
        Effect = "Allow"
        Principal = {
          Service = "budgets.amazonaws.com"
        }
        Action   = "SNS:Publish"
        Resource = aws_sns_topic.budget_alert.arn
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = data.aws_caller_identity.current.account_id
          }
        }
      }
    ]
  })
}

# ------------------------------------------------------------------------------
# Task 4.1: AWS Budget
#
# 要件:
# - 月額コストの閾値を設定可能なAWS Budgetを作成
# - 閾値超過時にSNSトピックへ通知を送信
#
# Requirements: 1.1, 1.2, 1.3, 1.4, 5.1
# ------------------------------------------------------------------------------

resource "aws_budgets_budget" "monthly" {
  name         = "nostr-relay-monthly-budget"
  budget_type  = "COST"
  limit_amount = var.budget_limit_amount
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # 通知設定: 実績コストが閾値の100%に達した場合
  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.budget_alert.arn]
  }
}

# ------------------------------------------------------------------------------
# Task 4.2: 結果通知用SNSトピック
#
# 要件:
# - Shutdown/Recovery Lambdaの結果通知を受け取るSNSトピックを作成
# - AWS Chatbot経由でSlackへ通知
#
# Requirements: 2.3, 2.4
# ------------------------------------------------------------------------------

resource "aws_sns_topic" "result" {
  name = "nostr-relay-budget-result"

  tags = {
    Name = "nostr-relay-budget-result"
  }
}

# ------------------------------------------------------------------------------
# Task 4.2: AWS Chatbot用IAMロール
#
# 要件:
# - AWS ChatbotがSNSトピックをサブスクライブするためのIAMロールを作成
# - 最小権限の原則に基づいた権限設定
#
# Requirements: 2.3
# ------------------------------------------------------------------------------

# AWS Chatbot用IAMロール
resource "aws_iam_role" "chatbot" {
  name = "nostr-relay-chatbot-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "chatbot.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = {
    Name = "nostr-relay-chatbot-role"
  }
}

# AWS Chatbot用IAMポリシー
# AWS Chatbotには最小限の権限のみを付与（CloudWatch Logs読み取りのみ）
resource "aws_iam_role_policy" "chatbot" {
  name = "nostr-relay-chatbot-policy"
  role = aws_iam_role.chatbot.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudWatchLogsRead"
        Effect = "Allow"
        Action = [
          "logs:DescribeLogGroups",
          "logs:DescribeLogStreams",
          "logs:GetLogEvents"
        ]
        Resource = "*"
      }
    ]
  })
}

# ------------------------------------------------------------------------------
# Task 4.2: AWS Chatbot Slack連携
#
# 要件:
# - AWS Chatbot Slack Channel Configurationを作成
# - 予算アラートと結果通知の両方をSlackへ送信
#
# 注意: Slackワークスペース連携は事前にAWS Console手動設定が必要
#       1. AWS Console -> AWS Chatbot -> Configure new client
#       2. Slack workspaceのOAuth認証を完了
#       3. workspace_idを取得
#
# Requirements: 2.3, 2.4
# ------------------------------------------------------------------------------

resource "aws_chatbot_slack_channel_configuration" "budget_alerts" {
  configuration_name = "nostr-relay-budget-alerts"
  iam_role_arn       = aws_iam_role.chatbot.arn
  slack_channel_id   = var.slack_channel_id
  slack_team_id      = var.slack_team_id

  # 予算アラートと結果通知の両方をサブスクライブ
  sns_topic_arns = [
    aws_sns_topic.budget_alert.arn,
    aws_sns_topic.result.arn
  ]

  # ログレベル設定
  logging_level = "INFO"

  tags = {
    Name = "nostr-relay-budget-alerts"
  }
}

# ------------------------------------------------------------------------------
# Outputs
# ------------------------------------------------------------------------------

output "alert_sns_topic_arn" {
  description = "予算アラートSNSトピックARN"
  value       = aws_sns_topic.budget_alert.arn
}

output "alert_sns_topic_name" {
  description = "予算アラートSNSトピック名"
  value       = aws_sns_topic.budget_alert.name
}

output "budget_name" {
  description = "AWS Budget名"
  value       = aws_budgets_budget.monthly.name
}

output "budget_limit_amount" {
  description = "設定された予算閾値（USD）"
  value       = var.budget_limit_amount
}

output "result_sns_topic_arn" {
  description = "結果通知SNSトピックARN"
  value       = aws_sns_topic.result.arn
}

output "result_sns_topic_name" {
  description = "結果通知SNSトピック名"
  value       = aws_sns_topic.result.name
}

output "chatbot_configuration_arn" {
  description = "AWS Chatbot Slack Channel Configuration ARN"
  value       = aws_chatbot_slack_channel_configuration.budget_alerts.chat_configuration_arn
}

output "chatbot_role_arn" {
  description = "AWS Chatbot IAMロールARN"
  value       = aws_iam_role.chatbot.arn
}
