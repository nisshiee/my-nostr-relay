#!/bin/bash
# ------------------------------------------------------------------------------
# EC2 Search Server User Data Script
#
# このスクリプトはEC2インスタンス起動時に実行され、以下を構成する:
# 1. Caddyのインストールと設定（リバースプロキシ、TLS自動化）
# 2. SQLiteデータベース用ディレクトリの準備（スキーマはRustアプリが作成）
# 3. systemdサービスファイルの配置と有効化
#
# 注意: バイナリとAPIトークンのセットアップはこのスクリプトでは行わない。
# EC2インスタンス作成後、手動でSSM Documentを実行する必要がある:
#   aws ssm send-command \
#     --document-name nostr-relay-ec2-search-update-binary \
#     --targets "Key=tag:Name,Values=nostr-relay-ec2-search"
#
# Requirements: 1.5, 1.6, 1.7, 1.8, 1.9, 3.4
# ------------------------------------------------------------------------------

set -euo pipefail

# ログ設定
exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1
echo "User Data script started at $(date)"

# 変数（Terraformから注入）
DOMAIN="${domain}"
BINARY_NAME="${binary_name}"
DB_PATH="/var/lib/nostr/events.db"

# ------------------------------------------------------------------------------
# パッケージのインストール
# ------------------------------------------------------------------------------
echo "Installing packages..."
dnf update -y
dnf install -y sqlite

# ------------------------------------------------------------------------------
# Caddyのインストール
# Caddyは自動でLet's EncryptからTLS証明書を取得・更新する
# 注: Amazon Linux 2023はCaddy COPRリポジトリをサポートしていないため、
#     GitHub Releasesから静的バイナリを直接ダウンロードする
# 参考: https://caddyserver.com/docs/install#static-binaries
# ------------------------------------------------------------------------------
echo "Installing Caddy..."

