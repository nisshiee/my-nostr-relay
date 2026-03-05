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
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

# ------------------------------------------------------------------------------
# 変数定義
# ------------------------------------------------------------------------------

variable "domain_name" {
  description = "ベースドメイン名（例: nostr.nisshiee.org）"
  type        = string
}

variable "zone_id" {
  description = "Route 53ホストゾーンID"
  type        = string
}

variable "events_table_arn" {
  description = "DynamoDB eventsテーブルのARN"
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

variable "alpine_ami_id" {
  description = "Alpine Linux AMI ID (aarch64 UEFI)"
  type        = string
  default     = "ami-031de6eae288436c6" # Alpine 3.23.3 aarch64 uefi tiny (ap-northeast-1)
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

  # SSH: GitHub Actionsからのデプロイ用（鍵認証で保護）
  ingress {
    description = "SSH for deployment"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # アウトバウンドは全許可（DynamoDB, S3通信用）
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

# DynamoDB + S3アクセス用カスタムポリシー
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
# t4g.nano: ARM64 (Graviton2)、2 vCPU、512MB RAM
# ------------------------------------------------------------------------------

resource "aws_instance" "relay" {
  ami           = var.alpine_ami_id
  instance_type = "t4g.nano"

  subnet_id              = tolist(data.aws_subnets.public.ids)[0]
  vpc_security_group_ids = [aws_security_group.relay.id]
  iam_instance_profile   = aws_iam_instance_profile.relay.name
  ebs_optimized          = true

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 2
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

  user_data = base64encode(file("${path.module}/user_data.sh.tpl"))

  user_data_replace_on_change = false

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
# Route 53 Aレコード
# CloudFrontオリジンにはドメイン名が必要（IPアドレス直指定不可）
# ランダムサブドメインでオリジンエンドポイントの推測を困難にする
# ------------------------------------------------------------------------------

resource "random_string" "origin_subdomain" {
  length  = 8
  special = false
  upper   = false
  numeric = true
  lower   = true
}

resource "aws_route53_record" "relay" {
  zone_id = var.zone_id
  name    = "${random_string.origin_subdomain.result}.relay.${var.domain_name}"
  type    = "A"
  ttl     = 300

  records = [aws_eip.relay.public_ip]
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

output "iam_role_arn" {
  value = aws_iam_role.relay.arn
}

output "origin_domain_name" {
  description = "CloudFrontオリジン用ドメイン名"
  value       = aws_route53_record.relay.fqdn
}
