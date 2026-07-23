# Development Guidelines

## プロジェクト概要

Nostr Relay — EC2 (axum WebSocket) + CloudFront + DynamoDB で動作するパーソナルリレーサーバー。

### アーキテクチャ

```
Client --> CloudFront (SSL) --> EC2 (t4g.micro, port 3000)
                                  |
                               axum WebSocket + HTTP (NIP-11)
                                  |
                               DynamoDB (nostr_relay_events)
```

### ディレクトリ構成

- `services/relay/` — Rust (axum) リレーサーバー
- `apps/web/` — Next.js Webフロントエンド (Vercel)
- `terraform/` — インフラ定義 (EC2, CloudFront, DynamoDB, Route53, S3)
- `nips/` — Nostrプロトコル仕様 (submodule)
- `RELAY_NIPS.md` — Relay実装に関連するNIPの要約

### インフラ

- **AWS Account**: `426192960050`, profile: `nostr-relay`
- **EC2**: `i-0d0e9aa2b1922fa21` (t4g.micro, AL2023, ARM64)
- **EIP**: `18.182.116.56`
- **CloudFront**: `E1AMD7PAPLY003`
- **Domain**: `relay.nostr.nisshiee.org`
- **DynamoDB**: `nostr_relay_events` (provisioned RCU=5, WCU=5)
- **S3**: `nostr-relay-binary-426192960050` (バイナリ配布)
- **SSM Document**: `nostr-relay-ec2-relay-v2-deploy`
- **Frontend**: `nostr.nisshiee.org` (Vercel)

## コーディング規約

- Rustコード修正後は必ず `cargo clippy --all-targets --all-features` を実行し、警告がなくなるまで修正すること
- `cargo test` も合わせて実行し、テストがパスすることを確認すること
- コードのコメント（`///` ドキュメントコメント、`//` 通常コメント）は日本語で記述すること
- コミットメッセージは日本語で記述すること
- Pull Requestのタイトル・本文は日本語で記述すること

### Rust コーディング規約

- Rust toolchain は `services/relay/rust-toolchain.toml` で固定する。ローカル開発・CI・本番バイナリのビルドはこの定義を共通で使用すること
- **モジュール構成**: `store/mod.rs` 方式ではなく `store.rs` + `store/` ディレクトリ方式を使うこと（Rust 2018+ スタイル）
  - ✅ `src/store.rs` + `src/store/in_memory.rs` + `src/store/dynamo.rs`
  - ❌ `src/store/mod.rs` + `src/store/in_memory.rs` + `src/store/dynamo.rs`

## ビルド・デプロイ

### リレーサーバー (ARM64 for EC2)

```bash
# `rust-toolchain.toml` の固定バージョンが自動で選択される
cd services/relay
cargo build --release --target aarch64-unknown-linux-musl --features dynamo

# デプロイ（S3経由 + SSM Document）
# バイナリのアップロード
aws-vault exec nostr-relay -- aws s3 cp \
  target/aarch64-unknown-linux-musl/release/relay \
  s3://nostr-relay-binary-426192960050/relay-v2/relay

# envファイルのアップロード（deploy/relay-v2.env をgitで管理）
aws-vault exec nostr-relay -- aws s3 cp \
  deploy/relay-v2.env \
  s3://nostr-relay-binary-426192960050/relay-v2/env

# SSM Documentでデプロイ（envとバイナリの差分チェック付き、冪等）
aws-vault exec nostr-relay -- aws ssm send-command \
  --document-name nostr-relay-ec2-relay-v2-deploy \
  --targets "Key=tag:Name,Values=nostr-relay-ec2-relay-v2"
```

> **Note:** 環境変数は `deploy/relay-v2.env` でgit管理されています。変更はこのファイルを編集し、S3にアップロード後、SSM Documentを実行してください。
> 本番EC2にはRust toolchainをインストールせず、CIでビルドしたバイナリのみを配布します。

### Webフロントエンド

```bash
cd apps/web && npm run dev
```

### Terraform

```bash
cd terraform
aws-vault exec nostr-relay -- terraform plan
aws-vault exec nostr-relay -- terraform apply
```

## プロトコル参照

Nostrプロトコル仕様は `nips/` サブモジュール（公式リポジトリ）を参照。
Relay実装に関連するNIPの要約は `RELAY_NIPS.md` に記載。
