#!/bin/bash
# ------------------------------------------------------------------------------
# EC2 Search Server User Data Script
#
# このスクリプトはEC2インスタンス起動時に実行され、以下を構成する:
# 1. Caddyのインストールと設定（リバースプロキシ、TLS自動化）
# 2. SQLiteデータベースの初期化（WALモード、スキーマ作成）
# 3. systemdサービスファイルの配置と有効化
# 4. S3からバイナリをダウンロード
# 5. Parameter StoreからAPIトークンを取得し環境変数に設定
#
# Requirements: 1.5, 1.6, 1.7, 1.8, 1.9, 3.4
# ------------------------------------------------------------------------------

set -euo pipefail

# ログ設定
exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1
echo "User Data script started at $(date)"

# 変数（Terraformから注入）
DOMAIN="${domain}"
BINARY_BUCKET="${binary_bucket}"
BINARY_KEY="${binary_key}"
BINARY_NAME="${binary_name}"
PARAMETER_STORE_PATH="${parameter_store_path}"
AWS_REGION="${aws_region}"
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
# SQLiteデータベースの初期化
# /var/lib/nostr/events.dbにWALモードで初期化
# ------------------------------------------------------------------------------
echo "Initializing SQLite database..."

# ディレクトリ作成（nostr-apiユーザーが所有）
mkdir -p /var/lib/nostr
chown nostr-api:nostr-api /var/lib/nostr
chmod 750 /var/lib/nostr

# データベース初期化（スキーマ作成）
sqlite3 "$DB_PATH" <<'SQLEOF'
-- WALモード有効化
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

-- イベントテーブル
-- 完全なNostrイベントを保存
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,           -- 64文字hex (イベントID)
    pubkey TEXT NOT NULL,          -- 64文字hex (公開鍵)
    kind INTEGER NOT NULL,         -- イベント種別
    created_at INTEGER NOT NULL,   -- UNIXタイムスタンプ
    event_json TEXT NOT NULL       -- 完全なイベントJSON
);

-- タグテーブル（正規化）
-- 検索用にタグを別テーブルで管理
CREATE TABLE IF NOT EXISTS event_tags (
    event_id TEXT NOT NULL,        -- eventsテーブルへのFK
    tag_name TEXT NOT NULL,        -- タグ名 ('e', 'p', 'd', 'a', 't')
    tag_value TEXT NOT NULL,       -- タグ値
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

-- インデックス定義
-- 検索パフォーマンスを最適化
CREATE INDEX IF NOT EXISTS idx_events_pubkey ON events(pubkey);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_pubkey_kind ON events(pubkey, kind);
CREATE INDEX IF NOT EXISTS idx_event_tags_name_value ON event_tags(tag_name, tag_value);
CREATE INDEX IF NOT EXISTS idx_event_tags_event_id ON event_tags(event_id);
SQLEOF

# データベースファイルの権限設定
# nostr-apiユーザーからの読み書きを許可
chown nostr-api:nostr-api "$DB_PATH"
chmod 640 "$DB_PATH"
# WAL関連ファイルも権限設定（存在する場合）
[ -f "$DB_PATH-wal" ] && chown nostr-api:nostr-api "$DB_PATH-wal" && chmod 640 "$DB_PATH-wal"
[ -f "$DB_PATH-shm" ] && chown nostr-api:nostr-api "$DB_PATH-shm" && chmod 640 "$DB_PATH-shm"

echo "SQLite database initialized at $DB_PATH"

# ------------------------------------------------------------------------------
# Parameter StoreからAPIトークンを取得
# ------------------------------------------------------------------------------
echo "Fetching API token from Parameter Store..."

API_TOKEN=$(aws ssm get-parameter \
    --name "$PARAMETER_STORE_PATH" \
    --with-decryption \
    --query 'Parameter.Value' \
    --output text \
    --region "$AWS_REGION")

if [ -z "$API_TOKEN" ]; then
    echo "ERROR: Failed to fetch API token from Parameter Store"
    exit 1
fi

echo "API token fetched successfully"

# ------------------------------------------------------------------------------
# 環境変数ファイルの作成
# systemdサービスから読み込む
# ------------------------------------------------------------------------------
echo "Creating environment file..."

# ディレクトリを先に作成（nostr-apiユーザーのみアクセス可能）
mkdir -p /etc/nostr-api
chown nostr-api:nostr-api /etc/nostr-api
chmod 700 /etc/nostr-api

cat > /etc/nostr-api/env <<EOF
# Nostr API サーバー環境変数
# この値はParameter Store ($PARAMETER_STORE_PATH) から取得
API_TOKEN=$API_TOKEN
DB_PATH=$DB_PATH
RUST_LOG=info
EOF

chown nostr-api:nostr-api /etc/nostr-api/env
chmod 600 /etc/nostr-api/env

# ------------------------------------------------------------------------------
# S3からバイナリをダウンロード
# ------------------------------------------------------------------------------
echo "Downloading binary from S3..."

mkdir -p /opt/nostr-api
chown nostr-api:nostr-api /opt/nostr-api
aws s3 cp "s3://$BINARY_BUCKET/$BINARY_KEY" "/opt/nostr-api/$BINARY_NAME" --region "$AWS_REGION"
chown nostr-api:nostr-api "/opt/nostr-api/$BINARY_NAME"
chmod 755 "/opt/nostr-api/$BINARY_NAME"

echo "Binary downloaded to /opt/nostr-api/$BINARY_NAME"

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
# バイナリ更新用スクリプトの作成
# SSM Run Commandで実行可能
# ------------------------------------------------------------------------------
echo "Creating update script..."

cat > /opt/nostr-api/update.sh <<'UPDATEEOF'
#!/bin/bash
# バイナリ更新スクリプト
# SSM Run Commandで実行: aws ssm send-command --document-name AWS-RunShellScript --parameters commands=["/opt/nostr-api/update.sh"]

set -euo pipefail

BINARY_BUCKET="${binary_bucket}"
BINARY_KEY="${binary_key}"
BINARY_NAME="${binary_name}"
AWS_REGION="${aws_region}"

echo "Stopping nostr-api service..."
systemctl stop nostr-api

echo "Downloading new binary from S3..."
aws s3 cp "s3://$BINARY_BUCKET/$BINARY_KEY" "/opt/nostr-api/$BINARY_NAME" --region "$AWS_REGION"
chown nostr-api:nostr-api "/opt/nostr-api/$BINARY_NAME"
chmod 755 "/opt/nostr-api/$BINARY_NAME"

echo "Starting nostr-api service..."
systemctl start nostr-api

echo "Update completed at $(date)"
systemctl status nostr-api
UPDATEEOF

chmod 755 /opt/nostr-api/update.sh

# ------------------------------------------------------------------------------
# サービスの有効化と起動
# ------------------------------------------------------------------------------
echo "Enabling and starting services..."

# systemdデーモンをリロード
systemctl daemon-reload

# Caddyを有効化・起動
systemctl enable caddy
systemctl start caddy

# nostr-apiサービスを有効化・起動
systemctl enable nostr-api
systemctl start nostr-api

# ------------------------------------------------------------------------------
# 完了確認
# ------------------------------------------------------------------------------
echo "Verifying services..."
systemctl status caddy --no-pager || true
systemctl status nostr-api --no-pager || true

echo "User Data script completed at $(date)"
echo "EC2 Search Server provisioning complete!"
