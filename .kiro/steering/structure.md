# Project Structure

## Organization Philosophy

**Monorepo with Service Separation**: アプリケーション層（apps）とバックエンドサービス層（services）を明確に分離。インフラストラクチャはTerraformモジュールパターンで管理。

## Directory Patterns

### Apps (`apps/`)
**Purpose**: フロントエンドアプリケーション
**Pattern**: 1アプリ = 1ディレクトリ
**Example**: `apps/web/` - Next.jsベースのWebフロントエンド

### Services (`services/`)
**Purpose**: バックエンドサービス（Lambda関数、EC2アプリ等）
**Pattern**: 1サービス = 1ディレクトリ、Cargoワークスペース対応
**Examples**:
- `services/relay/` - Nostrリレー実装 (Lambda)
- `services/sqlite-api/` - SQLite検索API (EC2)

### Terraform (`terraform/`)
**Purpose**: インフラストラクチャ定義
**Pattern**: ルートにメイン設定、`modules/`で責務分離

```
terraform/
  main.tf              # プロバイダー設定、モジュール呼び出し
  modules/
    domain/            # Route53, ACM証明書
    api/               # Lambda, API Gateway, CloudFront, Lambda@Edge
    web/               # Vercelプロジェクト
    ec2-search/        # EC2 SQLite検索API
      main.tf          # EC2インスタンス, Security Group, EIP, Route53
      s3.tf            # バイナリ配布用S3バケット, SSMドキュメント
      ssm.tf           # Parameter Store (APIトークン), IAMポリシー
      user_data.sh.tpl # EC2初期化スクリプト (Caddy, systemd)
    budget/            # AWS予算管理（コスト閾値超過時の自動停止・月初復旧）
```

### Protocol Reference (`nips/`)
**Purpose**: Nostrプロトコル仕様（公式リポジトリのsubmodule）
**Note**: 読み取り専用、編集不可

### Documentation (Root)
**Purpose**: プロジェクトドキュメント
**Files**:
- `RELAY_NIPS.md` - Relay実装に関連するNIPの要約
- `CLAUDE.md` - AI開発支援の設定

## Naming Conventions

### Directories
- **lowercase-hyphen**: `my-nostr-relay`, `apps/web`
- **Terraform modules**: 機能名（`domain`, `api`, `web`）

### Files
- **Rust**: snake_case (`connect.rs`, `lib.rs`)
- **TypeScript/React**: PascalCase for components, camelCase for utilities
- **Terraform**: `main.tf` 中心、必要に応じて分割

### Lambda Functions
- バイナリ名 = Lambda関数名のベース
- WebSocket系:
  - `connect.rs` -> `nostr_relay_connect`
  - `disconnect.rs` -> `nostr_relay_disconnect`
  - `default.rs` -> `nostr_relay_default`
- HTTP系:
  - `nip11_info.rs` -> `nostr_relay_nip11` (NIP-11リレー情報)
- DynamoDB Streams系:
  - `indexer.rs` -> `nostr_relay_indexer` (SQLite APIへのインデックス)
- 予算管理系:
  - `shutdown.rs` -> `nostr-relay-shutdown` (予算超過時サービス停止)
  - `recovery.rs` -> `nostr-relay-recovery` (月初自動復旧)
- 運用ツール系:
  - `sqlite_rebuilder.rs` (SQLiteインデックス再構築、CLI)

## Import Organization

### Rust
```rust
// 標準ライブラリ
use std::...;

// 外部クレート
use lambda_runtime::{...};
use serde_json::Value;

// 内部モジュール
use crate::...;
```

### TypeScript (Next.js)
```typescript
// External packages
import { ... } from 'next';
import { ... } from 'react';

// Internal modules (relative)
import { ... } from './components';
```

## Code Organization Principles

