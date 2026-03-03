# ------------------------------------------------------------------------------
# SSM Document（デプロイ用）
#
# EC2インスタンス上のrelay-v2のenvファイルとバイナリを更新する
# S3からダウンロード → 配置 → サービス再起動
#
# 実行コマンド例:
#   aws ssm send-command \
#     --document-name "nostr-relay-ec2-relay-v2-deploy" \
#     --targets "Key=tag:Name,Values=nostr-relay-ec2-relay-v2"
# ------------------------------------------------------------------------------

resource "aws_ssm_document" "deploy" {
  name            = "nostr-relay-ec2-relay-v2-deploy"
  document_type   = "Command"
  document_format = "YAML"

  content = yamlencode({
    schemaVersion = "2.2"
    description   = "relay-v2のenvファイルとバイナリをS3からデプロイしてサービスを再起動する"
    parameters = {
      BinaryBucket = {
        type    = "String"
        default = var.binary_bucket
      }
      BinaryKey = {
        type    = "String"
        default = var.binary_key
      }
      EnvKey = {
        type    = "String"
        default = "relay-v2/env"
      }
    }
    mainSteps = [
      {
        action = "aws:runShellScript"
        name   = "deploy"
        inputs = {
          runCommand = [
            "#!/bin/bash",
            "set -euo pipefail",
            "",
            "BINARY_BUCKET='{{ BinaryBucket }}'",
            "BINARY_KEY='{{ BinaryKey }}'",
            "ENV_KEY='{{ EnvKey }}'",
            "AWS_DEFAULT_REGION='${data.aws_region.current.name}'",
            "export AWS_DEFAULT_REGION",
            "",
            "ENV_LOCAL_PATH='/etc/nostr-relay-v2/env'",
            "BINARY_LOCAL_PATH='/opt/nostr-relay-v2/relay'",
            "",
            "echo '=== Deploy started at '$(date)' ==='",
            "",
            "# --- envファイルのデプロイ ---",
            "echo 'Deploying env file...'",
            "if ! aws s3api head-object --bucket \"$BINARY_BUCKET\" --key \"$ENV_KEY\" >/dev/null 2>&1; then",
            "  echo 'ERROR: env file not found in S3 (s3://'\"$BINARY_BUCKET/$ENV_KEY\"')'",
            "  exit 1",
            "fi",
            "",
            "aws s3 cp \"s3://$BINARY_BUCKET/$ENV_KEY\" \"$ENV_LOCAL_PATH\"",
            "chown nostr-relay:nostr-relay \"$ENV_LOCAL_PATH\"",
            "chmod 600 \"$ENV_LOCAL_PATH\"",
            "echo 'env file deployed'",
            "",
            "# --- バイナリのデプロイ ---",
            "echo 'Deploying binary...'",
            "if ! aws s3api head-object --bucket \"$BINARY_BUCKET\" --key \"$BINARY_KEY\" >/dev/null 2>&1; then",
            "  echo 'ERROR: binary not found in S3 (s3://'\"$BINARY_BUCKET/$BINARY_KEY\"')'",
            "  exit 1",
            "fi",
            "",
            "aws s3 cp \"s3://$BINARY_BUCKET/$BINARY_KEY\" \"$BINARY_LOCAL_PATH\"",
            "chown nostr-relay:nostr-relay \"$BINARY_LOCAL_PATH\"",
            "chmod 755 \"$BINARY_LOCAL_PATH\"",
            "echo 'binary deployed'",
            "",
            "# --- サービス再起動 ---",
            "echo 'Restarting relay-v2 service...'",
            "systemctl restart nostr-relay-v2",
            "echo 'Service restarted'",
            "",
            "echo '=== Deploy completed at '$(date)' ==='",
            "systemctl status nostr-relay-v2 --no-pager || true"
          ]
        }
      }
    ]
  })

  tags = {
    Name = "nostr-relay-ec2-relay-v2-deploy"
  }
}

# ------------------------------------------------------------------------------
# Outputs
# ------------------------------------------------------------------------------

output "ssm_document_name" {
  value = aws_ssm_document.deploy.name
}
