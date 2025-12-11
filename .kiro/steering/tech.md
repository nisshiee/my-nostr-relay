# Technology Stack

## Architecture

サーバーレスアーキテクチャを採用。CloudFront + Lambda@Edgeでプロトコルルーティングを行い、WebSocketはAPI Gateway v2、HTTP (NIP-11)はLambda Function URLで処理。OpenSearchでREQクエリを高速処理。

```
Client --> CloudFront --> Lambda@Edge (Router)
                              |
              +---------------+---------------+
              |                               |
         WebSocket                          HTTP
              |                               |
      API Gateway v2                 Lambda Function URL
              |                               |
       Lambda (Rust)                   Lambda (Rust)
              |                          NIP-11 Info
         DynamoDB
              |
      DynamoDB Streams
              |
       Lambda (Indexer)
              |
    +---------+---------+
    |                   |
OpenSearch         SQLite API
(Primary)          (EC2 t4g.nano)
```

### EC2 SQLite検索API (`services/sqlite-api/`)

SQLiteベースの軽量検索バックエンド。OpenSearchの代替として、コスト効率の高い検索機能を提供。

```
Internet --> Route53 --> EC2 (t4g.nano)
                              |
                           Caddy (TLS)
                              |
                         sqlite-api
                              |
                          SQLite DB
```

## Core Technologies

### Relay Service (`services/relay/`)
- **Language**: Rust (Edition 2024)
- **Runtime**: AWS Lambda (provided.al2023)
- **Architecture**: ARM64 (Graviton2)
- **Async**: tokio (full features)
- **Serialization**: serde_json