### Lambda関数パターン
- 各Lambda関数は `src/bin/` に独立したバイナリとして配置
- 共通ロジックは `src/lib.rs` に集約
- 5種類のLambdaランタイム:
  - **WebSocket系** (`lambda_runtime`): API Gateway v2経由
    - `$connect` -> `connect.rs` (アクセスログ記録: IP, User-Agent)
    - `$disconnect` -> `disconnect.rs` (アクセスログ記録)
    - `$default` -> `default.rs` (アクセスログ記録: イベント種別)
  - **HTTP系** (`lambda_http`): Lambda Function URL経由
    - NIP-11 -> `nip11_info.rs` (環境変数から11個のリレー情報フィールド読み込み)
  - **DynamoDB Streams系** (`lambda_runtime`): DynamoDB Streams経由
    - `indexer.rs` (INSERT/MODIFY/REMOVEイベントをSQLite APIにインデックス)
  - **予算管理系** (`lambda_runtime`): SNS/EventBridgeトリガー
    - `shutdown.rs` (予算超過時: Lambda無効化、EC2停止、CloudFront無効化)
    - `recovery.rs` (月初復旧: Lambda有効化、EC2起動、CloudFront有効化)
  - **運用ツール系** (CLIバイナリ): ローカル/EC2で手動実行
    - `sqlite_rebuilder.rs` (DynamoDBからSQLiteインデックス再構築)

### レイヤードアーキテクチャ（Relay Service）
```
src/
  lib.rs              # エントリポイント、モジュール公開
  domain.rs           # ドメイン層モジュール定義
  domain/             # ビジネスロジック（プロトコル依存なし）
  application.rs      # アプリケーション層モジュール定義
  application/        # ユースケース・ハンドラー
  infrastructure.rs   # インフラ層モジュール定義
  infrastructure/     # 外部システム連携（AWS SDK等）
  bin/                # Lambda関数エントリポイント
```

**Domain層**: プロトコル仕様に基づくコアロジック
- イベント検証、フィルター評価、メッセージ型定義
- 外部依存を持たない純粋なビジネスルール

**Application層**: ユースケースとハンドラー
- 接続・切断・メッセージ処理のハンドラー
- Nostrプロトコルメッセージのパースとルーティング
- Domain層とInfrastructure層を組み合わせたビジネスフロー

**Infrastructure層**: 外部システムとの連携
- DynamoDB接続設定・Repository実装
- HTTP SQLite連携（`http_sqlite/`モジュール: クライアント、インデクサー、再構築ツール）
- WebSocket送信機能（API Gateway Management API）
- 構造化ログ初期化（tracing）

### SQLite API パターン (`services/sqlite-api/`)
- 単一バイナリ構成（`src/main.rs`）
- axum HTTPサーバーフレームワーク
- SQLite接続プール (deadpool-sqlite)
- ビルド: `cargo zigbuild --release --target aarch64-unknown-linux-gnu`
- デプロイ: S3アップロード → SSM Run Commandでバイナリ更新

### Terraform モジュールパターン
- 各モジュールは単一責務（domain, api, web, ec2-search, budget）
- 変数で依存関係を注入（zone_id, certificate_arn等）
- 出力値で他モジュールへ情報を公開
- 複雑なモジュールはリソース種別でファイル分割:
  - `api/main.tf` - API Gateway, Lambda
  - `api/cloudfront.tf` - CloudFrontディストリビューション
  - `api/lambda_edge.tf` - Lambda@Edgeルーター
  - `api/dynamodb.tf` - DynamoDBテーブル
  - `api/indexer.tf` - Indexer Lambda
  - `api/nip11.tf` - NIP-11 Lambda Function URL
  - `api/cloudwatch_logs.tf` - CloudWatch Logsロググループ（90日保存）

### フロントエンド構成
- Next.js App Routerを使用
- `app/` ディレクトリでルーティング
- ポリシーページ用のRoute Group: `app/relay/(policy)/`
  - 共通レイアウト（`layout.tsx`）で一貫したスタイル
  - 3つのポリシーページ: `/relay/terms`, `/relay/privacy`, `/relay/posting-policy`
  - Tailwind Typographyで読みやすいタイポグラフィ

---
_Document patterns, not file trees. New files following patterns should not require updates_
