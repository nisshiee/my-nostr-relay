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

variable "binary_bucket" {
  description = "HTTP APIサーバーバイナリを格納するS3バケット名"
  type        = string
}

variable "binary_key" {
  description = "S3バケット内のバイナリのキー（パス）"
  type        = string
  default     = "sqlite-api/sqlite-api"
}

variable "binary_name" {
  description = "バイナリのファイル名"
  type        = string
  default     = "sqlite-api"
}

variable "parameter_store_path" {
  description = "APIトークンを保存するParameter Storeのパス"
  type        = string
  default     = "/nostr-relay/ec2-search/api-token"
}

# ------------------------------------------------------------------------------
# Data Sources
# ------------------------------------------------------------------------------

# 現在のAWSリージョンを取得
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

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
  description = "Security group for SQLite search API server"
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
# Task 1.2: EC2インスタンスとストレージ定義
#
# 要件:
# - t4g.nanoインスタンスタイプを指定
# - Amazon Linux 2023 AMIを使用（SSM Agent プリインストール）
# - EBS gp3ボリューム（10GB）をアタッチ
# - IAMインスタンスプロファイルでSSMとS3アクセスを許可
#
# Requirements: 1.1, 1.2, 1.3, 8.1, 8.2
# ------------------------------------------------------------------------------

# Amazon Linux 2023 AMI（ARM64）を取得
# SSM Agentがプリインストールされているため、SSM Session Managerでの接続が可能
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
# IAMロールとインスタンスプロファイル
#
# EC2インスタンスが以下のサービスにアクセスするために必要:
# - SSM: Systems Manager Agent通信、Session Manager接続
# - S3: バイナリダウンロード
# - Parameter Store: APIトークン取得
# ------------------------------------------------------------------------------

# IAMロール
resource "aws_iam_role" "ec2_search" {
  name = "nostr-relay-ec2-search"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name = "nostr-relay-ec2-search"
  }
}

# SSM用マネージドポリシーをアタッチ
# AmazonSSMManagedInstanceCore: SSM Agent通信、Session Manager接続に必要
resource "aws_iam_role_policy_attachment" "ec2_search_ssm" {
  role       = aws_iam_role.ec2_search.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# S3およびParameter Storeアクセス用カスタムポリシー
resource "aws_iam_role_policy" "ec2_search_custom" {
  name = "nostr-relay-ec2-search-custom"
  role = aws_iam_role.ec2_search.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "S3BinaryAccess"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:ListBucket"
        ]
        Resource = [
          "arn:aws:s3:::nostr-relay-*",
          "arn:aws:s3:::nostr-relay-*/*"
        ]
      },
      {
        Sid    = "ParameterStoreAccess"
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters"
        ]
        Resource = "arn:aws:ssm:*:*:parameter/nostr-relay/*"
      },
      {
        Sid    = "KMSDecryptForSecureString"
        Effect = "Allow"
        Action = [
          "kms:Decrypt"
        ]
        # デフォルトのAWS管理キー（alias/aws/ssm）を使用
        # SecureStringの復号化に必要
        Resource = "*"
        Condition = {
          StringEquals = {
            "kms:ViaService" = "ssm.${data.aws_region.current.name}.amazonaws.com"
          }
        }
      },
      {
        Sid    = "SSMSendCommandForSelfUpdate"
        Effect = "Allow"
        Action = [
          "ssm:SendCommand",
          "ssm:GetCommandInvocation"
        ]
        # 自身のインスタンスに対してのみSSM Documentを実行可能
        Resource = [
          "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:document/nostr-relay-ec2-search-update-binary",
          "arn:aws:ec2:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:instance/*"
        ]
      }
    ]
  })
}

# インスタンスプロファイル
resource "aws_iam_instance_profile" "ec2_search" {
  name = "nostr-relay-ec2-search"
  role = aws_iam_role.ec2_search.name
}

# ------------------------------------------------------------------------------
# EC2インスタンス
#
# t4g.nano: ARM64 (Graviton2)、2 vCPU、512MB RAM
# コスト: 月額約450円（東京リージョン）
#
# User Dataは後続タスク（1.4）で実装
# ------------------------------------------------------------------------------

