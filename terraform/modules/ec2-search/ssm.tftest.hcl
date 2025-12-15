# ------------------------------------------------------------------------------
# SSM Parameter Store テスト
#
# Task 1.5: APIトークンのParameter Store登録
#
# テスト内容:
# - SSM Parameter リソースが作成されること
# - SecureString タイプであること
# - 正しいパスに配置されること
# - Lambda IAM ポリシーが Parameter Store アクセス権限を持つこと
#
# Requirements: 3.5
# ------------------------------------------------------------------------------

# テスト用変数
variables {
  domain_name          = "test.example.com"
  zone_id              = "Z0000000000000"
  binary_bucket        = "test-bucket"
  binary_key           = "test/binary"
  binary_name          = "test-api"
  parameter_store_path = "/nostr-relay/ec2-search/api-token"
}

# モックプロバイダー
mock_provider "aws" {
  mock_data "aws_region" {
    defaults = {
      name = "ap-northeast-1"
    }
  }

  mock_data "aws_vpc" {
    defaults = {
      id         = "vpc-12345678"
      cidr_block = "10.0.0.0/16"
    }
  }

  mock_data "aws_subnets" {
    defaults = {
      ids = ["subnet-12345678"]
    }
  }

  mock_data "aws_ami" {
    defaults = {
      id           = "ami-12345678"
      architecture = "arm64"
    }
  }
}

mock_provider "random" {}

# SSM Parameter リソースのテスト
run "ssm_parameter_is_created" {
  command = plan

  assert {
    condition     = aws_ssm_parameter.api_token.name == var.parameter_store_path
    error_message = "SSM Parameter パスが正しくありません"
  }

  assert {
    condition     = aws_ssm_parameter.api_token.type == "SecureString"
    error_message = "SSM Parameter タイプは SecureString である必要があります"
  }

  assert {
    condition     = aws_ssm_parameter.api_token.tier == "Standard"
    error_message = "SSM Parameter ティアは Standard である必要があります"
  }
}

# Lambda IAM ポリシーのテスト
run "lambda_iam_policy_has_ssm_access" {
  command = plan

  assert {
    condition     = aws_iam_policy.lambda_ssm_access.name == "nostr-relay-lambda-ssm-access"
    error_message = "Lambda SSM アクセスポリシー名が正しくありません"
  }
}
