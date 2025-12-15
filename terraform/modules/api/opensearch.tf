# ------------------------------------------------------------------------------
# Indexer Lambda Function
# DynamoDB StreamsからSQLite検索APIにインデックス処理を行うLambda関数
# 注: 歴史的な理由でopensearch.tfに配置されているが、OpenSearchは使用していない
# ------------------------------------------------------------------------------

data "archive_file" "indexer" {
  type        = "zip"
  source_file = "${path.module}/../../../services/relay/target/lambda/indexer/bootstrap"
  output_path = "${path.module}/../../dist/indexer.zip"
}

resource "aws_lambda_function" "indexer" {
  function_name    = "nostr_relay_indexer"
  role             = aws_iam_role.lambda_exec.arn
  handler          = "bootstrap"
  runtime          = "provided.al2023"
  filename         = data.archive_file.indexer.output_path
  source_code_hash = data.archive_file.indexer.output_base64sha256
  timeout          = 30
  architectures    = ["arm64"]

  environment {
    variables = {
      SQLITE_API_ENDPOINT    = var.sqlite_api_endpoint
      SQLITE_API_TOKEN_PARAM = var.sqlite_api_token_param_path
      # パニック時にバックトレースを出力
      RUST_BACKTRACE = "1"
    }
  }

  tags = {
    Name = "nostr-relay-indexer"
  }
}

# ------------------------------------------------------------------------------
# DynamoDB Streams Event Source Mapping
# イベントソースマッピングでStreamsとLambdaを接続
# ------------------------------------------------------------------------------

resource "aws_lambda_event_source_mapping" "indexer" {
  event_source_arn  = aws_dynamodb_table.events.stream_arn
  function_name     = aws_lambda_function.indexer.arn
  starting_position = "LATEST"
  batch_size        = 100

  # 失敗時のリトライ対応
  maximum_retry_attempts = 3
}

# ------------------------------------------------------------------------------
# IAM Policy for DynamoDB Streams Access
# indexer LambdaにDynamoDB Streamsへのアクセス権限を付与
# ------------------------------------------------------------------------------

resource "aws_iam_policy" "lambda_dynamodb_streams" {
  name        = "nostr_relay_lambda_dynamodb_streams"
  description = "IAM policy for Lambda to read DynamoDB Streams"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetRecords",
          "dynamodb:GetShardIterator",
          "dynamodb:DescribeStream",
          "dynamodb:ListStreams"
        ]
        Resource = [
          "${aws_dynamodb_table.events.arn}/stream/*"
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_dynamodb_streams" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = aws_iam_policy.lambda_dynamodb_streams.arn
}
