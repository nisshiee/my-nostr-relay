# ------------------------------------------------------------------------------
# DynamoDB Tables
# ------------------------------------------------------------------------------

# Events Table - Nostrイベントを保存
resource "aws_dynamodb_table" "events" {
  name           = "nostr_relay_events"
  billing_mode   = "PROVISIONED"
  read_capacity  = 5
  write_capacity = 5
  hash_key       = "id"

  # relay-v2ではDynamoDB Streamsは不要（indexer Lambda廃止のため）
  stream_enabled = false

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

  # GSI-PkKind: Replaceable event検索用 (pubkey#kind)
  global_secondary_index {
    name            = "GSI-PkKind"
    hash_key        = "pk_kind"
    range_key       = "created_at"
    projection_type = "ALL"
    read_capacity   = 2
    write_capacity  = 2
  }

  # GSI-PkKindD: Addressable event検索用 (pubkey#kind#d_tag)
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

# Events table outputs（ec2-relayモジュールから参照）
output "events_table_arn" {
  value = aws_dynamodb_table.events.arn
}

output "events_table_name" {
  value = aws_dynamodb_table.events.name
}
