# ------------------------------------------------------------------------------
# SSM Document（バイナリ更新用）
#
# EC2インスタンス上のrelay-v2バイナリを更新するためのSSMドキュメント
# 実行コマンド例:
#   aws ssm send-command \
#     --document-name "nostr-relay-ec2-relay-v2-update-binary" \
#     --targets "Key=tag:Name,Values=nostr-relay-ec2-relay-v2"
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

output "ssm_document_name" {
  value = aws_ssm_document.update_binary.name
}
