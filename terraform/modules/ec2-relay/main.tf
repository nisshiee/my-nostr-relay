# ------------------------------------------------------------------------------
# EC2 Relay Module
#
# relay-v2（axumベースの常駐WebSocketサーバー）用EC2インフラストラクチャ
# CloudFrontのオリジンとして動作する
# ------------------------------------------------------------------------------

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# ------------------------------------------------------------------------------
# 変数定義
# ------------------------------------------------------------------------------

variable "events_table_arn" {
  description = "DynamoDB eventsテーブルのARN"
  type        = string
}

variable "events_table_name" {
  description = "DynamoDB eventsテーブル名"
  type        = string
}

variable "binary_bucket" {
  description = "relay-v2バイナリを格納するS3バケット名"
  type        = string
}

variable "binary_key" {
  description = "S3バケット内のバイナリのキー（パス）"
  type        = string
  default     = "relay-v2/relay"
}

variable "relay_name" {
  description = "NIP-11 リレー名"
  type        = string
}

variable "relay_description" {
  description = "NIP-11 リレー説明"
  type        = string
}

variable "relay_pubkey" {
  description = "NIP-11 リレー管理者公開鍵"
  type        = string
}

variable "relay_contact" {
  description = "NIP-11 リレー連絡先"
  type        = string
}

variable "relay_icon" {
  description = "NIP-11 リレーアイコンURL"
  type        = string
  default     = ""
}

variable "relay_banner" {
  description = "NIP-11 リレーバナーURL"
  type        = string
  default     = ""
}

variable "relay_privacy_policy" {
  description = "NIP-11 プライバシーポリシーURL"
  type        = string
  default     = ""
}

variable "relay_terms_of_service" {
  description = "NIP-11 利用規約URL"
  type        = string
  default     = ""
}

variable "relay_posting_policy" {
  description = "NIP-11 投稿ポリシーURL"
  type        = string
  default     = ""
}

# ------------------------------------------------------------------------------
# Data Sources
# ------------------------------------------------------------------------------

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "public" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "map-public-ip-on-launch"
    values = ["true"]
  }
}

# Amazon Linux 2023 AMI（ARM64）
data "aws_ami" "amazon_linux_2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-kernel-*-arm64"]
  }
  filter {
    name   = "architecture"
    values = ["arm64"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# ------------------------------------------------------------------------------
# セキュリティグループ
#
# CloudFrontからのHTTP（ポート3000）のみ許可
# CloudFront Managed Prefix Listを使用してCloudFrontからのアクセスに限定
# ------------------------------------------------------------------------------

data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "relay" {
  name        = "nostr-relay-ec2-relay-v2"
  description = "Security group for relay-v2 server"
  vpc_id      = data.aws_vpc.default.id

  # relay-v2（ポート3000）: CloudFrontからのみ許可
  ingress {
    description     = "HTTP from CloudFront"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront.id]
  }

  # アウトバウンドは全許可（DynamoDB, SSM, S3通信用）
  egress {
    description = "Allow all outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "nostr-relay-ec2-relay-v2"
  }
}

# ------------------------------------------------------------------------------
# IAMロールとインスタンスプロファイル
# ------------------------------------------------------------------------------

resource "aws_iam_role" "relay" {
  name = "nostr-relay-ec2-relay-v2"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
    }]
  })

  tags = {
    Name = "nostr-relay-ec2-relay-v2"
  }
}

# SSM用マネージドポリシー
resource "aws_iam_role_policy_attachment" "relay_ssm" {
  role       = aws_iam_role.relay.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# DynamoDB + S3 + SSMアクセス用カスタムポリシー
resource "aws_iam_role_policy" "relay_custom" {
  name = "nostr-relay-ec2-relay-v2-custom"
  role = aws_iam_role.relay.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DynamoDBEventsAccess"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:DescribeTable"
        ]
        Resource = [
          var.events_table_arn,
          "${var.events_table_arn}/index/*"
        ]
      },
      {
        Sid    = "S3BinaryAccess"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:ListBucket"
        ]
        Resource = [
          "arn:aws:s3:::${var.binary_bucket}",
          "arn:aws:s3:::${var.binary_bucket}/*"
        ]
      }
    ]
  })
}

resource "aws_iam_instance_profile" "relay" {
  name = "nostr-relay-ec2-relay-v2"
  role = aws_iam_role.relay.name
}

# ------------------------------------------------------------------------------
# EC2インスタンス
#
# t4g.micro: ARM64 (Graviton2)、2 vCPU、1GB RAM
# ------------------------------------------------------------------------------

