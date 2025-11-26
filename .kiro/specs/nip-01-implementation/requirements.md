# Requirements Document

## Introduction

NIP-01はNostrの基本プロトコルを定義する必須仕様である。本要件書では、Nostr RelayとしてNIP-01に準拠するために必要な機能要件を定義する。

対象システムは `services/relay/` のRust実装であり、AWS Lambda + API Gateway v2 (WebSocket) 上で動作するサーバーレスアーキテクチャを前提とする。

永続化層としてDynamoDBを使用し、以下のデータを管理する:
- イベントストレージ
- WebSocket接続状態
- サブスクリプション（REQ）状態

## Requirements

### Requirement 1: WebSocket接続管理

**Objective:** As a Nostrクライアント, I want Relayに対してWebSocket接続を確立したい, so that 双方向通信でイベントの送受信ができる

#### Acceptance Criteria

1. When クライアントがWebSocket接続を開始した場合, the Relay shall 接続を受け入れ、接続IDを内部で管理する
2. When クライアントがWebSocket接続を切断した場合, the Relay shall 該当接続に関連するすべてのサブスクリプションを破棄する
3. The Relay shall 接続ごとにサブスクリプションを独立して管理する

---

### Requirement 2: イベント構造検証

**Objective:** As a Relay運用者, I want 受信したイベントの構造を検証したい, so that 不正なイベントがシステムに保存されない

#### Acceptance Criteria

1. When EVENTメッセージを受信した場合, the Relay shall イベントオブジェクトが `id`, `pubkey`, `created_at`, `kind`, `tags`, `content`, `sig` の全フィールドを含むことを検証する
2. When EVENTメッセージを受信した場合, the Relay shall `id` が32バイトの小文字16進数文字列であることを検証する
3. When EVENTメッセージを受信した場合, the Relay shall `pubkey` が32バイトの小文字16進数文字列であることを検証する
4. When EVENTメッセージを受信した場合, the Relay shall `created_at` がUNIXタイムスタンプ（秒）であることを検証する
5. When EVENTメッセージを受信した場合, the Relay shall `kind` が0から65535の範囲の整数であることを検証する
6. When EVENTメッセージを受信した場合, the Relay shall `tags` が文字列配列の配列であることを検証する
7. When EVENTメッセージを受信した場合, the Relay shall `content` が文字列であることを検証する
8. When EVENTメッセージを受信した場合, the Relay shall `sig` が64バイトの小文字16進数文字列であることを検証する

---

### Requirement 3: イベントID検証

**Objective:** As a Relay運用者, I want イベントIDの正当性を検証したい, so that 改ざんされたイベントを拒否できる

#### Acceptance Criteria

1. When EVENTメッセージを受信した場合, the Relay shall イベントデータをJSON配列 `[0, pubkey, created_at, kind, tags, content]` としてシリアライズし、そのSHA256ハッシュが `id` と一致することを検証する
2. When シリアライズを行う場合, the Relay shall UTF-8エンコーディングを使用する
3. When シリアライズを行う場合, the Relay shall 空白、改行、不要なフォーマットを含めない
4. When シリアライズを行う場合, the Relay shall `content` フィールド内の改行(`0x0A`)を `\n`、ダブルクォート(`0x22`)を `\"`、バックスラッシュ(`0x5C`)を `\\`、キャリッジリターン(`0x0D`)を `\r`、タブ(`0x09`)を `\t`、バックスペース(`0x08`)を `\b`、フォームフィード(`0x0C`)を `\f` としてエスケープする
5. If イベントIDの検証に失敗した場合, the Relay shall `["OK", <event_id>, false, "invalid: event id does not match"]` を返す

---

### Requirement 4: 署名検証

**Objective:** As a Relay運用者, I want イベント署名の正当性を検証したい, so that なりすましイベントを拒否できる

#### Acceptance Criteria

1. When EVENTメッセージを受信した場合, the Relay shall `sig` がsecp256k1曲線のSchnorr署名として `id` に対して `pubkey` で有効であることを検証する
2. If 署名検証に失敗した場合, the Relay shall `["OK", <event_id>, false, "invalid: signature verification failed"]` を返す

