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

variable "relay_lambda_function_names" {
  description = "停止対象のrelay Lambda関数名リスト"
  type        = list(string)
}

variable "ec2_instance_id" {
  description = "sqlite-api EC2インスタンスID"
  type        = string
}

variable "cloudfront_distribution_id" {
  description = "CloudFrontディストリビューションID"
  type        = string
}

variable "sqlite_api_systemd_service" {
  description = "sqlite-apiのsystemdサービス名"
  type        = string
  default     = "nostr-api"
}

variable "sqlite_api_endpoint" {
  description = "sqlite-apiヘルスチェックエンドポイントURL"
  type        = string
}

variable "recovery_schedule_time" {
  description = "月次復旧実行時刻（cron式）"
  type        = string
  default     = "cron(5 15 1 * ? *)" # 毎月1日 00:05 JST (UTC 15:05)
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
# Task 4.3: Shutdown Lambda用IAMロールとポリシー
#
# 要件:
# - Lambda PutFunctionConcurrency/GetFunction権限を付与
# - EC2 StopInstances/DescribeInstances権限を付与
# - SSM SendCommand/GetCommandInvocation権限を付与
# - CloudFront UpdateDistribution/GetDistribution権限を付与
# - SNS Publish権限を付与
# - CloudWatch Logs権限を付与
# - リソースARNを限定して最小権限を実現
#
# Requirements: 5.2, 5.3
# ------------------------------------------------------------------------------

# Shutdown Lambda用IAMロール
resource "aws_iam_role" "shutdown_lambda" {
  name = "nostr-relay-shutdown-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = {
    Name = "nostr-relay-shutdown-lambda"
  }
}

# Shutdown Lambda用IAMポリシー
resource "aws_iam_role_policy" "shutdown_lambda" {
  name = "nostr-relay-shutdown-lambda-policy"
  role = aws_iam_role.shutdown_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # Lambda Concurrency制御権限
      # relay Lambda関数のreserved concurrencyを0に設定/削除
      {
        Sid    = "LambdaConcurrencyControl"
        Effect = "Allow"
        Action = [
          "lambda:PutFunctionConcurrency",
          "lambda:GetFunction"
        ]
        Resource = [
          for name in var.relay_lambda_function_names :
          "arn:aws:lambda:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:function:${name}"
        ]
      },
      # EC2停止権限
      # sqlite-api EC2インスタンスを停止
      {
        Sid    = "EC2StopControl"
        Effect = "Allow"
        Action = [
          "ec2:StopInstances"
        ]
        Resource = "arn:aws:ec2:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:instance/${var.ec2_instance_id}"
      },
      # EC2状態確認権限
      # インスタンス状態を確認するために必要
      {
        Sid    = "EC2DescribeInstances"
        Effect = "Allow"
        Action = [
          "ec2:DescribeInstances"
        ]
        Resource = "*"
      },
      # SSM Run Command権限
      # sqlite-apiのgraceful stopを実行
      {
        Sid    = "SSMRunCommand"
        Effect = "Allow"
        Action = [
          "ssm:SendCommand"
        ]
        Resource = [
          "arn:aws:ssm:${data.aws_region.current.name}::document/AWS-RunShellScript",
          "arn:aws:ec2:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:instance/${var.ec2_instance_id}"
        ]
      },
      # SSMコマンド結果取得権限
      {
        Sid    = "SSMGetCommandInvocation"
        Effect = "Allow"
        Action = [
          "ssm:GetCommandInvocation"
        ]
        Resource = "*"
      },
      # CloudFront無効化権限
      {
        Sid    = "CloudFrontControl"
        Effect = "Allow"
        Action = [
          "cloudfront:UpdateDistribution",
          "cloudfront:GetDistribution"
        ]
        Resource = "arn:aws:cloudfront::${data.aws_caller_identity.current.account_id}:distribution/${var.cloudfront_distribution_id}"
      },
      # SNS通知権限
      # 結果通知をSNSトピックに発行
      {
        Sid    = "SNSPublish"
        Effect = "Allow"
        Action = [
          "sns:Publish"
        ]
        Resource = aws_sns_topic.result.arn
      },
      # CloudWatch Logs権限
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/nostr-relay-shutdown:*"
      }
    ]
  })
}

# ------------------------------------------------------------------------------
# Task 4.3: Recovery Lambda用IAMロールとポリシー
#
# 要件:
# - Lambda DeleteFunctionConcurrency/GetFunction権限を付与
# - EC2 StartInstances/DescribeInstances権限を付与
# - CloudFront UpdateDistribution/GetDistribution権限を付与
# - SNS Publish権限を付与
# - CloudWatch Logs権限を付与
# - リソースARNを限定して最小権限を実現
#
# Requirements: 5.2, 5.3
# ------------------------------------------------------------------------------

# Recovery Lambda用IAMロール
resource "aws_iam_role" "recovery_lambda" {
  name = "nostr-relay-recovery-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = {
    Name = "nostr-relay-recovery-lambda"
  }
}