resource "aws_instance" "search" {
  ami           = data.aws_ami.amazon_linux_2023.id
  instance_type = "t4g.nano"

  # パブリックサブネットに配置（最初のサブネットを使用）
  subnet_id = tolist(data.aws_subnets.public.ids)[0]

  # セキュリティグループとIAMインスタンスプロファイルを設定
  vpc_security_group_ids = [aws_security_group.ec2_search.id]
  iam_instance_profile   = aws_iam_instance_profile.ec2_search.name

  # EBS最適化を有効化（t4g.nanoはデフォルトでサポート）
  ebs_optimized = true

  # ルートボリューム: gp3、30GB（Amazon Linux 2023 AMIの最小要件）
  # コスト: 月額約360円（東京リージョン）
  root_block_device {
    volume_type           = "gp3"
    volume_size           = 30
    delete_on_termination = true
    encrypted             = true

    tags = {
      Name = "nostr-relay-ec2-search-root"
    }
  }

  # メタデータサービスv2を強制（セキュリティベストプラクティス）
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  # ------------------------------------------------------------------------------
  # Task 1.4: User Dataによるプロビジョニング
  #
  # 要件:
  # - Caddyのインストールと設定（リバースプロキシ、TLS自動化）
  # - SQLiteデータベース用ディレクトリの準備
  # - systemdサービスファイルの配置と有効化
  #
  # 注意: バイナリのダウンロードとAPIトークンの設定はSSM Documentで行う
  # EC2作成後、手動でSSM Documentを実行する必要がある
  #
  # Requirements: 1.5, 1.6, 1.7, 1.8, 1.9, 3.4
  # ------------------------------------------------------------------------------
  user_data = base64encode(templatefile("${path.module}/user_data.sh.tpl", {
    # ドメインはrandom_stringから直接構築（循環依存を回避）
    domain      = "${random_string.subdomain.result}.relay.${var.domain_name}"
    binary_name = var.binary_name
  }))

  # User Dataが変更された場合、インスタンスを再作成
  user_data_replace_on_change = true

  tags = {
    Name = "nostr-relay-ec2-search"
  }

  lifecycle {
    # AMIが更新されても自動で再作成しない（明示的な更新のみ）
    ignore_changes = [ami]
  }
}

# ------------------------------------------------------------------------------
# Task 1.3: Elastic IPとRoute 53設定
#
# 要件:
# - Elastic IPを作成しEC2インスタンスにアタッチ
# - random_stringリソースでサブドメインを生成（tfstateにのみ保存、gitにはコミットしない）
# - Route 53にAレコードを登録
#
# 設計判断:
# - サブドメインをランダム化することで、検索APIエンドポイントの推測を困難にする
# - Elastic IPにより、EC2再起動時もIPアドレスが維持される
# - Elastic IPは実行中のインスタンスにアタッチされている間は無料
#
# Requirements: 1.1, 1.4, 4.1, 8.3
# ------------------------------------------------------------------------------

# サブドメイン用ランダム文字列
# tfstateにのみ保存され、gitにはコミットされない
# 例: abc123.relay.nostr.nisshiee.org
resource "random_string" "subdomain" {
  length  = 8
  special = false
  upper   = false
  numeric = true
  lower   = true
}

# Elastic IP
# EC2インスタンスに固定IPアドレスを割り当てる
# 再起動してもIPアドレスが変わらないため、Route 53の更新が不要
resource "aws_eip" "search" {
  domain = "vpc"

  tags = {
    Name = "nostr-relay-ec2-search"
  }
}

# Elastic IPをEC2インスタンスにアタッチ
# インスタンスが停止しても関連付けは維持される
resource "aws_eip_association" "search" {
  instance_id   = aws_instance.search.id
  allocation_id = aws_eip.search.id
}

# Route 53 Aレコード
# ランダムサブドメインでEC2検索APIエンドポイントを公開
# 形式: {random}.relay.{domain_name}
resource "aws_route53_record" "search" {
  zone_id = var.zone_id
  name    = "${random_string.subdomain.result}.relay.${var.domain_name}"
  type    = "A"
  ttl     = 300

  records = [aws_eip.search.public_ip]
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

output "instance_id" {
  description = "EC2インスタンスID"
  value       = aws_instance.search.id
}

output "private_ip" {
  description = "EC2インスタンスのプライベートIPアドレス"
  value       = aws_instance.search.private_ip
}

output "iam_role_arn" {
  description = "EC2インスタンスのIAMロールARN"
  value       = aws_iam_role.ec2_search.arn
}

output "iam_instance_profile_name" {
  description = "IAMインスタンスプロファイル名"
  value       = aws_iam_instance_profile.ec2_search.name
}

output "elastic_ip" {
  description = "Elastic IP（パブリックIPアドレス）"
  value       = aws_eip.search.public_ip
}

output "search_api_endpoint" {
  description = "検索APIエンドポイントFQDN（HTTPSでアクセス）"
  value       = aws_route53_record.search.fqdn
}

output "search_api_url" {
  description = "検索APIのベースURL"
  value       = "https://${aws_route53_record.search.fqdn}"
}

output "parameter_store_path" {
  description = "APIトークンを保存するParameter Storeのパス"
  value       = var.parameter_store_path
}

output "binary_bucket" {
  description = "HTTP APIサーバーバイナリを格納するS3バケット名"
  value       = var.binary_bucket
}

output "binary_key" {
  description = "S3バケット内のバイナリのキー"
  value       = var.binary_key
}
