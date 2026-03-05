#!/bin/sh
# ------------------------------------------------------------------------------
# EC2 Relay v2 User Data Script (Alpine Linux)
#
# 1. AWS CLIのインストール
# 2. nostr-relay専用ユーザーの作成
# 3. バイナリ格納ディレクトリの作成
# 4. deploy用ユーザーの作成とSSH公開鍵の設定
# 5. doas設定（deployユーザーのサービス制御用）
# 6. プレースホルダー環境変数ファイルの作成
# 7. OpenRCサービスファイルの配置と有効化
# 8. S3からバイナリとenvファイルを取得して初回デプロイ
# ------------------------------------------------------------------------------

set -eu

# ログ出力設定
exec > /var/log/user-data.log 2>&1
echo "User Data script started at $(date)"

# ------------------------------------------------------------------------------
# パッケージインストール
# ------------------------------------------------------------------------------
echo "Installing packages..."
apk add --no-cache aws-cli doas

# ------------------------------------------------------------------------------
# 専用ユーザーの作成
# ------------------------------------------------------------------------------
echo "Creating nostr-relay user..."
addgroup -S nostr-relay 2>/dev/null || true
adduser -S -G nostr-relay -h /var/lib/nostr-relay -s /sbin/nologin -D nostr-relay 2>/dev/null || true

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
# deploy用ユーザーの作成とSSH公開鍵の設定
# ------------------------------------------------------------------------------
echo "Creating deploy user..."
adduser -D -s /bin/sh deploy 2>/dev/null || true

mkdir -p /home/deploy/.ssh
chmod 700 /home/deploy/.ssh

cat > /home/deploy/.ssh/authorized_keys <<'EOF'
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIATilStMqTcyneQN8jUlJ+GWN6/geRhADfWul5i1bBsO github-actions-deploy@nostr-relay
EOF

chmod 600 /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh

# ------------------------------------------------------------------------------
# SSH強化設定
# ------------------------------------------------------------------------------
echo "Hardening SSH configuration..."
cat >> /etc/ssh/sshd_config <<'SSHEOF'

# セキュリティ強化設定
PasswordAuthentication no
PermitRootLogin no
SSHEOF

rc-service sshd restart

# ------------------------------------------------------------------------------
# デプロイスクリプトの配置
# ------------------------------------------------------------------------------
echo "Creating deploy script..."
cat > /usr/local/bin/nostr-relay-deploy.sh <<'DEPLOYSCRIPT'
#!/bin/sh
set -eu
echo "=== Deploy started at $(date) ==="

# IMDSv2からリージョンを取得
TOKEN=$(wget -q -O - --header "X-aws-ec2-metadata-token-ttl-seconds: 21600" --method PUT http://169.254.169.254/latest/api/token)
REGION=$(wget -q -O - --header "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)
export AWS_DEFAULT_REGION="$REGION"

echo "Deploying binary..."
aws s3 cp s3://nostr-relay-binary-426192960050/relay-v2/relay /opt/nostr-relay-v2/relay --quiet
chown nostr-relay:nostr-relay /opt/nostr-relay-v2/relay
chmod 755 /opt/nostr-relay-v2/relay

echo "Deploying env..."
aws s3 cp s3://nostr-relay-binary-426192960050/relay-v2/env /etc/nostr-relay-v2/env --quiet
chown nostr-relay:nostr-relay /etc/nostr-relay-v2/env
chmod 600 /etc/nostr-relay-v2/env

echo "Restarting service..."
rc-service nostr-relay-v2 restart
echo "=== Deploy completed at $(date) ==="
rc-service nostr-relay-v2 status || true
DEPLOYSCRIPT

chmod 755 /usr/local/bin/nostr-relay-deploy.sh

# ------------------------------------------------------------------------------
# doas設定（deployユーザーにデプロイスクリプトの実行を許可）
# ------------------------------------------------------------------------------
echo "Configuring doas for deploy user..."
cat > /etc/doas.d/deploy.conf <<'EOF'
# deployユーザーにデプロイスクリプトの実行を許可
permit nopass deploy cmd /usr/local/bin/nostr-relay-deploy.sh
EOF

chmod 600 /etc/doas.d/deploy.conf

# ------------------------------------------------------------------------------
# 環境変数ファイル（プレースホルダー）
# 初回デプロイでS3から上書きされる
# ------------------------------------------------------------------------------
echo "Creating placeholder environment file..."
cat > /etc/nostr-relay-v2/env <<'EOF'
# プレースホルダー - 初回デプロイでS3から上書きされます
RUST_LOG=info
EOF

chown nostr-relay:nostr-relay /etc/nostr-relay-v2/env
chmod 600 /etc/nostr-relay-v2/env

# ------------------------------------------------------------------------------
# ラッパースクリプト（環境変数の読み込み用）
# ------------------------------------------------------------------------------
echo "Creating wrapper script..."
cat > /opt/nostr-relay-v2/run.sh <<'WRAPPER'
#!/bin/sh
set -a
. /etc/nostr-relay-v2/env
set +a
exec /opt/nostr-relay-v2/relay
WRAPPER

chmod 755 /opt/nostr-relay-v2/run.sh
chown nostr-relay:nostr-relay /opt/nostr-relay-v2/run.sh

# ------------------------------------------------------------------------------
# OpenRCサービスファイル
# ------------------------------------------------------------------------------
echo "Creating OpenRC service file..."
cat > /etc/init.d/nostr-relay-v2 <<'INITEOF'
#!/sbin/openrc-run

name="nostr-relay-v2"
description="Nostr Relay v2"
command="/opt/nostr-relay-v2/run.sh"
command_user="nostr-relay:nostr-relay"
command_background=true
pidfile="/run/${RC_SVCNAME}.pid"
output_log="/var/log/${RC_SVCNAME}.log"
error_log="/var/log/${RC_SVCNAME}.log"

depend() {
    need net
    after firewall
}
INITEOF

chmod 755 /etc/init.d/nostr-relay-v2

# ブート時自動起動を有効化
echo "Enabling service..."
rc-update add nostr-relay-v2 default

# ------------------------------------------------------------------------------
# 初回デプロイ: S3からバイナリとenvファイルを取得
# ------------------------------------------------------------------------------
echo "Starting initial deployment from S3..."

# IMDSv2からリージョンを取得
TOKEN=$(wget -q -O - --header "X-aws-ec2-metadata-token-ttl-seconds: 21600" --method PUT http://169.254.169.254/latest/api/token)
REGION=$(wget -q -O - --header "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)
export AWS_DEFAULT_REGION="$REGION"

echo "Detected region: $REGION"

# バイナリを取得
echo "Downloading relay binary from S3..."
aws s3 cp s3://nostr-relay-binary-426192960050/relay-v2/relay /opt/nostr-relay-v2/relay
chown nostr-relay:nostr-relay /opt/nostr-relay-v2/relay
chmod 755 /opt/nostr-relay-v2/relay

# envファイルを取得
echo "Downloading env file from S3..."
aws s3 cp s3://nostr-relay-binary-426192960050/relay-v2/env /etc/nostr-relay-v2/env
chown nostr-relay:nostr-relay /etc/nostr-relay-v2/env
chmod 600 /etc/nostr-relay-v2/env

# サービス起動
echo "Starting nostr-relay-v2 service..."
rc-service nostr-relay-v2 start

echo "========================================"
echo "User Data script completed at $(date)"
echo "========================================"
