# ------------------------------------------------------------------------------
# S3バケット（バイナリ配布用）
#
# relay-v2バイナリを格納するS3バケット
# 元はec2-searchモジュールで管理していたが、ec2-search廃止に伴い
# ec2-relayモジュールでownershipを引き継ぐ
# ------------------------------------------------------------------------------

resource "aws_s3_bucket" "binary" {
  bucket = var.binary_bucket

  tags = {
    Name = "nostr-relay-binary"
  }
}

resource "aws_s3_bucket_versioning" "binary" {
  bucket = aws_s3_bucket.binary.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "binary" {
  bucket = aws_s3_bucket.binary.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "binary" {
  bucket = aws_s3_bucket.binary.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# バケットポリシー: relay-v2のIAMロールにアクセスを許可
resource "aws_s3_bucket_policy" "binary" {
  bucket = aws_s3_bucket.binary.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowEC2GetObject"
        Effect = "Allow"
        Principal = {
          AWS = aws_iam_role.relay.arn
        }
        Action = [
          "s3:GetObject",
          "s3:GetObjectVersion"
        ]
        Resource = "${aws_s3_bucket.binary.arn}/*"
      },
      {
        Sid    = "AllowEC2ListBucket"
        Effect = "Allow"
        Principal = {
          AWS = aws_iam_role.relay.arn
        }
        Action   = "s3:ListBucket"
        Resource = aws_s3_bucket.binary.arn
      }
    ]
  })
}

# ------------------------------------------------------------------------------
# Outputs
# ------------------------------------------------------------------------------

output "binary_bucket" {
  value = aws_s3_bucket.binary.bucket
}

output "binary_bucket_arn" {
  value = aws_s3_bucket.binary.arn
}
