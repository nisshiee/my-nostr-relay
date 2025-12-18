terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    vercel = {
      source  = "vercel/vercel"
      version = "~> 1.0"
    }
  }

  backend "s3" {
    bucket = "nostr-relay-tfstate-426192960050"
    key    = "terraform.tfstate"
    region = "ap-northeast-1"
  }
}

provider "aws" {
  region = "ap-northeast-1"
}

# us-east-1プロバイダー（Lambda@EdgeとCloudFront証明書用）
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

provider "vercel" {
  # VERCEL_API_TOKEN is required
}

data "aws_caller_identity" "current" {}

locals {
  domain_name = "nostr.nisshiee.org"
}

# ------------------------------------------------------------------------------
# Budget Module用変数
# Task 4.5: 予算管理モジュールの設定変数
# ------------------------------------------------------------------------------

variable "budget_limit_amount" {
  description = "月額予算閾値（USD）"
  type        = string
  default     = "10"
}

variable "slack_team_id" {
  description = "Slack Team ID（例: T07EA123LEP）。AWS ChatbotでSlackワークスペース連携後に取得"
  type        = string
}

variable "slack_channel_id" {
  description = "Slackチャンネル ID（例: C07EZ1ABC23）。通知先チャンネルのID"
  type        = string
}

# ------------------------------------------------------------------------------
# Modules
# ------------------------------------------------------------------------------

module "domain" {
  source      = "./modules/domain"
  domain_name = local.domain_name
}

# ------------------------------------------------------------------------------
# CloudFront用ACM証明書 (us-east-1)
# CloudFrontではus-east-1リージョンの証明書が必須
# ------------------------------------------------------------------------------
resource "aws_acm_certificate" "cloudfront" {
  provider          = aws.us_east_1
  domain_name       = "relay.${local.domain_name}"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "nostr-relay-cloudfront"
  }
}

resource "aws_route53_record" "cloudfront_acm_validation" {
  for_each = {
    for dvo in aws_acm_certificate.cloudfront.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = module.domain.zone_id
}

resource "aws_acm_certificate_validation" "cloudfront" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.cloudfront.arn
  validation_record_fqdns = [for record in aws_route53_record.cloudfront_acm_validation : record.fqdn]
}

module "api" {
  source                     = "./modules/api"
  domain_name                = local.domain_name
  zone_id                    = module.domain.zone_id
  certificate_arn            = module.domain.certificate_arn
  cloudfront_certificate_arn = aws_acm_certificate_validation.cloudfront.certificate_arn

  # NIP-11 リレー情報設定
  relay_name             = "nisshieeのリレー"
  relay_description      = "試験運用中のため、無断でイベント削除・サービス停止する可能性があります。また、正常な動作を保証していません。"
  relay_pubkey           = "73491509b8e2d80840873b5a13ba98a5d1ac3a16c9292e106b1f2eda31152c52"
  relay_contact          = "mailto:nostr-relay-admin@nisshiee.org"
  relay_icon             = "https://www.gravatar.com/avatar/c48758d8162582b770092002effb7dff"
  relay_banner           = "https://nisshiee.org/ogimage.png"
  relay_privacy_policy   = "https://nostr.nisshiee.org/relay/privacy"
  relay_terms_of_service = "https://nostr.nisshiee.org/relay/terms"
  relay_posting_policy   = "https://nostr.nisshiee.org/relay/posting-policy"

  # Task 3.5: EC2 SQLite検索API設定
  sqlite_api_endpoint         = module.ec2_search.search_api_url
  sqlite_api_token_param_path = module.ec2_search.parameter_store_path
  lambda_ssm_policy_arn       = module.ec2_search.lambda_ssm_policy_arn

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  depends_on = [module.ec2_search]
}

module "web" {
  source      = "./modules/web"
  domain_name = local.domain_name
  zone_id     = module.domain.zone_id
}

# ------------------------------------------------------------------------------
# EC2 Search Module
# SQLiteベースの検索APIサーバー用インフラストラクチャ
# OpenSearch Serviceの低コスト代替として導入
# ------------------------------------------------------------------------------
module "ec2_search" {
  source               = "./modules/ec2-search"
  domain_name          = local.domain_name
  zone_id              = module.domain.zone_id
  binary_bucket        = "nostr-relay-binary-${data.aws_caller_identity.current.account_id}"
  binary_key           = "sqlite-api/sqlite-api"
  binary_name          = "sqlite-api"
  parameter_store_path = "/nostr-relay/ec2-search/api-token"
}

# ------------------------------------------------------------------------------
# Budget Module
# Task 4.5: AWS予算アラートに基づくサービス自動停止・復旧機能
#
# 要件:
# - AWS Budgetの閾値超過時にサービスを自動停止
# - 月初に自動でサービスを復旧
# - Slack通知により停止/復旧状態を運用者に即時通知
#
# Requirements: 5.6
# ------------------------------------------------------------------------------
module "budget" {
  source = "./modules/budget"

