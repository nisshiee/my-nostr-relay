# Relay実装対象NIP一覧

このドキュメントはNostr Relayを実装する際に関連するNIPをまとめたものです。

## 必須（Mandatory）

### NIP-01: Basic Protocol Flow Description
**ステータス**: `mandatory`

Nostrの基本プロトコルを定義。すべてのRelay実装で必須。

- **イベント構造**: `id`, `pubkey`, `created_at`, `kind`, `tags`, `content`, `sig`
- **クライアント→Relay メッセージ**:
  - `EVENT`: イベント発行
  - `REQ`: イベント購読
  - `CLOSE`: 購読停止
- **Relay→クライアント メッセージ**:
  - `EVENT`: 購読イベント送信
  - `OK`: EVENT受付結果
  - `EOSE`: 保存済みイベント送信完了
  - `CLOSED`: 購読終了通知
  - `NOTICE`: 人間可読メッセージ
- **フィルター**: `ids`, `authors`, `kinds`, `#<tag>`, `since`, `until`, `limit`
- **Kind範囲によるイベント種別**:
  - Regular（通常保存）
  - Replaceable（pubkey+kindで最新のみ保存）
  - Ephemeral（保存不要）
  - Addressable（pubkey+kind+d tagで最新のみ保存）

---

## Relay専用NIP

### NIP-11: Relay Information Document
**ステータス**: `optional`

HTTPリクエスト（`Accept: application/nostr+json`）でRelayメタデータを提供。

- **基本フィールド**: `name`, `description`, `pubkey`, `contact`, `supported_nips`, `software`, `version`
- **制限設定（limitation）**: `max_message_length`, `max_subscriptions`, `max_limit`, `min_pow_difficulty`, `auth_required`, `payment_required`
- **イベント保持（retention）**: Kind別の保持期間設定
- **コミュニティ設定**: `language_tags`, `tags`, `posting_policy`
- **課金設定（fees）**: `admission`, `subscription`, `publication`
- CORSヘッダー必須

### NIP-42: Authentication of Clients to Relays
**ステータス**: `optional`

クライアント認証機能。

- **Relay→クライアント**: `["AUTH", <challenge>]` チャレンジ送信
- **クライアント→Relay**: `["AUTH", <signed-event>]` 認証イベント送信（kind:22242）
- 認証イベントの検証: kind、created_at（±10分）、challengeタグ、relayタグ
- `OK`/`CLOSED`プレフィックス: `auth-required:`, `restricted:`

### NIP-45: Event Counts
**ステータス**: `optional`

イベント数カウント機能。

- **クライアント→Relay**: `["COUNT", <query_id>, <filters>...]`
- **Relay→クライアント**: `["COUNT", <query_id>, {"count": <int>, "approximate": <bool>}]`
- 拒否時は`CLOSED`メッセージ

### NIP-50: Search Capability
**ステータス**: `optional`

全文検索機能。

- フィルターに`search`フィールド追加
- 検索結果は関連度順（created_at順ではない）
- 拡張キーワード: `include:spam`, `domain:`, `language:`, `sentiment:`, `nsfw:`

### NIP-77: Negentropy Syncing
**ステータス**: `optional`

効率的なイベント同期プロトコル。

- **メッセージ**:
  - `NEG-OPEN`: 同期開始
  - `NEG-MSG`: 同期メッセージ（双方向）
  - `NEG-CLOSE`: 同期終了
  - `NEG-ERR`: エラー（`blocked:`, `closed:`）

### NIP-86: Relay Management API
**ステータス**: `optional`

Relay管理用JSON-RPC API（HTTPで提供、`Content-Type: application/nostr+json+rpc`）。

- **メソッド**:
  - `supportedmethods`: サポートメソッド一覧
  - `banpubkey`/`listbannedpubkeys`: pubkey BAN管理
  - `allowpubkey`/`listallowedpubkeys`: pubkey許可リスト管理
  - `banevent`/`allowevent`/`listbannedevents`: イベントモデレーション
  - `changerelayname`/`changerelaydescription`/`changerelayicon`: メタデータ変更
  - `allowkind`/`disallowkind`/`listallowedkinds`: Kind制限管理
  - `blockip`/`unblockip`/`listblockedips`: IPブロック管理
- NIP-98認証ヘッダー必須

---

## イベント処理関連NIP

### NIP-09: Event Deletion Request
**ステータス**: `optional`

イベント削除リクエスト（kind:5）。

- `e`/`a`タグで削除対象を指定
- **Relay動作**: 同一pubkeyのイベントを削除/非公開化すべき
- 削除リクエスト自体は無期限に公開継続すべき

### NIP-13: Proof of Work
**ステータス**: `optional`

PoW（作業証明）によるスパム対策。

- イベントIDの先頭ゼロビット数で難易度定義
- `nonce`タグ: `["nonce", "<nonce値>", "<目標難易度>"]`
- **Relay動作**: NIP-11で`min_pow_difficulty`を設定し、満たさないイベントを拒否可能

### NIP-40: Expiration Timestamp
**ステータス**: `optional`

イベント有効期限。

