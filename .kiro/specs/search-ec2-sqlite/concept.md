# 検索基盤のEC2 + SQLite移行

## 背景

現在、REQフィルタ処理にAWS OpenSearch Serviceを使用しているが、月額約6,000円のコストがかかっている。これを月額1,000円以下に抑えたい。

### 検討した選択肢

| 選択肢 | 月額コスト | 採否 | 理由 |
|--------|-----------|------|------|
| DynamoDB単独（GSI拡充） | 500-1,000円 | ❌ | フルスキャンが頻発し現実的でない |
| SQLite on EFS | 100-200円 | ❌ | LambdaがVPC外にあり、VPC移行にはVPC Endpoint費用（月2,000円程度）がかかる |
| **EC2 + SQLite** | **~600円** | ✅ | 目標達成可能、LambdaをVPC外のまま実現可能 |
| Turso (libSQL) | 0円（Free Tier） | 保留 | 外部依存が増える |

## 採用案: EC2 t4g.nano + SQLite

### アーキテクチャ

```
┌─────────────────────────────────────────────────────┐
│                    VPC                              │
│  ┌───────────────────────────────────────────────┐  │
│  │ Public Subnet                                 │  │
│  │  ┌─────────────────────┐                      │  │
│  │  │ EC2 t4g.nano        │◀── Elastic IP        │  │
│  │  │ - SQLite (WAL)      │                      │  │
│  │  │ - HTTP API サーバー  │                      │  │
│  │  └─────────────────────┘                      │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
        ▲                           ▲
        │ HTTPS                     │ HTTPS
        │                           │
┌───────┴───────┐           ┌───────┴───────┐
│ Indexer       │           │ Default       │
│ Lambda        │           │ Lambda        │
│ (VPC外)       │           │ (VPC外)       │
└───────────────┘           └───────────────┘
```

### データフロー

1. **書き込み（インデックス作成）**
   - DynamoDB Streams → Indexer Lambda → HTTP POST → EC2 → SQLite

2. **読み取り（REQクエリ）**
   - Default Lambda → HTTP GET → EC2 → SQLite → レスポンス

### コスト見積もり

| 項目 | 月額 |
|------|------|
| EC2 t4g.nano | ~$3 (450円) |
| EBS gp3 10GB | ~$0.8 (120円) |
| Elastic IP (使用中) | 無料 |
| **合計** | **~570円** |

## 技術詳細

### EC2上のコンポーネント

1. **SQLiteデータベース**
   - WALモード（読み書き並行可能）
   - 単一ファイル `/var/lib/nostr/events.db`

2. **HTTP APIサーバー**
   - Rust (axum) で実装
   - エンドポイント:
     - `POST /events` - イベントのインデックス作成
     - `GET /events?filter=...` - フィルタクエリ
     - `GET /health` - ヘルスチェック

### SQLiteスキーマ（案）

```sql
CREATE TABLE events (
    id TEXT PRIMARY KEY,           -- 64文字hex
    pubkey TEXT NOT NULL,          -- 64文字hex
    kind INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    event_json TEXT NOT NULL       -- 生のJSONを保存
);

-- タグ用テーブル（正規化）
CREATE TABLE event_tags (
    event_id TEXT NOT NULL,
    tag_name TEXT NOT NULL,        -- 'e', 'p', 'd', 'a', 't' など
    tag_value TEXT NOT NULL,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

-- インデックス
CREATE INDEX idx_events_pubkey ON events(pubkey);
CREATE INDEX idx_events_kind ON events(kind);
CREATE INDEX idx_events_created_at ON events(created_at DESC);
CREATE INDEX idx_events_pubkey_kind ON events(pubkey, kind);
CREATE INDEX idx_event_tags_name_value ON event_tags(tag_name, tag_value);
CREATE INDEX idx_event_tags_event_id ON event_tags(event_id);
```

### セキュリティ対策

| 対策 | 実装方法 |
|------|----------|
| 認証 | APIトークン（環境変数で共有） |
| 通信暗号化 | HTTPS（Let's Encrypt） |
| Security Group | 443/tcp のみ許可 |
| レート制限 | EC2側で実装 |

### 可用性・運用

| 項目 | 対策 |
|------|------|
| EC2停止検知 | CloudWatch Alarm → SNS通知 |
| 自動復旧 | EC2 Auto Recovery |
| バックアップ | SQLiteファイルをS3に定期バックアップ（cron） |
| IP固定 | Elastic IP使用 |

## 移行計画

### Phase 1: EC2セットアップ
- EC2 t4g.nano作成
- SQLiteデータベース初期化
- HTTP APIサーバー実装・デプロイ

### Phase 2: Lambda改修
- OpenSearchEventRepository → HttpSqliteEventRepository に差し替え
- Indexer Lambdaの送信先変更

### Phase 3: データ移行
- 既存イベントをDynamoDBからSQLiteに移行（バッチ処理）

### Phase 4: OpenSearch廃止
- OpenSearch Serviceの削除
- 関連リソース（Indexer Lambda等）のクリーンアップ

## 想定データ量

- 1日あたり: 1,000-2,000イベント
- 年間: 約50万イベント
- SQLiteで十分処理可能な規模

## リスクと対策

| リスク | 影響 | 対策 |
|--------|------|------|
| EC2単一障害点 | サービス停止 | Auto Recovery、ダウンタイム許容 |
| セキュリティ侵害 | データ漏洩 | 強固なAPIトークン、HTTPS必須 |
| ディスク容量不足 | 書き込み失敗 | CloudWatch監視、古いイベントのアーカイブ |