resource "aws_instance" "relay" {
  ami           = data.aws_ami.amazon_linux_2023.id
  instance_type = "t4g.micro"

  subnet_id              = tolist(data.aws_subnets.public.ids)[0]
  vpc_security_group_ids = [aws_security_group.relay.id]
  iam_instance_profile   = aws_iam_instance_profile.relay.name
  ebs_optimized          = true

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 8
    delete_on_termination = true
    encrypted             = true

    tags = {
      Name = "nostr-relay-ec2-relay-v2-root"
    }
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  user_data = base64encode(templatefile("${path.module}/user_data.sh.tpl", {
    events_table_name    = var.events_table_name
    relay_name           = var.relay_name
    relay_description    = var.relay_description
    relay_pubkey         = var.relay_pubkey
    relay_contact        = var.relay_contact
    relay_icon           = var.relay_icon
    relay_banner         = var.relay_banner
    relay_privacy_policy = var.relay_privacy_policy
    relay_terms_of_service = var.relay_terms_of_service
    relay_posting_policy = var.relay_posting_policy
  }))

  user_data_replace_on_change = true

  tags = {
    Name = "nostr-relay-ec2-relay-v2"
  }

  lifecycle {
    ignore_changes = [ami]
  }
}

# ------------------------------------------------------------------------------
# Elastic IP
# ------------------------------------------------------------------------------

resource "aws_eip" "relay" {
  domain = "vpc"

  tags = {
    Name = "nostr-relay-ec2-relay-v2"
  }
}

resource "aws_eip_association" "relay" {
  instance_id   = aws_instance.relay.id
  allocation_id = aws_eip.relay.id
}

# ------------------------------------------------------------------------------
# S3バケット（バイナリ配布用）
# ------------------------------------------------------------------------------

resource "aws_s3_bucket" "binary" {
  bucket = var.binary_bucket

  tags = {
    Name = "nostr-relay-ec2-relay-v2-binary"
  }
}

resource "aws_s3_bucket_versioning" "binary" {
  bucket = aws_s3_bucket.binary.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "binary" {
  bucket                  = aws_s3_bucket.binary.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "binary" {
  bucket = aws_s3_bucket.binary.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

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
        Action   = ["s3:GetObject", "s3:GetObjectVersion"]
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

  depends_on = [aws_s3_bucket_public_access_block.binary]
}

# ------------------------------------------------------------------------------
# SSM Document（バイナリ更新用）
# ------------------------------------------------------------------------------

resource "aws_ssm_document" "update_binary" {
  name            = "nostr-relay-ec2-relay-v2-update-binary"
  document_type   = "Command"
  document_format = "YAML"

  content = yamlencode({
    schemaVersion = "2.2"
    description   = "relay-v2バイナリを更新してサービスを再起動する"
    parameters = {
      BinaryBucket = {
        type    = "String"
        default = var.binary_bucket
      }
      BinaryKey = {
        type    = "String"
        default = var.binary_key
      }
    }
    mainSteps = [
      {
        action = "aws:runShellScript"
        name   = "updateBinary"
        inputs = {
          runCommand = [
            "#!/bin/bash",
            "set -euo pipefail",
            "",
            "BINARY_BUCKET='{{ BinaryBucket }}'",
            "BINARY_KEY='{{ BinaryKey }}'",
            "AWS_REGION='${data.aws_region.current.name}'",
            "",
            "echo '=== Update started at '$(date)' ==='",
            "",
            "echo 'Stopping relay-v2 service...'",
            "systemctl stop nostr-relay-v2 || true",
            "",
            "echo 'Downloading binary from S3...'",
            "aws s3 cp \"s3://$BINARY_BUCKET/$BINARY_KEY\" /opt/nostr-relay-v2/relay --region \"$AWS_REGION\"",
            "chown nostr-relay:nostr-relay /opt/nostr-relay-v2/relay",
            "chmod 755 /opt/nostr-relay-v2/relay",
            "",
            "echo 'Starting relay-v2 service...'",
            "systemctl start nostr-relay-v2",
            "",
            "echo '=== Update completed at '$(date)' ==='",
            "systemctl status nostr-relay-v2 --no-pager"
          ]
        }
      }
    ]
  })

  tags = {
    Name = "nostr-relay-ec2-relay-v2-update-binary"
  }
}

# ------------------------------------------------------------------------------
# Outputs
# ------------------------------------------------------------------------------

output "instance_id" {
  value = aws_instance.relay.id
}

output "elastic_ip" {
  value = aws_eip.relay.public_ip
}

output "security_group_id" {
  value = aws_security_group.relay.id
}

output "binary_bucket" {
  value = aws_s3_bucket.binary.bucket
}

output "binary_bucket_arn" {
  value = aws_s3_bucket.binary.arn
}

output "ssm_document_name" {
  value = aws_ssm_document.update_binary.name
}

output "iam_role_arn" {
  value = aws_iam_role.relay.arn
}