- `expiration`タグ: UNIXタイムスタンプ
- **Relay動作**:
  - 期限切れイベントをクライアントに送信すべきではない
  - 発行時点で期限切れのイベントは拒否すべき
  - 即時削除は必須ではない

### NIP-62: Request to Vanish
**ステータス**: `optional`

完全消去リクエスト（kind:62）。

- `relay`タグで対象Relayを指定（または`ALL_RELAYS`）
- **Relay動作**:
  - 該当pubkeyの全イベント（削除イベント含む）を完全削除必須
  - 再ブロードキャスト防止必須
  - Gift Wrap（kind:1059）でp-tagされたものも削除すべき

### NIP-70: Protected Events
**ステータス**: `optional`

保護イベント（著者のみが発行可能）。

- `["-"]`タグの存在で保護イベントを示す
- **Relay動作**:
  - デフォルトで`["-"]`タグ付きイベントを拒否必須
  - 受け入れる場合はNIP-42認証を要求し、認証済みpubkey=イベントpubkeyを確認

---

## 特殊イベント種別

### NIP-59: Gift Wrap
**ステータス**: `optional`

暗号化メッセージのラッパー。

- **kind:13（Seal）**: タグ空、kind:22242と同様にブロードキャスト禁止
- **kind:1059（Gift Wrap）**: ランダムキーで署名、pタグで受信者指定
- **Relay動作**:
  - 受信者メタデータ保護のため、AUTH済みユーザーのみにkind:1059を提供すべき
  - p-tagされた受信者にのみ提供すべき
  - 削除リクエスト時、p-tag=署名者のkind:1059を削除すべき

### NIP-17: Private Direct Messages
**ステータス**: `optional`

プライベートDM（NIP-59ベース）。

- kind:14（テキスト）、kind:15（ファイル）をGift Wrapで送信
- **Relay動作**: kind:1059をAUTHでガードし、p-tagされたユーザーにのみ提供推奨

### NIP-56: Reporting
**ステータス**: `optional`

通報機能（kind:1984）。

- `p`タグ（必須）: 通報対象pubkey
- `e`タグ: 通報対象イベント
- 通報タイプ: `nudity`, `malware`, `profanity`, `illegal`, `spam`, `impersonation`, `other`
- **Relay動作**: 自動モデレーションは非推奨（ゲーム化されやすい）、信頼できるモデレーターからの通報を管理者が活用

---

## Relay主導機能

### NIP-29: Relay-based Groups
**ステータス**: `optional`

Relay管理のグループ機能。

- **Relay生成イベント**:
  - kind:39000（グループメタデータ）
  - kind:39001（管理者リスト）
  - kind:39002（メンバーリスト）
  - kind:39003（ロール定義）
- **モデレーションイベント**（kind:9000-9020）: ユーザー追加/削除、メタデータ編集等
- グループID: `<host>'<group-id>`形式
- `h`タグでグループ所属を示す
- **Relay動作**:
  - グループメタデータを自身の鍵で署名・公開
  - モデレーションイベントの権限チェック
  - 遅延投稿防止

---

## 関連NIP（Relay動作に影響）

| NIP | 名称 | Relay関連内容 |
|-----|------|--------------|
| NIP-02 | Follow List | kind:3はReplaceableイベントとして処理 |
| NIP-28 | Public Chat | kind:40-44のチャンネル機能（モデレーションはクライアント側） |
| NIP-64 | Chess (PGN) | RelayはPGN検証可能（任意） |
| NIP-65 | Relay List Metadata | kind:10002でユーザーの推奨Relayリストを保存 |
| NIP-94 | File Metadata | kind:1063でファイルメタデータを保存 |

---

## メッセージタイプ一覧

### クライアント→Relay

| タイプ | 説明 | NIP |
|--------|------|-----|
| `EVENT` | イベント発行 | 01 |
| `REQ` | イベント購読 | 01 |
| `CLOSE` | 購読停止 | 01 |
| `AUTH` | 認証イベント送信 | 42 |
| `COUNT` | カウント要求 | 45 |
| `NEG-OPEN` | 同期開始 | 77 |
| `NEG-MSG` | 同期メッセージ | 77 |
| `NEG-CLOSE` | 同期終了 | 77 |

### Relay→クライアント

| タイプ | 説明 | NIP |
|--------|------|-----|
| `EVENT` | イベント送信 | 01 |
| `OK` | EVENT結果 | 01 |
| `EOSE` | 保存イベント送信完了 | 01 |
| `CLOSED` | 購読終了 | 01 |
| `NOTICE` | 通知メッセージ | 01 |
| `AUTH` | 認証チャレンジ | 42 |
| `COUNT` | カウント結果 | 45 |
| `NEG-MSG` | 同期メッセージ | 77 |
| `NEG-ERR` | 同期エラー | 77 |

---

## OK/CLOSEDプレフィックス

| プレフィックス | 説明 |
|----------------|------|
| `duplicate:` | 既に存在 |
| `pow:` | PoW関連 |
| `blocked:` | ブロック済み |
| `rate-limited:` | レート制限 |
| `invalid:` | 無効なイベント |
| `restricted:` | 制限あり（認証済みでも権限なし） |
| `auth-required:` | 認証必要 |
| `mute:` | ミュート（ephemeral無視） |
| `error:` | その他エラー |
