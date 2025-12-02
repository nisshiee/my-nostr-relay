# Requirements Document

## Introduction

NIP-09（Event Deletion Request）対応のための要件定義。Nostr Relayにおけるkind:5削除リクエストイベントの処理を実装し、ユーザーが自身のイベントを削除できる機能を提供する。

## Requirements

### Requirement 1: 削除リクエストイベントの受信と検証

**Objective:** As a Nostrユーザー, I want 自分のイベントに対する削除リクエストを送信する, so that 不要になったイベントをリレーから削除できる

#### Acceptance Criteria

1. When kind:5の削除リクエストイベントを受信した時, the Relay Service shall イベントの署名を検証し、有効な場合は処理を継続する
2. When 削除リクエストイベントに`e`タグが含まれる時, the Relay Service shall 参照されるイベントIDを削除対象として認識する
3. When 削除リクエストイベントに`a`タグが含まれる時, the Relay Service shall 参照されるAddressableイベントを削除対象として認識する
4. When 削除リクエストイベントを正常に処理した時, the Relay Service shall OKメッセージ（`true`）をクライアントに返す
5. If 削除リクエストイベントの署名が無効な場合, then the Relay Service shall OKメッセージ（`false`、`invalid:`プレフィックス）をクライアントに返す

### Requirement 2: 通常イベントの削除処理

**Objective:** As a Nostrユーザー, I want `e`タグで指定したイベントを削除する, so that 個別のイベントをリレーから削除できる

#### Acceptance Criteria

1. When 削除リクエストの`e`タグで参照されるイベントが存在し、pubkeyが一致する時, the Relay Service shall 該当イベントをDynamoDBから物理削除する
2. If 削除リクエストの`e`タグで参照されるイベントのpubkeyが削除リクエストのpubkeyと一致しない場合, then the Relay Service shall 該当イベントを削除せずにスキップする
3. If 削除リクエストの`e`タグで参照されるイベントが存在しない場合, then the Relay Service shall エラーを発生させずに処理を継続する
4. When 削除対象のイベントを物理削除した後, the Relay Service shall REQフィルターに一致しても該当イベントを返さない
5. When DynamoDBからイベントが物理削除された時, the Indexer Lambda shall DynamoDB StreamsのREMOVEイベントを検知し、OpenSearchから対応するドキュメントを自動的に削除する（既存実装で対応済み）

### Requirement 3: Addressableイベントの削除処理

**Objective:** As a Nostrユーザー, I want `a`タグで指定したAddressableイベントを削除する, so that Replaceableイベントの全バージョンを削除できる

#### Acceptance Criteria

1. When 削除リクエストの`a`タグで参照されるAddressableイベントが存在し、pubkeyが一致する時, the Relay Service shall 削除リクエストの`created_at`以前に作成された該当イベントの全バージョンをDynamoDBから物理削除する
2. If 削除リクエストの`a`タグで参照されるAddressableイベントのpubkeyが削除リクエストのpubkeyと一致しない場合, then the Relay Service shall 該当イベントを削除せずにスキップする
3. When 削除リクエストの`a`タグの`created_at`より後に作成されたバージョンが存在する時, the Relay Service shall 該当バージョンを削除対象から除外する
4. When DynamoDBからAddressableイベントが物理削除された時, the Indexer Lambda shall OpenSearchから対応するドキュメントを自動的に削除する（既存実装で対応済み）

### Requirement 4: 削除リクエストイベントの保存と配信

**Objective:** As a Nostrクライアント, I want 削除リクエストイベントを取得する, so that 削除されたイベントの状態をユーザーに表示できる

#### Acceptance Criteria

1. When 削除リクエストイベントを受信した時, the Relay Service shall 削除リクエストイベント自体をDynamoDBに保存する
2. When REQフィルターがkind:5にマッチする時, the Relay Service shall 保存された削除リクエストイベントをクライアントに配信する
3. The Relay Service shall 削除リクエストイベントを無期限に保存し、配信し続ける

### Requirement 5: 削除リクエストの削除（無効化）

**Objective:** As a Relayオペレーター, I want 削除リクエストの削除リクエストを無視する, so that 一度削除されたイベントが復活することを防ぐ

#### Acceptance Criteria

1. When kind:5の削除リクエストが他のkind:5イベントを参照する時, the Relay Service shall 削除対象のkind:5イベントを削除しない
2. When kind:5の削除リクエストが他のkind:5イベントを参照する時, the Relay Service shall 削除リクエストイベント自体は通常通り保存する

### Requirement 6: サブスクリプションへの反映

**Objective:** As a Nostrクライアント, I want 削除されたイベントがクエリ結果に反映される, so that 削除後の最新状態を取得できる

#### Acceptance Criteria

1. When イベントが物理削除された後にREQクエリを受信した時, the Relay Service shall 削除済みイベントをクエリ結果に含めない
2. When 新規の削除リクエストイベント（kind:5）を受信した時, the Relay Service shall kind:5にマッチするアクティブなサブスクリプションに削除リクエストイベントを配信する

#### 設計判断

- 削除対象イベントにマッチする既存サブスクリプションへの即時通知は実装しない（NIP-09で要求されていないため）
- 物理削除により、以降のクエリで自然に削除済みイベントが返されなくなる
