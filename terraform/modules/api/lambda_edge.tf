# ------------------------------------------------------------------------------
# Lambda@Edge Router
#
# us-east-1リージョンにデプロイされるLambda@Edge関数
# CloudFront Viewer RequestでAcceptヘッダーに基づきルーティング
#
# 要件: 6.1
# ------------------------------------------------------------------------------

# ------------------------------------------------------------------------------
# Lambda@Edge用IAMロール（us-east-1）
# ------------------------------------------------------------------------------
resource "aws_iam_role" "lambda_edge_exec" {
  provider = aws.us_east_1
  name     = "nostr_relay_lambda_edge_exec"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = [
            "lambda.amazonaws.com",
            "edgelambda.amazonaws.com"
          ]
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_edge_basic" {
  provider   = aws.us_east_1
  role       = aws_iam_role.lambda_edge_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# ------------------------------------------------------------------------------
# Lambda@Edgeソースコード（templatefileでドメイン名を埋め込み）
# ------------------------------------------------------------------------------
data "archive_file" "edge_router" {
  type        = "zip"
  output_path = "${path.module}/../../dist/edge_router.zip"

  source {
    content = templatefile("${path.module}/edge-router/index.js", {
      nip11_function_url_domain = replace(replace(aws_lambda_function_url.nip11_info.function_url, "https://", ""), "/", "")
    })
    filename = "index.js"
  }
}

# ------------------------------------------------------------------------------
# Lambda@Edge関数（us-east-1）
# ------------------------------------------------------------------------------
resource "aws_lambda_function" "edge_router" {
  provider         = aws.us_east_1
  function_name    = "nostr_relay_edge_router"
  role             = aws_iam_role.lambda_edge_exec.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  filename         = data.archive_file.edge_router.output_path
  source_code_hash = data.archive_file.edge_router.output_base64sha256
  timeout          = 5
  publish          = true # Lambda@Edgeにはバージョン発行が必須

  # Lambda@Edgeでは環境変数が使用できないため、
  # NIP-11ドメインはtemplatefileで埋め込み済み
}

# ------------------------------------------------------------------------------
# Lambda@EdgeのCloudWatch Logsポリシー
# Lambda@Edgeはエッジロケーションごとにログを出力するため、
# 各リージョンのCloudWatch Logsへの書き込み権限が必要
# ------------------------------------------------------------------------------
resource "aws_iam_policy" "lambda_edge_logs" {
  provider    = aws.us_east_1
  name        = "nostr_relay_lambda_edge_logs"
  description = "IAM policy for Lambda@Edge to write logs to CloudWatch in all regions"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:*:*:*"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_edge_logs" {
  provider   = aws.us_east_1
  role       = aws_iam_role.lambda_edge_exec.name
  policy_arn = aws_iam_policy.lambda_edge_logs.arn
}