# Caddyの最新バージョンを取得してダウンロード
CADDY_VERSION=$(curl -s https://api.github.com/repos/caddyserver/caddy/releases/latest | grep '"tag_name":' | sed -E 's/.*"v([^"]+)".*/\1/')
echo "Installing Caddy version: $CADDY_VERSION"

curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_$${CADDY_VERSION}_linux_arm64.tar.gz" -o /tmp/caddy.tar.gz
tar -xzf /tmp/caddy.tar.gz -C /tmp
mv /tmp/caddy /usr/bin/caddy
chmod 755 /usr/bin/caddy
rm -f /tmp/caddy.tar.gz /tmp/LICENSE /tmp/README.md

# caddyユーザーとグループを作成
groupadd --system caddy 2>/dev/null || true
useradd --system --gid caddy --create-home --home-dir /var/lib/caddy --shell /usr/sbin/nologin caddy 2>/dev/null || true

# Caddy用systemdサービスファイルを作成
cat > /etc/systemd/system/caddy.service <<'CADDYEOF'
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
LimitNPROC=512
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
CADDYEOF

# Caddy設定ディレクトリを作成
mkdir -p /etc/caddy

# ------------------------------------------------------------------------------
# Caddyの設定
# リバースプロキシとしてHTTPS（443）でリッスンし、
# 内部のHTTP APIサーバー（localhost:8080）に転送する
# ------------------------------------------------------------------------------
echo "Configuring Caddy..."

cat > /etc/caddy/Caddyfile <<'EOF'
# Caddyfile - SQLite検索APIサーバー用リバースプロキシ設定
#
# - HTTPS（443）でリッスン（Let's EncryptでTLS証明書を自動取得）
# - HTTP（80）はACME HTTP-01チャレンジのみ許可
# - 全リクエストをlocalhost:8080に転送
${domain} {
    reverse_proxy localhost:8080

    # 構造化ログ出力
    log {
        output file /var/log/caddy/access.log {
            roll_size 10mb
            roll_keep 5
        }
        format json
    }
}
EOF

# ログディレクトリを作成
mkdir -p /var/log/caddy
chown caddy:caddy /var/log/caddy

# ------------------------------------------------------------------------------
# nostr-api専用ユーザーの作成
# セキュリティ上、rootではなく専用ユーザーでサービスを実行する
# ------------------------------------------------------------------------------
echo "Creating nostr-api user..."
groupadd --system nostr-api 2>/dev/null || true
useradd --system --gid nostr-api --create-home --home-dir /var/lib/nostr --shell /usr/sbin/nologin nostr-api 2>/dev/null || true

# ------------------------------------------------------------------------------
# SQLiteデータベース用ディレクトリの準備
# スキーマ作成はRustアプリ（store.rs）が起動時に行う
# ここではディレクトリと権限設定のみ
# ------------------------------------------------------------------------------
echo "Preparing SQLite database directory..."

# ディレクトリ作成（nostr-apiユーザーが所有）
mkdir -p /var/lib/nostr
chown nostr-api:nostr-api /var/lib/nostr
chmod 750 /var/lib/nostr

echo "SQLite database directory prepared at /var/lib/nostr"

# ------------------------------------------------------------------------------
# 環境変数ファイルの作成（スケルトン）
# API_TOKENはSSM Documentで設定される
# ------------------------------------------------------------------------------
echo "Creating environment file skeleton..."

# ディレクトリを先に作成（nostr-apiユーザーのみアクセス可能）
mkdir -p /etc/nostr-api
chown nostr-api:nostr-api /etc/nostr-api
chmod 700 /etc/nostr-api

cat > /etc/nostr-api/env <<EOF
# Nostr API サーバー環境変数
# API_TOKENはSSM Documentによって設定される
API_TOKEN=PLACEHOLDER
DB_PATH=$DB_PATH
RUST_LOG=info
# パニック時にバックトレースを出力
RUST_BACKTRACE=1
EOF

chown nostr-api:nostr-api /etc/nostr-api/env
chmod 600 /etc/nostr-api/env

# ------------------------------------------------------------------------------
# バイナリ格納ディレクトリの作成
# バイナリ自体はSSM Documentでダウンロードする
# ------------------------------------------------------------------------------
echo "Creating binary directory..."

mkdir -p /opt/nostr-api
chown nostr-api:nostr-api /opt/nostr-api

# ------------------------------------------------------------------------------
# systemdサービスファイルの作成
# ------------------------------------------------------------------------------
echo "Creating systemd service file..."

cat > /etc/systemd/system/nostr-api.service <<EOF
[Unit]
Description=Nostr SQLite API Server
Documentation=https://github.com/nisshiee/my-nostr-relay
After=network.target

[Service]
Type=simple
User=nostr-api
Group=nostr-api
WorkingDirectory=/opt/nostr-api
EnvironmentFile=/etc/nostr-api/env
ExecStart=/opt/nostr-api/$BINARY_NAME
Restart=always
RestartSec=5

# セキュリティ設定
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/nostr

# ログ設定
StandardOutput=journal
StandardError=journal
SyslogIdentifier=nostr-api

[Install]
WantedBy=multi-user.target
EOF

# ------------------------------------------------------------------------------
# サービスの有効化
# nostr-apiはSSM Document実行後に起動するため、ここでは有効化のみ
# ------------------------------------------------------------------------------
echo "Enabling services..."

# systemdデーモンをリロード
systemctl daemon-reload

# Caddyを有効化・起動
systemctl enable caddy
systemctl start caddy

# nostr-apiサービスを有効化（起動はSSM Document実行後）
systemctl enable nostr-api

# ------------------------------------------------------------------------------
# 完了
# ------------------------------------------------------------------------------
echo "Verifying Caddy service..."
systemctl status caddy --no-pager || true

echo ""
echo "========================================"
echo "User Data script completed at $(date)"
echo "========================================"
echo ""
echo "注意: APIサーバーを起動するには、SSM Documentを手動実行してください:"
echo "  aws ssm send-command \\"
echo "    --document-name nostr-relay-ec2-search-update-binary \\"
echo "    --targets \"Key=tag:Name,Values=nostr-relay-ec2-search\""
echo ""