### SQLite API Service (`services/sqlite-api/`)
- **Language**: Rust (Edition 2024)
- **Runtime**: EC2 (Amazon Linux 2023)
- **Architecture**: ARM64 (Graviton2, t4g.nano)
- **Framework**: axum 0.8 (HTTPサーバー)
- **Database**: SQLite (rusqlite with bundled)
- **Connection Pool**: deadpool-sqlite
- **TLS**: Caddy (Let's Encrypt自動証明書)
- **Process Manager**: systemd

### Web Frontend (`apps/web/`)
- **Framework**: Next.js 16
- **UI Library**: React 19
- **Styling**: Tailwind CSS 4
  - `@tailwindcss/typography` - ポリシーページのタイポグラフィ
- **Language**: TypeScript 5

### Infrastructure (`terraform/`)
- **IaC**: Terraform
- **Cloud**: AWS (Lambda, API Gateway v2, CloudFront, Lambda@Edge, Route53, ACM, DynamoDB, OpenSearch Service, CloudWatch Logs)
- **Database**: DynamoDB (Events, Connections, Subscriptions)
- **Search**: OpenSearch Service (REQクエリ処理、DynamoDB Streamsからインデックス)
- **CDN**: CloudFront + Lambda@Edge (プロトコルルーティング)
- **Logging**: CloudWatch Logs (90日保存、法的対処・不正利用防止)
- **Frontend Hosting**: Vercel

## Key Libraries

### Rust (Relay)
- `lambda_runtime` - AWS Lambda Rust runtime (WebSocket系、DynamoDB Streams)
- `lambda_http` - AWS Lambda HTTP runtime (NIP-11)
- `nostr` - Nostrプロトコル型定義・署名検証・フィルター評価
- `aws-sdk-dynamodb` - DynamoDB操作
- `aws-sdk-apigatewaymanagement` - WebSocketメッセージ送信
- `aws-config` - AWS SDK認証・設定
- `opensearch` - OpenSearchクライアント (AWS認証対応)
- `aws_lambda_events` - Lambda イベント型定義 (DynamoDB Streams等)
- `tokio` - 非同期ランタイム
- `serde_json` - JSON処理
- `thiserror` - エラー型定義
- `tracing` / `tracing-subscriber` - 構造化ログ
- `async-trait` - 非同期トレイトサポート

### TypeScript (Web)
- `next` - SSR/SSGフレームワーク
- `react` / `react-dom` - UIライブラリ
- `tailwindcss` - ユーティリティファーストCSS

## Development Standards

### Rust Code Quality
- Edition 2024の最新機能を活用
- Lambda関数は個別バイナリとしてビルド (`src/bin/`)
- cargo-lambdaでARM64向けクロスコンパイル

### TypeScript Code Quality
- ESLint + Next.js推奨設定
- 型安全性を重視

### Infrastructure
- Terraformモジュールパターンで責務分離
- S3バックエンドで状態管理

## Development Environment

### Required Tools
- Rust toolchain (Edition 2024対応)
- cargo-lambda (Lambda向けビルド)
- zig (クロスコンパイル用Cコンパイラ)
- cargo-zigbuild (ARM64 Linuxクロスコンパイル)
- Node.js 20+
- Terraform
- direnv (.envrc による環境変数管理)
- aws-vault (AWS認証情報管理、プロファイル名: `nostr-relay`)

### クロスコンパイル環境セットアップ
```bash
# macOSでARM64 Linux向けクロスコンパイル環境を構築
brew install zig
cargo install cargo-zigbuild
rustup target add aarch64-unknown-linux-gnu
```

### Common Commands

```bash
# Relay Build (ARM64 for Lambda)
cd services/relay && cargo lambda build --release --arm64

# SQLite API Build (ARM64 for EC2)
cd services/sqlite-api && cargo zigbuild --release --target aarch64-unknown-linux-gnu

# SQLite API Deploy (S3経由)
aws-vault exec nostr-relay -- aws s3 cp \
  services/sqlite-api/target/aarch64-unknown-linux-gnu/release/sqlite-api \
  s3://nostr-relay-binary-<account-id>/sqlite-api/sqlite-api

# SQLite API Update (バイナリ更新・トークン更新・サービス再起動)
aws-vault exec nostr-relay -- aws ssm send-command \
  --document-name nostr-relay-ec2-search-update-binary \
  --targets "Key=tag:Name,Values=nostr-relay-ec2-search"

# EC2インスタンス再作成後の初期セットアップ
# 注意: terraform applyでEC2が再作成された場合、user_dataは環境構築のみ行い、
# バイナリとAPIトークンのセットアップは行わない。以下を手動実行する必要がある:
# 1. user_data完了を待つ（約2分）
# 2. SSM Documentを実行
aws-vault exec nostr-relay -- aws ssm send-command \
  --document-name nostr-relay-ec2-search-update-binary \
  --targets "Key=tag:Name,Values=nostr-relay-ec2-search"

# SQLite API Logs (EC2 journalctl経由)
# 1. コマンド送信
COMMAND_ID=$(aws-vault exec nostr-relay -- aws ssm send-command \
  --instance-ids <instance-id> \
  --document-name "AWS-RunShellScript" \
  --parameters commands="journalctl -u nostr-api -n 100 --no-pager" \
  --query 'Command.CommandId' --output text)
# 2. 結果取得
aws-vault exec nostr-relay -- aws ssm get-command-invocation \
  --command-id $COMMAND_ID \
  --instance-id <instance-id> \
  --query 'StandardOutputContent' --output text

# Web Dev
cd apps/web && npm run dev

# Infrastructure (aws-vault経由でAWS認証)
cd terraform && aws-vault exec nostr-relay -- terraform plan
cd terraform && aws-vault exec nostr-relay -- terraform apply
```

## Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| Rust for Relay | メモリ安全性、高性能、Lambda cold start最適化 |
| ARM64 (Graviton2) | x86_64比で20%コスト削減、優れた性能/電力効率 |
| cargo-zigbuild | QEMUより高速なクロスコンパイル、Docker不要、LLVMベースで最適化品質維持 |
| EC2 for SQLite API | SQLiteのファイルベース特性上、EBSボリュームが必要。t4g.nanoで低コスト運用 |
| rusqlite bundled | システムSQLiteに依存せず、クロスコンパイル容易 |
| Caddy | Let's Encrypt自動TLS、設定シンプル、リバースプロキシ |
| Serverless WebSocket | API Gateway v2でWebSocket接続管理、スケーラブル |
| CloudFront + Lambda@Edge | 単一ドメインでWebSocket/HTTP両対応、エッジでのプロトコルルーティング |
| DynamoDB | サーバーレス、従量課金、GSIによる柔軟なクエリパターン |
| OpenSearch Service | REQクエリの高速処理、DynamoDB Streams連携でリアルタイムインデックス |
| DynamoDB Streams + Lambda | イベント変更をOpenSearchに非同期インデックス、疎結合アーキテクチャ |
| nostr crate活用 | プロトコル型定義・署名検証の再実装を回避、エコシステム準拠 |
| 3-Layer Architecture | Domain/Application/Infrastructure分離でテスト容易性・責務明確化 |
| Modular Terraform | domain/api/webで責務分離、再利用性向上 |
| 構造化ログ (tracing) | Lambda環境での可観測性向上、JSON形式ログ出力 |
| CloudWatch Logs 90日保存 | 法的対処・不正利用防止のためのアクセスログ保存（プライバシーポリシー準拠） |
| アクセスログ記録 | IPアドレス、User-Agent、リクエスト時刻、イベント種別を記録 |
| Vercel for Frontend | Next.js最適化ホスティング、GitHubとの連携 |
| Edition 2024 | 最新のRust機能を活用 |

## Domain Configuration

- **Web**: `nostr.nisshiee.org` (Vercel)
- **Relay**: `relay.nostr.nisshiee.org` (CloudFront + Lambda@Edge)
  - WebSocket: CloudFront -> API Gateway v2
  - HTTP (NIP-11): CloudFront -> Lambda Function URL

---
_Document standards and patterns, not every dependency_