# Recovery Lambda用IAMポリシー
resource "aws_iam_role_policy" "recovery_lambda" {
  name = "nostr-relay-recovery-lambda-policy"
  role = aws_iam_role.recovery_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # Lambda Concurrency制御権限
      # relay Lambda関数のreserved concurrency設定を削除
      {
        Sid    = "LambdaConcurrencyControl"
        Effect = "Allow"
        Action = [
          "lambda:DeleteFunctionConcurrency",
          "lambda:GetFunction"
        ]
        Resource = [
          for name in var.relay_lambda_function_names :
          "arn:aws:lambda:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:function:${name}"
        ]
      },
      # EC2起動権限
      # sqlite-api EC2インスタンスを起動
      {
        Sid    = "EC2StartControl"
        Effect = "Allow"
        Action = [
          "ec2:StartInstances"
        ]
        Resource = "arn:aws:ec2:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:instance/${var.ec2_instance_id}"
      },
      # EC2状態確認権限
      # インスタンス状態を確認するために必要
      {
        Sid    = "EC2DescribeInstances"
        Effect = "Allow"
        Action = [
          "ec2:DescribeInstances"
        ]
        Resource = "*"
      },
      # CloudFront有効化権限
      {
        Sid    = "CloudFrontControl"
        Effect = "Allow"
        Action = [
          "cloudfront:UpdateDistribution",
          "cloudfront:GetDistribution"
        ]
        Resource = "arn:aws:cloudfront::${data.aws_caller_identity.current.account_id}:distribution/${var.cloudfront_distribution_id}"
      },
      # SNS通知権限
      # 結果通知をSNSトピックに発行
      {
        Sid    = "SNSPublish"
        Effect = "Allow"
        Action = [
          "sns:Publish"
        ]
        Resource = aws_sns_topic.result.arn
      },
      # CloudWatch Logs権限
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/nostr-relay-recovery:*"
      }
    ]
  })
}

# ------------------------------------------------------------------------------
# Task 4.4: Shutdown Lambda関数
#
# 要件:
# - ARM64アーキテクチャでデプロイ
# - タイムアウト180秒、メモリ256MB
# - 環境変数でLambda関数名リスト、EC2インスタンスID、CloudFront ID、
#   SNSトピックARN、sqlite-apiサービス名を設定
# - SNSトピックからのトリガー権限を設定
#
# Requirements: 5.4, 4.1
# ------------------------------------------------------------------------------

# Shutdown Lambda用ZIPアーカイブ
data "archive_file" "shutdown" {
  type        = "zip"
  source_file = "${path.module}/../../../services/relay/target/lambda/shutdown/bootstrap"
  output_path = "${path.module}/../../dist/shutdown.zip"
}

# Shutdown Lambda関数
resource "aws_lambda_function" "shutdown" {
  function_name    = "nostr-relay-shutdown"
  role             = aws_iam_role.shutdown_lambda.arn
  handler          = "bootstrap"
  runtime          = "provided.al2023"
  filename         = data.archive_file.shutdown.output_path
  source_code_hash = data.archive_file.shutdown.output_base64sha256
  timeout          = 180
  memory_size      = 256
  architectures    = ["arm64"]

  environment {
    variables = {
      # 停止対象のrelay Lambda関数名（カンマ区切り）
      RELAY_LAMBDA_FUNCTION_NAMES = join(",", var.relay_lambda_function_names)
      # sqlite-api EC2インスタンスID
      EC2_INSTANCE_ID = var.ec2_instance_id
      # CloudFrontディストリビューションID
      CLOUDFRONT_DISTRIBUTION_ID = var.cloudfront_distribution_id
      # 結果通知SNSトピックARN
      RESULT_SNS_TOPIC_ARN = aws_sns_topic.result.arn
      # sqlite-apiのsystemdサービス名
      SQLITE_API_SYSTEMD_SERVICE = var.sqlite_api_systemd_service
      # パニック時にバックトレースを出力
      RUST_BACKTRACE = "1"
    }
  }

  tags = {
    Name = "nostr-relay-shutdown"
  }
}

# CloudWatch Logsロググループ（Shutdown Lambda用）
resource "aws_cloudwatch_log_group" "shutdown_lambda" {
  name              = "/aws/lambda/nostr-relay-shutdown"
  retention_in_days = 90

  tags = {
    Name = "nostr-relay-shutdown-logs"
  }
}

# SNSトピックからShutdown Lambdaを起動する権限
resource "aws_lambda_permission" "shutdown_sns" {
  statement_id  = "AllowSNSInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.shutdown.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.budget_alert.arn
}

# SNSトピックからShutdown Lambdaへのサブスクリプション
resource "aws_sns_topic_subscription" "shutdown_lambda" {
  topic_arn = aws_sns_topic.budget_alert.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.shutdown.arn
}

# ------------------------------------------------------------------------------
# Task 4.4: Recovery Lambda関数
#
# 要件:
# - ARM64アーキテクチャでデプロイ
# - タイムアウト180秒、メモリ256MB
# - 環境変数でLambda関数名リスト、EC2インスタンスID、CloudFront ID、
#   SNSトピックARN、sqlite-apiエンドポイントを設定
# - EventBridgeからのトリガー権限を設定
#
# Requirements: 5.4, 4.2
# ------------------------------------------------------------------------------

