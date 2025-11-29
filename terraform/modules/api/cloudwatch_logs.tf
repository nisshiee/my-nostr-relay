# ------------------------------------------------------------------------------
# CloudWatch Logs Groups
#
# Lambda関数のログを90日間保存する設定
# プライバシーポリシーに基づき、法的対処・不正利用防止のため
# アクセスログ（IPアドレス、User-Agent等）を保存
# ------------------------------------------------------------------------------

# Connect Lambda のロググループ
resource "aws_cloudwatch_log_group" "connect" {
  name              = "/aws/lambda/${aws_lambda_function.connect.function_name}"
  retention_in_days = 90

  tags = {
    Name = "nostr-relay-connect-logs"
  }
}

# Disconnect Lambda のロググループ
resource "aws_cloudwatch_log_group" "disconnect" {
  name              = "/aws/lambda/${aws_lambda_function.disconnect.function_name}"
  retention_in_days = 90

  tags = {
    Name = "nostr-relay-disconnect-logs"
  }
}

# Default Lambda のロググループ
resource "aws_cloudwatch_log_group" "default" {
  name              = "/aws/lambda/${aws_lambda_function.default.function_name}"
  retention_in_days = 90

  tags = {
    Name = "nostr-relay-default-logs"
  }
}

# NIP-11 Lambda のロググループ
resource "aws_cloudwatch_log_group" "nip11_info" {
  name              = "/aws/lambda/${aws_lambda_function.nip11_info.function_name}"
  retention_in_days = 90

  tags = {
    Name = "nostr-relay-nip11-info-logs"
  }
}
