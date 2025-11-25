terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "ap-northeast-1"
}

# API Gateway v2 (Websocket)
resource "aws_apigatewayv2_api" "relay" {
  name                       = "nostr-relay"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
}

# IAM Role for Lambda
resource "aws_iam_role" "lambda_exec" {
  name = "nostr_relay_lambda_exec"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Lambda Functions

data "archive_file" "connect" {
  type        = "zip"
  source_file = "../../services/relay/target/lambda/connect/bootstrap"
  output_path = "dist/connect.zip"
}

resource "aws_lambda_function" "connect" {
  function_name = "nostr_relay_connect"
  role          = aws_iam_role.lambda_exec.arn
  handler       = "bootstrap"
  runtime       = "provided.al2023"
  filename      = data.archive_file.connect.output_path
  source_code_hash = data.archive_file.connect.output_base64sha256
}

data "archive_file" "disconnect" {
  type        = "zip"
  source_file = "../../services/relay/target/lambda/disconnect/bootstrap"
  output_path = "dist/disconnect.zip"
}

resource "aws_lambda_function" "disconnect" {
  function_name = "nostr_relay_disconnect"
  role          = aws_iam_role.lambda_exec.arn
  handler       = "bootstrap"
  runtime       = "provided.al2023"
  filename      = data.archive_file.disconnect.output_path
  source_code_hash = data.archive_file.disconnect.output_base64sha256
}

data "archive_file" "default" {
  type        = "zip"
  source_file = "../../services/relay/target/lambda/default/bootstrap"
  output_path = "dist/default.zip"
}

resource "aws_lambda_function" "default" {
  function_name = "nostr_relay_default"
  role          = aws_iam_role.lambda_exec.arn
  handler       = "bootstrap"
  runtime       = "provided.al2023"
  filename      = data.archive_file.default.output_path
  source_code_hash = data.archive_file.default.output_base64sha256
}
