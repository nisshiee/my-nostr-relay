terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "domain_name" {
  type = string
}

variable "zone_id" {
  type = string
}

variable "certificate_arn" {
  type = string
}

# ------------------------------------------------------------------------------
# IAM Role
# ------------------------------------------------------------------------------
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

# ------------------------------------------------------------------------------
# Lambda Functions
# ------------------------------------------------------------------------------
data "archive_file" "connect" {
  type        = "zip"
  source_file = "${path.module}/../../../services/relay/target/lambda/connect/bootstrap"
  output_path = "${path.module}/../../dist/connect.zip"
}

resource "aws_lambda_function" "connect" {
  function_name = "nostr_relay_connect"
  role          = aws_iam_role.lambda_exec.arn
  handler       = "bootstrap"
  runtime       = "provided.al2023"
  filename      = data.archive_file.connect.output_path
  source_code_hash = data.archive_file.connect.output_base64sha256

  environment {
    variables = {
      EVENTS_TABLE        = aws_dynamodb_table.events.name
      CONNECTIONS_TABLE   = aws_dynamodb_table.connections.name
      SUBSCRIPTIONS_TABLE = aws_dynamodb_table.subscriptions.name
    }
  }
}

data "archive_file" "disconnect" {
  type        = "zip"
  source_file = "${path.module}/../../../services/relay/target/lambda/disconnect/bootstrap"
  output_path = "${path.module}/../../dist/disconnect.zip"
}

resource "aws_lambda_function" "disconnect" {
  function_name = "nostr_relay_disconnect"
  role          = aws_iam_role.lambda_exec.arn
  handler       = "bootstrap"
  runtime       = "provided.al2023"
  filename      = data.archive_file.disconnect.output_path
  source_code_hash = data.archive_file.disconnect.output_base64sha256

  environment {
    variables = {
      EVENTS_TABLE        = aws_dynamodb_table.events.name
      CONNECTIONS_TABLE   = aws_dynamodb_table.connections.name
      SUBSCRIPTIONS_TABLE = aws_dynamodb_table.subscriptions.name
    }
  }
}

data "archive_file" "default" {
  type        = "zip"
  source_file = "${path.module}/../../../services/relay/target/lambda/default/bootstrap"
  output_path = "${path.module}/../../dist/default.zip"
}

resource "aws_lambda_function" "default" {
  function_name = "nostr_relay_default"
  role          = aws_iam_role.lambda_exec.arn
  handler       = "bootstrap"
  runtime       = "provided.al2023"
  filename      = data.archive_file.default.output_path
  source_code_hash = data.archive_file.default.output_base64sha256

  environment {
    variables = {
      EVENTS_TABLE        = aws_dynamodb_table.events.name
      CONNECTIONS_TABLE   = aws_dynamodb_table.connections.name
      SUBSCRIPTIONS_TABLE = aws_dynamodb_table.subscriptions.name
    }
  }
}

# ------------------------------------------------------------------------------
# API Gateway v2
# ------------------------------------------------------------------------------
resource "aws_apigatewayv2_api" "relay" {
  name                       = "nostr-relay"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.relay.id
  name        = "$default"
  auto_deploy = true
}

# Custom Domain Mapping
resource "aws_apigatewayv2_domain_name" "relay" {
  domain_name = "relay.${var.domain_name}"

  domain_name_configuration {
    certificate_arn = var.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
}

resource "aws_apigatewayv2_api_mapping" "relay" {
  api_id      = aws_apigatewayv2_api.relay.id
  domain_name = aws_apigatewayv2_domain_name.relay.id
  stage       = aws_apigatewayv2_stage.default.id
}

resource "aws_route53_record" "relay" {
  name    = aws_apigatewayv2_domain_name.relay.domain_name
  type    = "A"
  zone_id = var.zone_id

  alias {
    name                   = aws_apigatewayv2_domain_name.relay.domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.relay.domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}

# ------------------------------------------------------------------------------
# API Gateway Routes & Integrations (New)
# ------------------------------------------------------------------------------

# $connect
resource "aws_apigatewayv2_integration" "connect" {
  api_id           = aws_apigatewayv2_api.relay.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.connect.invoke_arn
}

resource "aws_apigatewayv2_route" "connect" {
  api_id    = aws_apigatewayv2_api.relay.id
  route_key = "$connect"
  target    = "integrations/${aws_apigatewayv2_integration.connect.id}"
}

resource "aws_lambda_permission" "connect" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.connect.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.relay.execution_arn}/*/$connect"
}

# $disconnect
resource "aws_apigatewayv2_integration" "disconnect" {
  api_id           = aws_apigatewayv2_api.relay.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.disconnect.invoke_arn
}

resource "aws_apigatewayv2_route" "disconnect" {
  api_id    = aws_apigatewayv2_api.relay.id
  route_key = "$disconnect"
  target    = "integrations/${aws_apigatewayv2_integration.disconnect.id}"
}

resource "aws_lambda_permission" "disconnect" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.disconnect.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.relay.execution_arn}/*/$disconnect"
}

# $default
resource "aws_apigatewayv2_integration" "default" {
  api_id           = aws_apigatewayv2_api.relay.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.default.invoke_arn
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.relay.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.default.id}"
}

resource "aws_lambda_permission" "default" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.default.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.relay.execution_arn}/*/$default"
}

# ------------------------------------------------------------------------------
# IAM Policy for API Gateway Management API Access
# ------------------------------------------------------------------------------

resource "aws_iam_policy" "lambda_apigateway_management" {
  name        = "nostr_relay_lambda_apigateway_management"
  description = "IAM policy for Lambda to send messages via API Gateway Management API"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "execute-api:ManageConnections"
        ]
        Resource = [
          "${aws_apigatewayv2_api.relay.execution_arn}/*"
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_apigateway_management" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = aws_iam_policy.lambda_apigateway_management.arn
}
