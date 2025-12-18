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
