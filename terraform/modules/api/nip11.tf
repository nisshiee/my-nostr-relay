# ------------------------------------------------------------------------------
# NIP-11 Lambda関数とFunction URL
#
# NIP-11（Relay Information Document）を提供するためのLambda関数と
# CloudFrontからアクセスするためのFunction URLを定義
# 要件: 6.2, 6.3
# ------------------------------------------------------------------------------

# ------------------------------------------------------------------------------
# NIP-11 Lambda関数
# ------------------------------------------------------------------------------
data "archive_file" "nip11_info" {
  type        = "zip"
  source_file = "${path.module}/../../../services/relay/target/lambda/nip11_info/bootstrap"
  output_path = "${path.module}/../../dist/nip11_info.zip"
}

resource "aws_lambda_function" "nip11_info" {
  function_name    = "nostr_relay_nip11_info"
  role             = aws_iam_role.lambda_exec.arn
  handler          = "bootstrap"
  runtime          = "provided.al2023"
  filename         = data.archive_file.nip11_info.output_path
  source_code_hash = data.archive_file.nip11_info.output_base64sha256
  timeout          = 10

  environment {
    variables = {
      # NIP-11リレー設定（環境変数から設定可能）
      RELAY_NAME          = var.relay_name
      RELAY_DESCRIPTION   = var.relay_description
      RELAY_PUBKEY        = var.relay_pubkey
      RELAY_CONTACT       = var.relay_contact
      RELAY_ICON          = var.relay_icon
      RELAY_BANNER        = var.relay_banner
      RELAY_COUNTRIES     = var.relay_countries
      RELAY_LANGUAGE_TAGS = var.relay_language_tags
    }
  }
}

# ------------------------------------------------------------------------------
# Lambda Function URL (認証なし)
# Lambda@Edgeからの動的オリジン切り替えではOACが適用されないため、
# 認証なしで公開し、Lambda@Edge経由でのみアクセスされる想定
# ------------------------------------------------------------------------------
resource "aws_lambda_function_url" "nip11_info" {
  function_name      = aws_lambda_function.nip11_info.function_name
  authorization_type = "NONE"
}

# ------------------------------------------------------------------------------
# Lambda Function URLへのパブリックアクセス許可
# AuthType=NONEでも、リソースベースポリシーで明示的にアクセスを許可する必要がある
# ------------------------------------------------------------------------------
resource "aws_lambda_permission" "nip11_public" {
  statement_id           = "AllowPublicAccess"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.nip11_info.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

# ------------------------------------------------------------------------------
# NIP-11設定用変数
# ------------------------------------------------------------------------------
variable "relay_name" {
  type        = string
  default     = ""
  description = "リレーの識別名（30文字以下推奨）"
}

variable "relay_description" {
  type        = string
  default     = ""
  description = "リレーの詳細説明"
}

variable "relay_pubkey" {
  type        = string
  default     = ""
  description = "管理者の32バイトhex公開鍵"
}

variable "relay_contact" {
  type        = string
  default     = ""
  description = "代替連絡先URI（mailto:やhttps:スキーム）"
}

variable "relay_icon" {
  type        = string
  default     = ""
  description = "リレーのアイコン画像URL"
}

variable "relay_banner" {
  type        = string
  default     = ""
  description = "リレーのバナー画像URL"
}

variable "relay_countries" {
  type        = string
  default     = "JP"
  description = "法的管轄の国コード（ISO 3166-1 alpha-2、カンマ区切り）"
}

variable "relay_language_tags" {
  type        = string
  default     = "ja"
  description = "主要言語タグ（IETF言語タグ形式、カンマ区切り）"
}
