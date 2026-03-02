#!/bin/bash
# ------------------------------------------------------------------------------
# EC2 Relay v2 User Data Script
#
# 1. nostr-relay専用ユーザーの作成
# 2. バイナリ格納ディレクトリの作成
# 3. 環境変数ファイルの作成
# 4. systemdサービスファイルの配置と有効化
#
# バイナリのダウンロードはSSM Documentで行う:
#   aws ssm send-command \
#     --document-name nostr-relay-ec2-relay-v2-update-binary \
#     --targets "Key=tag:Name,Values=nostr-relay-ec2-relay-v2"
# ------------------------------------------------------------------------------

set -euo pipefail

exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1
echo "User Data script started at $(date)"

# ------------------------------------------------------------------------------
# 専用ユーザーの作成
# ------------------------------------------------------------------------------
echo "Creating nostr-relay user..."
groupadd --system nostr-relay 2>/dev/null || true
useradd --system --gid nostr-relay --create-home --home-dir /var/lib/nostr-relay --shell /usr/sbin/nologin nostr-relay 2>/dev/null || true

# ------------------------------------------------------------------------------
# ディレクトリ作成
# ------------------------------------------------------------------------------
echo "Creating directories..."
mkdir -p /opt/nostr-relay-v2
chown nostr-relay:nostr-relay /opt/nostr-relay-v2

mkdir -p /etc/nostr-relay-v2
chown nostr-relay:nostr-relay /etc/nostr-relay-v2
chmod 700 /etc/nostr-relay-v2

# ------------------------------------------------------------------------------
# 環境変数ファイル
# ------------------------------------------------------------------------------
echo "Creating environment file..."
cat > /etc/nostr-relay-v2/env <<'EOF'
# relay-v2 環境変数
DYNAMODB_TABLE_NAME=${events_table_name}
RELAY_NAME=${relay_name}
RELAY_DESCRIPTION=${relay_description}
RELAY_PUBKEY=${relay_pubkey}
RELAY_CONTACT=${relay_contact}
RELAY_ICON=${relay_icon}
RELAY_BANNER=${relay_banner}
RELAY_PRIVACY_POLICY=${relay_privacy_policy}
RELAY_TERMS_OF_SERVICE=${relay_terms_of_service}
RELAY_POSTING_POLICY=${relay_posting_policy}
RUST_LOG=info
RUST_BACKTRACE=1
EOF

chown nostr-relay:nostr-relay /etc/nostr-relay-v2/env
chmod 600 /etc/nostr-relay-v2/env

# ------------------------------------------------------------------------------
# systemdサービスファイル
# ------------------------------------------------------------------------------
echo "Creating systemd service file..."
cat > /etc/systemd/system/nostr-relay-v2.service <<'EOF'
[Unit]
Description=Nostr Relay v2
Documentation=https://github.com/nisshiee/my-nostr-relay
After=network.target

[Service]
Type=simple
User=nostr-relay
Group=nostr-relay
WorkingDirectory=/opt/nostr-relay-v2
EnvironmentFile=/etc/nostr-relay-v2/env
ExecStart=/opt/nostr-relay-v2/relay
Restart=always
RestartSec=5

# セキュリティ設定
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true

# ログ設定
StandardOutput=journal
StandardError=journal
SyslogIdentifier=nostr-relay-v2

[Install]
WantedBy=multi-user.target
EOF

# ------------------------------------------------------------------------------
# サービスの有効化（起動はSSM Document実行後）
# ------------------------------------------------------------------------------
echo "Enabling service..."
systemctl daemon-reload
systemctl enable nostr-relay-v2

echo "========================================"
echo "User Data script completed at $(date)"
echo "========================================"
echo ""
echo "バイナリをデプロイするにはSSM Documentを実行してください:"
echo "  aws ssm send-command \\"
echo "    --document-name nostr-relay-ec2-relay-v2-update-binary \\"
echo "    --targets \"Key=tag:Name,Values=nostr-relay-ec2-relay-v2\""
