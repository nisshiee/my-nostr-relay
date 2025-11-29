# Requirements Document

## Introduction

本ドキュメントはNIP-11 Relay Information Documentの`limitation`セクションを拡張し、リレーの制限事項をクライアントに公開する機能の要件を定義する。

NIP-11仕様では、リレーがクライアントに対して様々な制限値（最大メッセージ長、最大サブスクリプション数、イベントサイズ制限等）を通知できる`limitation`オブジェクトを定義している。本機能では、現在`max_subid_length`のみを返している`limitation`オブジェクトを拡張し、実際のリレー動作に対応した制限情報をクライアントに提供する。

**スコープ外（本実装では対応しない）:**
- `auth_required` - NIP-42認証は未実装のため
- `payment_required` - 有料機能は未実装のため
- `restricted_writes` - 書き込み制限は未実装のため
- `min_pow_difficulty` - PoW要件は未実装のため

## Requirements

### Requirement 1: NIP-11 limitationフィールドの公開

**Objective:** リレー運用者として、NIP-11レスポンスの`limitation`オブジェクトに全ての制限情報を含めたい。これにより、クライアントがリレーの制限を事前に把握し、適切なリクエストを送信できるようになる。

#### Acceptance Criteria

##### 基本フィールド
1. The Relay shall return `max_message_length` as an integer in the `limitation` object, indicating the maximum bytes for incoming WebSocket messages.
2. The Relay shall return `max_subscriptions` as an integer in the `limitation` object, indicating the maximum number of active subscriptions per connection.
3. The Relay shall return `max_limit` as an integer in the `limitation` object, indicating the maximum value the relay will honor for a filter's `limit` field.
4. The Relay shall return `max_event_tags` as an integer in the `limitation` object, indicating the maximum number of tags allowed in an event.
5. The Relay shall return `max_content_length` as an integer in the `limitation` object, indicating the maximum number of characters allowed in an event's content field.
6. The Relay shall continue to return `max_subid_length` as 64 in the `limitation` object.

##### created_at制限フィールド
7. The Relay shall return `created_at_lower_limit` as an integer (seconds) in the `limitation` object, indicating how far in the past an event's `created_at` can be.
8. The Relay shall return `created_at_upper_limit` as an integer (seconds) in the `limitation` object, indicating how far in the future an event's `created_at` can be.

##### default_limitフィールド
9. The Relay shall return `default_limit` as an integer in the `limitation` object, indicating the maximum events returned when a filter omits the `limit` field.
10. When a client sends a REQ without a `limit` field, the Relay shall apply `default_limit` as the maximum number of events to return.

### Requirement 2: limitation値の設定可能性

**Objective:** リレー運用者として、各制限値を環境変数で変更可能にしたい。これにより、リレーの運用要件に応じて制限を調整できる。

#### Acceptance Criteria

1. The Relay shall allow configuration of `max_message_length` through environment variables.
2. The Relay shall allow configuration of `max_subscriptions` through environment variables.
3. The Relay shall allow configuration of `max_limit` through environment variables.
4. The Relay shall allow configuration of `max_event_tags` through environment variables.
5. The Relay shall allow configuration of `max_content_length` through environment variables.
6. The Relay shall allow configuration of `default_limit` through environment variables.
7. The Relay shall allow configuration of `created_at_lower_limit` through environment variables.
8. The Relay shall allow configuration of `created_at_upper_limit` through environment variables.
9. The Relay shall provide sensible default values for all limitation fields when environment variables are not set.

#### Default Values

環境変数が設定されていない場合、以下のデフォルト値を使用する:

| フィールド | デフォルト値 | 説明 |
|-----------|-------------|------|
| `max_message_length` | 131072 (128KB) | WebSocketメッセージの最大バイト数（※AWS API Gateway v2 WebSocket上限） |
| `max_subscriptions` | 20 | 1接続あたりの同時サブスクリプション数 |
| `max_limit` | 5000 | REQのlimitフィールドの最大値 |
| `max_event_tags` | 1000 | イベントの最大タグ数 |
| `max_content_length` | 65536 (64KB) | コンテンツの最大文字数 |
| `max_subid_length` | 64 | サブスクリプションIDの最大長（固定値） |
| `created_at_lower_limit` | 31536000 (1年) | 過去のcreated_at許容範囲（秒） |
| `created_at_upper_limit` | 900 (15分) | 未来のcreated_at許容範囲（秒） |
| `default_limit` | 100 | limitが指定されない場合のデフォルト値 |

### Requirement 3: limitation値の実行時適用

**Objective:** リレー運用者として、NIP-11で公開した制限値が実際のリクエスト処理に適用されることを保証したい。これにより、公開情報と実際の動作の整合性が保たれる。

#### Acceptance Criteria

1. When a client sends an EVENT exceeding `max_message_length`, the Relay shall reject the request with an appropriate error.
2. When a client attempts to create a new subscription that would exceed `max_subscriptions`, the Relay shall reject the new subscription with a CLOSED message.
2a. When a client sends a REQ with an existing subscription_id (updating filters), the Relay shall not count this toward the subscription limit and shall process the update normally.
3. When a client sends a REQ with a `limit` exceeding `max_limit`, the Relay shall silently clamp the value to `max_limit`.
4. When a client sends an EVENT with tags exceeding `max_event_tags`, the Relay shall reject the event with an OK message containing `invalid:` prefix.
5. When a client sends an EVENT with content exceeding `max_content_length`, the Relay shall reject the event with an OK message containing `invalid:` prefix.
6. When a client sends an EVENT with `created_at` older than (current_time - created_at_lower_limit), the Relay shall reject the event with an OK message containing `invalid:` prefix.
7. When a client sends an EVENT with `created_at` newer than (current_time + created_at_upper_limit), the Relay shall reject the event with an OK message containing `invalid:` prefix.

### Requirement 4: サブスクリプションID長の検証

**Objective:** リレー運用者として、NIP-11で公開している`max_subid_length`の制限を実際に適用したい。これにより、過度に長いサブスクリプションIDによるリソース消費を防げる。

#### Acceptance Criteria

1. When a client sends a REQ with a subscription_id exceeding `max_subid_length` (64), the Relay shall reject the request with a CLOSED message.
2. The CLOSED message shall include a human-readable explanation of the rejection reason.
3. The Relay shall validate subscription_id length before processing the REQ message.
