# Project Structure

## Organization Philosophy

**Monorepo with Service Separation**: アプリケーション層（apps）とバックエンドサービス層（services）を明確に分離。インフラストラクチャはTerraformモジュールパターンで管理。

## Directory Patterns

### Apps (`apps/`)
**Purpose**: フロントエンドアプリケーション
**Pattern**: 1アプリ = 1ディレクトリ
**Example**: `apps/web/` - Next.jsベースのWebフロントエンド

### Services (`services/`)
**Purpose**: バックエンドサービス（Lambda関数等）
**Pattern**: 1サービス = 1ディレクトリ、Cargoワークスペース対応
**Example**: `services/relay/` - Nostrリレー実装

### Terraform (`terraform/`)
**Purpose**: インフラストラクチャ定義
**Pattern**: ルートにメイン設定、`modules/`で責務分離

```
terraform/
  main.tf              # プロバイダー設定、モジュール呼び出し
  modules/
    domain/            # Route53, ACM証明書
    api/               # Lambda, API Gateway (WebSocket)
    web/               # Vercelプロジェクト
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
- `connect.rs` -> `nostr_relay_connect`
- `disconnect.rs` -> `nostr_relay_disconnect`
- `default.rs` -> `nostr_relay_default`

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
- WebSocket API Gateway の3ルート対応:
  - `$connect` -> `connect.rs`
  - `$disconnect` -> `disconnect.rs`
  - `$default` -> `default.rs`

### レイヤードアーキテクチャ（Relay Service）
```
src/
  lib.rs              # エントリポイント、モジュール公開
  domain.rs           # ドメイン層モジュール定義
  domain/             # ビジネスロジック（プロトコル依存なし）
  infrastructure.rs   # インフラ層モジュール定義
  infrastructure/     # 外部システム連携（AWS SDK等）
  bin/                # Lambda関数エントリポイント
```

**Domain層**: プロトコル仕様に基づくコアロジック
- イベント検証、フィルター評価、メッセージ型定義
- 外部依存を持たない純粋なビジネスルール

**Infrastructure層**: 外部システムとの連携
- DynamoDB接続設定、WebSocket送信機能
- AWS SDKを使用した具体的な実装

### Terraform モジュールパターン
- 各モジュールは単一責務（domain, api, web）
- 変数で依存関係を注入（zone_id, certificate_arn等）
- 出力値で他モジュールへ情報を公開

### フロントエンド構成
- Next.js App Routerを使用
- `app/` ディレクトリでルーティング

---
_Document patterns, not file trees. New files following patterns should not require updates_