  # 予算設定
  budget_limit_amount = var.budget_limit_amount

  # Slack連携設定
  slack_team_id    = var.slack_team_id
  slack_channel_id = var.slack_channel_id

  # 停止対象のrelay Lambda関数名リスト
  # modules/api で定義されているLambda関数を参照
  relay_lambda_function_names = [
    "nostr_relay_connect",
    "nostr_relay_disconnect",
    "nostr_relay_default"
  ]

  # sqlite-api EC2インスタンスID
  # modules/ec2-searchの出力を参照
  ec2_instance_id = module.ec2_search.instance_id

  # CloudFrontディストリビューションID
  # modules/apiの出力を参照
  cloudfront_distribution_id = module.api.cloudfront_distribution_id

  # sqlite-apiヘルスチェックエンドポイント
  # Recovery Lambdaがsqlite-apiの起動確認に使用
  sqlite_api_endpoint = module.ec2_search.search_api_url

  depends_on = [module.api, module.ec2_search]
}

output "nameservers" {
  value = module.domain.nameservers
}

output "cloudfront_distribution_id" {
  value = module.api.cloudfront_distribution_id
}

output "cloudfront_domain_name" {
  value = module.api.cloudfront_domain_name
}

output "ec2_search_security_group_id" {
  description = "EC2検索サーバー用セキュリティグループID"
  value       = module.ec2_search.security_group_id
}

output "ec2_search_instance_id" {
  description = "EC2検索サーバーインスタンスID"
  value       = module.ec2_search.instance_id
}

output "ec2_search_private_ip" {
  description = "EC2検索サーバーのプライベートIPアドレス"
  value       = module.ec2_search.private_ip
}

output "ec2_search_elastic_ip" {
  description = "EC2検索サーバーのElastic IP（パブリックIPアドレス）"
  value       = module.ec2_search.elastic_ip
}

output "ec2_search_api_endpoint" {
  description = "EC2検索APIエンドポイントFQDN"
  value       = module.ec2_search.search_api_endpoint
}

output "ec2_search_api_url" {
  description = "EC2検索APIのベースURL"
  value       = module.ec2_search.search_api_url
  sensitive   = true
}

output "ec2_search_parameter_store_path" {
  description = "APIトークンを保存するParameter Storeのパス"
  value       = module.ec2_search.parameter_store_path
}

output "ec2_search_binary_bucket" {
  description = "HTTP APIサーバーバイナリを格納するS3バケット名"
  value       = module.ec2_search.binary_bucket
}

output "ec2_search_api_token_parameter_arn" {
  description = "APIトークンパラメータのARN"
  value       = module.ec2_search.api_token_parameter_arn
}

output "ec2_search_lambda_ssm_policy_arn" {
  description = "Lambda用SSMアクセスポリシーのARN（Lambda IAMロールにアタッチ用）"
  value       = module.ec2_search.lambda_ssm_policy_arn
}

output "ec2_search_binary_bucket_arn" {
  description = "バイナリ配布用S3バケットのARN"
  value       = module.ec2_search.binary_bucket_arn
}

output "ec2_search_ssm_document_name" {
  description = "バイナリ更新用SSMドキュメント名"
  value       = module.ec2_search.ssm_document_name
}

output "ec2_search_ssm_document_arn" {
  description = "バイナリ更新用SSMドキュメントのARN"
  value       = module.ec2_search.ssm_document_arn
}

# ------------------------------------------------------------------------------
# Budget Module Outputs
# Task 4.5: 予算管理モジュールの出力
# ------------------------------------------------------------------------------

output "budget_alert_sns_topic_arn" {
  description = "予算アラートSNSトピックARN"
  value       = module.budget.alert_sns_topic_arn
}

output "budget_result_sns_topic_arn" {
  description = "結果通知SNSトピックARN"
  value       = module.budget.result_sns_topic_arn
}

output "budget_shutdown_lambda_function_name" {
  description = "Shutdown Lambda関数名"
  value       = module.budget.shutdown_lambda_function_name
}

output "budget_recovery_lambda_function_name" {
  description = "Recovery Lambda関数名"
  value       = module.budget.recovery_lambda_function_name
}

output "budget_name" {
  description = "AWS Budget名"
  value       = module.budget.budget_name
}

output "budget_limit_amount" {
  description = "設定された予算閾値（USD）"
  value       = module.budget.budget_limit_amount
}

output "budget_monthly_recovery_rule_name" {
  description = "EventBridge月次復旧ルール名"
  value       = module.budget.monthly_recovery_rule_name
}

output "budget_chatbot_configuration_arn" {
  description = "AWS Chatbot Slack Channel Configuration ARN"
  value       = module.budget.chatbot_configuration_arn
}
