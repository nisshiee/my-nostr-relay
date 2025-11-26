# Technology Stack

## Architecture

サーバーレスアーキテクチャを採用。WebSocket接続はAWS API Gateway v2で管理し、イベント処理はLambda関数で実行。

```
Client <--WebSocket--> API Gateway v2 <---> Lambda (Rust)
                              |
                         Route53 DNS
```

## Core Technologies

### Relay Service (`services/relay/`)
- **Language**: Rust (Edition 2024)
- **Runtime**: AWS Lambda (provided.al2023)
- **Async**: tokio (full features)
- **Serialization**: serde_json

### Web Frontend (`apps/web/`)
- **Framework**: Next.js 16
- **UI Library**: React 19
- **Styling**: Tailwind CSS 4
- **Language**: TypeScript 5

### Infrastructure (`terraform/`)
- **IaC**: Terraform
- **Cloud**: AWS (Lambda, API Gateway v2, Route53, ACM)
- **Frontend Hosting**: Vercel

## Key Libraries

### Rust (Relay)
- `lambda_runtime` - AWS Lambda Rust runtime
- `tokio` - 非同期ランタイム
- `serde_json` - JSON処理

### TypeScript (Web)
- `next` - SSR/SSGフレームワーク
- `react` / `react-dom` - UIライブラリ
- `tailwindcss` - ユーティリティファーストCSS

## Development Standards

### Rust Code Quality
- Edition 2024の最新機能を活用
- Lambda関数は個別バイナリとしてビルド (`src/bin/`)
- cargo-lambdaでクロスコンパイル

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
- Node.js 20+
- Terraform
- direnv (.envrc による環境変数管理)
- aws-vault (AWS認証情報管理、プロファイル名: `nostr-relay`)

### Common Commands

```bash
# Relay Build
cd services/relay && cargo lambda build --release

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
| Serverless WebSocket | API Gateway v2でWebSocket接続管理、スケーラブル |
| Modular Terraform | domain/api/webで責務分離、再利用性向上 |
| Vercel for Frontend | Next.js最適化ホスティング、GitHubとの連携 |
| Edition 2024 | 最新のRust機能を活用 |

## Domain Configuration

- **Web**: `nostr.nisshiee.org` (Vercel)
- **Relay**: `relay.nostr.nisshiee.org` (API Gateway WebSocket)

---
_Document standards and patterns, not every dependency_