---

### Requirement 5: EVENTメッセージ処理

**Objective:** As a Nostrクライアント, I want イベントをRelayに発行したい, so that 自分のイベントがネットワークに配信される

#### Acceptance Criteria

1. When `["EVENT", <event JSON>]` 形式のメッセージを受信した場合, the Relay shall イベントの構造検証、ID検証、署名検証を実行する
2. When すべての検証に成功した場合, the Relay shall イベントを保存する
3. When イベントの保存に成功した場合, the Relay shall `["OK", <event_id>, true, ""]` を返す
4. If イベントが既に存在する場合, the Relay shall `["OK", <event_id>, true, "duplicate: already have this event"]` を返す
5. If 検証または保存に失敗した場合, the Relay shall `["OK", <event_id>, false, "<prefix>: <human-readable message>"]` 形式でエラーを返す

---

### Requirement 6: REQメッセージ処理

**Objective:** As a Nostrクライアント, I want イベントを購読したい, so that 条件に合致するイベントをリアルタイムで受信できる

#### Acceptance Criteria

1. When `["REQ", <subscription_id>, <filters>...]` 形式のメッセージを受信した場合, the Relay shall サブスクリプションを作成する
2. When サブスクリプションを作成した場合, the Relay shall フィルターに合致する保存済みイベントを `["EVENT", <subscription_id>, <event JSON>]` 形式で送信する
3. When 保存済みイベントの送信が完了した場合, the Relay shall `["EOSE", <subscription_id>]` を送信する
4. When 同じsubscription_idで新しいREQを受信した場合, the Relay shall 既存のサブスクリプションを新しいもので置き換える
5. While サブスクリプションが有効な場合, when フィルターに合致する新しいイベントを受信した場合, the Relay shall そのイベントを該当するサブスクリプションに送信する
6. The Relay shall subscription_idは最大64文字の空でない文字列であることを検証する
7. If subscription_idが空または64文字を超える場合, the Relay shall `["CLOSED", <subscription_id>, "invalid: subscription id must be 1-64 characters"]` を返す

---

### Requirement 7: CLOSEメッセージ処理

**Objective:** As a Nostrクライアント, I want サブスクリプションを停止したい, so that 不要なイベント受信を止められる

#### Acceptance Criteria

1. When `["CLOSE", <subscription_id>]` 形式のメッセージを受信した場合, the Relay shall 該当するサブスクリプションを停止する
2. When サブスクリプションを停止した場合, the Relay shall 以降そのsubscription_idに対するイベント送信を行わない

---

### Requirement 8: フィルター処理

**Objective:** As a Nostrクライアント, I want 詳細な条件でイベントをフィルタリングしたい, so that 必要なイベントのみを受信できる

#### Acceptance Criteria

1. When フィルターに `ids` が含まれる場合, the Relay shall イベントの `id` がリスト内のいずれかと一致するイベントのみを返す
2. When フィルターに `authors` が含まれる場合, the Relay shall イベントの `pubkey` がリスト内のいずれかと一致するイベントのみを返す
3. When フィルターに `kinds` が含まれる場合, the Relay shall イベントの `kind` がリスト内のいずれかと一致するイベントのみを返す
4. When フィルターに `#<single-letter>` タグフィルターが含まれる場合, the Relay shall イベントの該当タグの値がリスト内のいずれかと一致するイベントのみを返す
5. When フィルターに `since` が含まれる場合, the Relay shall `created_at >= since` のイベントのみを返す
6. When フィルターに `until` が含まれる場合, the Relay shall `created_at <= until` のイベントのみを返す
7. When フィルターに `limit` が含まれる場合, the Relay shall 初期クエリで最大 `limit` 件のイベントを返す
8. When フィルターに複数の条件が指定されている場合, the Relay shall すべての条件をAND条件として評価する
9. When REQに複数のフィルターが指定されている場合, the Relay shall いずれかのフィルターに合致するイベントをOR条件として返す
10. When `limit` が指定されている場合, the Relay shall イベントを `created_at` 降順で返し、同一タイムスタンプの場合は `id` の辞書順で返す
11. The Relay shall `ids`, `authors`, `#e`, `#p` フィルターの値は64文字の小文字16進数文字列であることを検証する

