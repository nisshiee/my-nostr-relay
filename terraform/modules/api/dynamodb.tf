# ------------------------------------------------------------------------------
# DynamoDB Tables
# ------------------------------------------------------------------------------

# Events Table - stores Nostr events
resource "aws_dynamodb_table" "events" {
  name           = "nostr_relay_events"
  billing_mode   = "PROVISIONED"
  read_capacity  = 5
  write_capacity = 5
  hash_key       = "id"

  # Task 7.4: DynamoDB Streamsを有効化（OpenSearchインデックス同期用）
  # 要件 3.4: NEW_AND_OLD_IMAGESストリームビュータイプを使用
  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  attribute {
    name = "id"
    type = "S"
  }

  attribute {
    name = "created_at"
    type = "N"
  }

  attribute {
    name = "pk_kind"
    type = "S"
  }

  attribute {
    name = "pk_kind_d"
    type = "S"
  }

  # GSI-PkKind: For Replaceable event lookups (pubkey#kind)
  global_secondary_index {
    name            = "GSI-PkKind"
    hash_key        = "pk_kind"
    range_key       = "created_at"
    projection_type = "ALL"
    read_capacity   = 2
    write_capacity  = 2
  }

  # GSI-PkKindD: For Addressable event lookups (pubkey#kind#d_tag)
  global_secondary_index {
    name            = "GSI-PkKindD"
    hash_key        = "pk_kind_d"
    range_key       = "created_at"
    projection_type = "ALL"
    read_capacity   = 2
    write_capacity  = 2
  }

  tags = {
    Name = "nostr-relay-events"
  }
}

# Connections Table - tracks WebSocket connections
resource "aws_dynamodb_table" "connections" {
  name           = "nostr_relay_connections"
  billing_mode   = "PROVISIONED"
  read_capacity  = 1
  write_capacity = 1
  hash_key       = "connection_id"

  attribute {
    name = "connection_id"
    type = "S"
  }

  # TTL for automatic cleanup of stale connections
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  tags = {
    Name = "nostr-relay-connections"
  }
}

# Subscriptions Table - stores active subscriptions per connection
resource "aws_dynamodb_table" "subscriptions" {
  name           = "nostr_relay_subscriptions"
  billing_mode   = "PROVISIONED"
  read_capacity  = 15
  write_capacity = 15
  hash_key       = "connection_id"
  range_key      = "subscription_id"

  attribute {
    name = "connection_id"
    type = "S"
  }

  attribute {
    name = "subscription_id"
    type = "S"
  }

  tags = {
    Name = "nostr-relay-subscriptions"
  }
}

# ------------------------------------------------------------------------------
# IAM Policy for DynamoDB Access
# ------------------------------------------------------------------------------

resource "aws_iam_policy" "lambda_dynamodb" {
  name        = "nostr_relay_lambda_dynamodb"
  description = "IAM policy for Lambda to access DynamoDB tables"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:BatchGetItem",
          "dynamodb:BatchWriteItem"
        ]
        Resource = [
          aws_dynamodb_table.events.arn,
          "${aws_dynamodb_table.events.arn}/index/*",
          aws_dynamodb_table.connections.arn,
          aws_dynamodb_table.subscriptions.arn
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_dynamodb" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = aws_iam_policy.lambda_dynamodb.arn
}
