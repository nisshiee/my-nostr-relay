# ------------------------------------------------------------------------------
# EC2 Search Module
#
# SQLiteベースの検索APIサーバー用EC2インフラストラクチャ
# OpenSearch Serviceの代替として、低コストで検索機能を提供
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

variable "domain_name" {
  description = "ベースドメイン名（例: nostr.nisshiee.org）"
  type        = string
}

variable "zone_id" {
  description = "Route 53ホストゾーンID"
  type        = string
}

# ------------------------------------------------------------------------------
# Data Sources
# ------------------------------------------------------------------------------

# デフォルトVPCを参照
# 本プロジェクトの他のAWSリソース（Lambda、DynamoDB、OpenSearch等）はすべて
# パブリックエンドポイントを使用しており、VPCを明示的に管理していない。
# EC2はVPCが必須だが、シンプルな単一インスタンス構成のため、
# 新規VPC作成による複雑さを避けてデフォルトVPCを使用する。
data "aws_vpc" "default" {
  default = true
}

# デフォルトVPCのパブリックサブネットを取得
# パブリックサブネットは map_public_ip_on_launch が true のサブネット
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
# Task 1.1: セキュリティグループとネットワーク設定
#
# 要件:
# - HTTPS（ポート443）のインバウンドを許可
# - HTTP（ポート80、Let's Encrypt ACME HTTP-01チャレンジ用）のインバウンドを許可
# - アウトバウンドは全許可（Let's Encrypt、SSM通信用）
#
# Requirements: 1.1, 3.3
# ------------------------------------------------------------------------------

resource "aws_security_group" "ec2_search" {
  name        = "nostr-relay-ec2-search"
  description = "SQLite検索APIサーバー用セキュリティグループ"
  vpc_id      = data.aws_vpc.default.id

  # HTTPS（ポート443）のインバウンドを許可
  # Lambda関数からのHTTPS通信を受け付ける
  ingress {
    description = "HTTPS from anywhere"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # HTTP（ポート80）のインバウンドを許可
  # Let's Encrypt ACME HTTP-01チャレンジ用
  # Caddyが自動でTLS証明書を取得・更新するために必要
  ingress {
    description = "HTTP for ACME HTTP-01 challenge"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # アウトバウンドは全許可
  # - Let's Encrypt: ACME証明書取得・更新
  # - SSM: Systems Manager Agent通信
  # - Parameter Store: APIトークン取得
  # - S3: バイナリダウンロード
  egress {
    description = "Allow all outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "nostr-relay-ec2-search"
  }
}

# ------------------------------------------------------------------------------
# Outputs
# ------------------------------------------------------------------------------

output "security_group_id" {
  description = "EC2検索サーバー用セキュリティグループID"
  value       = aws_security_group.ec2_search.id
}

output "vpc_id" {
  description = "使用するVPC ID"
  value       = data.aws_vpc.default.id
}

output "public_subnet_ids" {
  description = "パブリックサブネットIDのリスト"
  value       = data.aws_subnets.public.ids
}