# Recovery Lambda用ZIPアーカイブ
data "archive_file" "recovery" {
  type        = "zip"
  source_file = "${path.module}/../../../services/relay/target/lambda/recovery/bootstrap"
  output_path = "${path.module}/../../dist/recovery.zip"
}

# Recovery Lambda関数
resource "aws_lambda_function" "recovery" {
  function_name    = "nostr-relay-recovery"
  role             = aws_iam_role.recovery_lambda.arn
  handler          = "bootstrap"
  runtime          = "provided.al2023"
  filename         = data.archive_file.recovery.output_path
  source_code_hash = data.archive_file.recovery.output_base64sha256
  timeout          = 180
  memory_size      = 256
  architectures    = ["arm64"]

  environment {
    variables = {
      # 有効化対象のrelay Lambda関数名（カンマ区切り）
      RELAY_LAMBDA_FUNCTION_NAMES = join(",", var.relay_lambda_function_names)
      # sqlite-api EC2インスタンスID
      EC2_INSTANCE_ID = var.ec2_instance_id
      # CloudFrontディストリビューションID
      CLOUDFRONT_DISTRIBUTION_ID = var.cloudfront_distribution_id
      # 結果通知SNSトピックARN
      RESULT_SNS_TOPIC_ARN = aws_sns_topic.result.arn
      # sqlite-apiヘルスチェックエンドポイントURL
      SQLITE_API_ENDPOINT = var.sqlite_api_endpoint
      # パニック時にバックトレースを出力
      RUST_BACKTRACE = "1"
    }
  }

  tags = {
    Name = "nostr-relay-recovery"
  }
}

# CloudWatch Logsロググループ（Recovery Lambda用）
resource "aws_cloudwatch_log_group" "recovery_lambda" {
  name              = "/aws/lambda/nostr-relay-recovery"
  retention_in_days = 90

  tags = {
    Name = "nostr-relay-recovery-logs"
  }
}

# ------------------------------------------------------------------------------
# Task 4.4: EventBridge Scheduleルール（月次Recovery トリガー）
#
# 要件:
# - 毎月1日にRecovery Lambdaをトリガー
# - スケジュール時刻を変数で設定可能（デフォルト: 毎月1日 00:05 JST）
# - EventBridgeからRecovery Lambdaを起動する権限を設定
#
# Requirements: 4.1, 4.2, 5.5
# ------------------------------------------------------------------------------

# EventBridge Scheduleルール
resource "aws_cloudwatch_event_rule" "monthly_recovery" {
  name                = "nostr-relay-monthly-recovery"
  description         = "毎月1日にNostr Relayサービスを自動復旧する"
  schedule_expression = var.recovery_schedule_time

  tags = {
    Name = "nostr-relay-monthly-recovery"
  }
}

# EventBridge -> Recovery Lambda ターゲット
resource "aws_cloudwatch_event_target" "monthly_recovery" {
  rule      = aws_cloudwatch_event_rule.monthly_recovery.name
  target_id = "recovery-lambda"
  arn       = aws_lambda_function.recovery.arn
}

# EventBridgeからRecovery Lambdaを起動する権限
resource "aws_lambda_permission" "recovery_eventbridge" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.recovery.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.monthly_recovery.arn
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

output "shutdown_lambda_role_arn" {
  description = "Shutdown Lambda IAMロールARN"
  value       = aws_iam_role.shutdown_lambda.arn
}

output "shutdown_lambda_role_name" {
  description = "Shutdown Lambda IAMロール名"
  value       = aws_iam_role.shutdown_lambda.name
}

output "recovery_lambda_role_arn" {
  description = "Recovery Lambda IAMロールARN"
  value       = aws_iam_role.recovery_lambda.arn
}

output "recovery_lambda_role_name" {
  description = "Recovery Lambda IAMロール名"
  value       = aws_iam_role.recovery_lambda.name
}

# Task 4.4: Lambda関数出力
output "shutdown_lambda_function_name" {
  description = "Shutdown Lambda関数名"
  value       = aws_lambda_function.shutdown.function_name
}

output "shutdown_lambda_function_arn" {
  description = "Shutdown Lambda関数ARN"
  value       = aws_lambda_function.shutdown.arn
}

output "recovery_lambda_function_name" {
  description = "Recovery Lambda関数名"
  value       = aws_lambda_function.recovery.function_name
}

output "recovery_lambda_function_arn" {
  description = "Recovery Lambda関数ARN"
  value       = aws_lambda_function.recovery.arn
}

output "monthly_recovery_rule_arn" {
  description = "EventBridge月次復旧ルールARN"
  value       = aws_cloudwatch_event_rule.monthly_recovery.arn
}

output "monthly_recovery_rule_name" {
  description = "EventBridge月次復旧ルール名"
  value       = aws_cloudwatch_event_rule.monthly_recovery.name
}