---

### Requirement 9: Kind別イベント処理（Regular）

**Objective:** As a Relay運用者, I want 通常イベントを適切に保存したい, so that クライアントが過去のイベントを取得できる

#### Acceptance Criteria

1. When kind `n` が `1000 <= n < 10000` または `4 <= n < 45` または `n == 1` または `n == 2` の場合, the Relay shall イベントをRegular（通常）として扱い、すべて保存する

---

### Requirement 10: Kind別イベント処理（Replaceable）

**Objective:** As a Relay運用者, I want 置換可能イベントを適切に管理したい, so that ストレージを効率的に使用できる

#### Acceptance Criteria

1. When kind `n` が `10000 <= n < 20000` または `n == 0` または `n == 3` の場合, the Relay shall イベントをReplaceable（置換可能）として扱う
2. When Replaceableイベントを受信した場合, the Relay shall 同一 `pubkey` および `kind` の組み合わせで最新の `created_at` を持つイベントのみを保持する
3. When 同一タイムスタンプのReplaceableイベントが存在する場合, the Relay shall `id` の辞書順で先のイベントを保持する
4. When ReplaceableイベントへのREQを処理する場合, the Relay shall 最新のイベントのみを返す

---

### Requirement 11: Kind別イベント処理（Ephemeral）

**Objective:** As a Relay運用者, I want 一時イベントを適切に処理したい, so that 不要なデータが永続化されない

#### Acceptance Criteria

1. When kind `n` が `20000 <= n < 30000` の場合, the Relay shall イベントをEphemeral（一時的）として扱う
2. When Ephemeralイベントを受信した場合, the Relay shall イベントを保存せずに、購読中のクライアントにのみ配信する

---

### Requirement 12: Kind別イベント処理（Addressable）

**Objective:** As a Relay運用者, I want アドレス指定可能イベントを適切に管理したい, so that d tagベースの置換が正しく動作する

#### Acceptance Criteria

1. When kind `n` が `30000 <= n < 40000` の場合, the Relay shall イベントをAddressable（アドレス指定可能）として扱う
2. When Addressableイベントを受信した場合, the Relay shall 同一 `kind`, `pubkey`, `d` タグ値の組み合わせで最新の `created_at` を持つイベントのみを保持する
3. When 同一タイムスタンプのAddressableイベントが存在する場合, the Relay shall `id` の辞書順で先のイベントを保持する

---

### Requirement 13: 標準タグ処理

**Objective:** As a Nostrクライアント, I want 標準タグでイベントを検索したい, so that 関連イベントを効率的に取得できる

#### Acceptance Criteria

1. The Relay shall 英字1文字のタグ（a-z, A-Z）の最初の値をインデックスに登録する
2. When フィルターに `#e` が含まれる場合, the Relay shall `e` タグの値で参照されるイベントIDに基づいてフィルタリングする
3. When フィルターに `#p` が含まれる場合, the Relay shall `p` タグの値で参照されるpubkeyに基づいてフィルタリングする
4. When フィルターに `#a` が含まれる場合, the Relay shall `a` タグの値でAddressable/Replaceableイベント参照に基づいてフィルタリングする

---

### Requirement 14: エラーハンドリングとメッセージフォーマット

**Objective:** As a Nostrクライアント, I want 明確なエラーメッセージを受け取りたい, so that 問題の原因を特定できる

#### Acceptance Criteria

1. When EVENTメッセージに対して応答する場合, the Relay shall `["OK", <event_id>, <true|false>, <message>]` 形式で応答する
2. When イベントを拒否する場合, the Relay shall メッセージに機械可読プレフィックス（`duplicate:`, `pow:`, `blocked:`, `rate-limited:`, `invalid:`, `restricted:`, `error:`）とコロン、人間可読メッセージを含める
3. When サブスクリプションを拒否または終了する場合, the Relay shall `["CLOSED", <subscription_id>, <message>]` 形式で応答する
4. When 一般的な通知を送信する場合, the Relay shall `["NOTICE", <message>]` 形式で送信する

