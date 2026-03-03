# ------------------------------------------------------------------------------
# SSM Document（デプロイ用）
#
# EC2インスタンス上のrelay-v2のenvファイルとバイナリを更新する
# S3のETagとローカルファイルのmd5を比較し、差分がある場合のみダウンロード
# どちらか更新された場合のみサービスを再起動（冪等）
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
    description   = "relay-v2のenvファイルとバイナリを更新してサービスを再起動する（冪等）"
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
            "UPDATED=0",
            "",
            "echo '=== Deploy started at '$(date)' ==='",
            "",
            "# --- envファイルの更新チェック ---",
            "echo 'Checking env file...'",
            "S3_ENV_ETAG=$(aws s3api head-object --bucket \"$BINARY_BUCKET\" --key \"$ENV_KEY\" --query ETag --output text 2>/dev/null | tr -d '\"' || echo '')",
            "",
            "if [ -z \"$S3_ENV_ETAG\" ]; then",
            "  echo 'ERROR: env file not found in S3 (s3://'\"$BINARY_BUCKET/$ENV_KEY\"')'",
            "  exit 1",
            "fi",
            "",
            "if [ -f \"$ENV_LOCAL_PATH\" ]; then",
            "  LOCAL_ENV_MD5=$(md5sum \"$ENV_LOCAL_PATH\" | awk '{print $1}')",
            "else",
            "  echo 'Local env file not found, will download'",
            "  LOCAL_ENV_MD5='none'",
            "fi",
            "",
            "if [ \"$S3_ENV_ETAG\" != \"$LOCAL_ENV_MD5\" ]; then",
            "  echo 'Downloading env file from S3...'",
            "  aws s3 cp \"s3://$BINARY_BUCKET/$ENV_KEY\" \"$ENV_LOCAL_PATH\"",
            "  chown nostr-relay:nostr-relay \"$ENV_LOCAL_PATH\"",
            "  chmod 600 \"$ENV_LOCAL_PATH\"",
            "  UPDATED=1",
            "  echo 'env file updated'",
            "else",
            "  echo 'env file is up to date'",
            "fi",
            "",
            "# --- バイナリの更新チェック ---",
            "echo 'Checking binary...'",
            "S3_BINARY_ETAG=$(aws s3api head-object --bucket \"$BINARY_BUCKET\" --key \"$BINARY_KEY\" --query ETag --output text 2>/dev/null | tr -d '\"' || echo '')",
            "",
            "if [ -z \"$S3_BINARY_ETAG\" ]; then",
            "  echo 'ERROR: binary not found in S3 (s3://'\"$BINARY_BUCKET/$BINARY_KEY\"')'",
            "  exit 1",
            "fi",
            "",
            "if [ -f \"$BINARY_LOCAL_PATH\" ]; then",
            "  LOCAL_BINARY_MD5=$(md5sum \"$BINARY_LOCAL_PATH\" | awk '{print $1}')",
            "else",
            "  echo 'Local binary not found, will download'",
            "  LOCAL_BINARY_MD5='none'",
            "fi",
            "",
            "if [ \"$S3_BINARY_ETAG\" != \"$LOCAL_BINARY_MD5\" ]; then",
            "  echo 'Downloading binary from S3...'",
            "  aws s3 cp \"s3://$BINARY_BUCKET/$BINARY_KEY\" \"$BINARY_LOCAL_PATH\"",
            "  chown nostr-relay:nostr-relay \"$BINARY_LOCAL_PATH\"",
            "  chmod 755 \"$BINARY_LOCAL_PATH\"",
            "  UPDATED=1",
            "  echo 'binary updated'",
            "else",
            "  echo 'binary is up to date'",
            "fi",
            "",
            "# --- サービス再起動（更新があった場合のみ） ---",
            "if [ $UPDATED -eq 1 ]; then",
            "  echo 'Restarting relay-v2 service...'",
            "  systemctl restart nostr-relay-v2",
            "  echo 'Service restarted'",
            "else",
            "  echo 'No changes detected, skipping restart'",
            "fi",
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