---

### Requirement 15: 不正メッセージ処理

**Objective:** As a Relay運用者, I want 不正なメッセージを適切に処理したい, so that システムの安定性が保たれる

#### Acceptance Criteria

1. If 受信したメッセージがJSON配列でない場合, the Relay shall `["NOTICE", "error: invalid message format"]` を返す
2. If メッセージタイプが `EVENT`, `REQ`, `CLOSE` のいずれでもない場合, the Relay shall `["NOTICE", "error: unknown message type"]` を返す
3. If JSONパースに失敗した場合, the Relay shall `["NOTICE", "error: failed to parse JSON"]` を返す

---

### Requirement 16: DynamoDBイベントストレージ

**Objective:** As a Relay運用者, I want イベントをDynamoDBに永続化したい, so that サーバーレス環境でも信頼性の高いイベント保存ができる

#### Acceptance Criteria

1. When イベントを保存する場合, the Relay shall DynamoDBテーブルにイベントデータを書き込む
2. When イベントを保存する場合, the Relay shall イベントID（`id`）をプライマリキーとして使用する
3. When イベントを保存する場合, the Relay shall `pubkey`、`kind`、`created_at` をクエリ可能な属性として保存する
4. When フィルタークエリを実行する場合, the Relay shall DynamoDBのセカンダリインデックスを活用して効率的にイベントを検索する
5. When 英字1文字のタグをインデックスする場合, the Relay shall タグ名と値をDynamoDBのセカンダリインデックスで検索可能に保存する
6. When Replaceableイベントを保存する場合, the Relay shall DynamoDBの条件付き書き込みで古いイベントを上書きする
7. When Addressableイベントを保存する場合, the Relay shall `kind:pubkey:d_tag` をキーとして最新イベントのみを保持する
8. If DynamoDB書き込みに失敗した場合, the Relay shall `["OK", <event_id>, false, "error: failed to store event"]` を返す

---

### Requirement 17: DynamoDB WebSocket接続管理

**Objective:** As a Relay運用者, I want WebSocket接続状態をDynamoDBで管理したい, so that サーバーレス環境で接続状態を永続化できる

#### Acceptance Criteria

1. When クライアントがWebSocket接続を開始した場合, the Relay shall API Gateway接続IDをDynamoDBに保存する
2. When 接続を保存する場合, the Relay shall 接続ID、接続時刻、エンドポイントURLを記録する
3. When クライアントがWebSocket接続を切断した場合, the Relay shall DynamoDBから該当接続レコードを削除する
4. When イベントを購読者に配信する場合, the Relay shall DynamoDBから有効な接続IDを取得する
5. If DynamoDB接続レコードの操作に失敗した場合, the Relay shall 接続処理を中断しエラーログを記録する

---

### Requirement 18: DynamoDBサブスクリプション管理

**Objective:** As a Relay運用者, I want サブスクリプション状態をDynamoDBで管理したい, so that Lambda関数間でサブスクリプションを共有できる

#### Acceptance Criteria

1. When REQメッセージでサブスクリプションを作成した場合, the Relay shall 接続IDとsubscription_idの組み合わせをDynamoDBに保存する
2. When サブスクリプションを保存する場合, the Relay shall フィルター条件をJSON形式で保存する
3. When CLOSEメッセージを受信した場合, the Relay shall DynamoDBから該当サブスクリプションを削除する
4. When 同じsubscription_idで新しいREQを受信した場合, the Relay shall DynamoDBの既存サブスクリプションを更新する
5. When 接続が切断された場合, the Relay shall 該当接続IDに関連するすべてのサブスクリプションをDynamoDBから削除する
6. When 新しいイベントを受信した場合, the Relay shall DynamoDBからフィルター条件に合致するサブスクリプションを検索する
7. When イベントを購読者に配信する場合, the Relay shall サブスクリプションに紐づく接続IDを使用してメッセージを送信する
8. If DynamoDBサブスクリプション操作に失敗した場合, the Relay shall `["CLOSED", <subscription_id>, "error: failed to manage subscription"]` を返す
