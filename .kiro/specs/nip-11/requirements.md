# Requirements Document

## Introduction

NIP-11（Relay Information Document）の実装要件を定義する。NIP-11は、Nostrリレーがクライアントに対してメタデータ（機能、管理者連絡先、サーバー属性など）を提供するための仕様である。HTTPリクエストでリレーのWebSocket URIにアクセスした際に、JSONドキュメントとしてリレー情報を返却する機能を実装する。

## Requirements

### Requirement 1: HTTPリクエストによるリレー情報取得

**Objective:** As a Nostrクライアント開発者, I want リレーのWebSocket URIにHTTPリクエストを送信してリレーのメタデータを取得したい, so that クライアントがリレーの機能や制限を事前に把握できる

#### Acceptance Criteria

1. When HTTPリクエストが`Accept: application/nostr+json`ヘッダー付きでリレーのWebSocket URIに送信された場合, the Relay shall リレー情報JSONドキュメントをContent-Type `application/nostr+json`で返却する
2. When HTTPリクエストが`Accept: application/nostr+json`ヘッダーなしで送信された場合, the Relay shall WebSocketアップグレードまたは通常のHTTPレスポンスとして処理する
3. The Relay shall HTTPステータスコード200でリレー情報JSONを返却する

### Requirement 2: リレー情報JSONの基本フィールド

**Objective:** As a Nostrクライアント, I want リレーの基本情報（名前、説明、管理者など）を取得したい, so that リレーの特性を把握してユーザーに表示できる

#### Acceptance Criteria

1. The Relay shall `name`フィールドにリレーの識別名（30文字以下推奨）を含める
2. The Relay shall `description`フィールドにリレーの詳細説明を含める
3. The Relay shall `pubkey`フィールドに管理者の32バイトhex公開鍵を含める
4. The Relay shall `contact`フィールドに代替連絡先URI（mailto:やhttps:スキーム）を含める
5. The Relay shall `supported_nips`フィールドにサポートするNIP番号の整数配列を含める
6. The Relay shall `software`フィールドにリレーソフトウェアのプロジェクトホームページURLを含める
7. The Relay shall `version`フィールドにソフトウェアのバージョン文字列を含める
8. The Relay shall `icon`フィールドにリレーのアイコン画像URL（正方形推奨、.jpg/.png形式）を含める
9. The Relay shall `banner`フィールドにリレーのバナー画像URL（.jpg/.png形式）を含める

### Requirement 3: CORSヘッダーの提供

**Objective:** As a Webブラウザベースのクライアント開発者, I want リレー情報APIがCORSに対応している, so that ブラウザからJavaScriptでリレー情報を取得できる

#### Acceptance Criteria

1. The Relay shall レスポンスに`Access-Control-Allow-Origin`ヘッダーを含める
2. The Relay shall レスポンスに`Access-Control-Allow-Headers`ヘッダーを含める
3. The Relay shall レスポンスに`Access-Control-Allow-Methods`ヘッダーを含める
4. When CORSプリフライトリクエスト（OPTIONSメソッド）を受信した場合, the Relay shall 適切なCORSヘッダー付きで200レスポンスを返却する

### Requirement 4: サーバー制限情報の提供

**Objective:** As a Nostrクライアント, I want リレーの制限設定を事前に把握したい, so that 制限を超えるリクエストを回避できる

#### Acceptance Criteria

1. The Relay shall `limitation`オブジェクトに現在実装済みの制限値を含める
2. The Relay shall `limitation.max_subid_length`に64（現在の実装値）を含める
3. The Relay shall 実装されていない制限値はlimitationオブジェクトに含めない

**Note:** 将来的に制限が追加実装された場合は、その時点でlimitationフィールドを拡張する。

### Requirement 5: 設定可能なリレーメタデータ

**Objective:** As a リレー運営者, I want リレーの基本情報を環境変数または設定ファイルで変更したい, so that デプロイ時にリレー情報をカスタマイズできる

#### Acceptance Criteria

1. The Relay shall リレー名を環境変数から取得可能とする
2. The Relay shall リレー説明を環境変数から取得可能とする
3. The Relay shall 管理者公開鍵を環境変数から取得可能とする
4. The Relay shall 管理者連絡先を環境変数から取得可能とする
5. The Relay shall アイコン画像URLを環境変数から取得可能とする
6. The Relay shall バナー画像URLを環境変数から取得可能とする
7. If 環境変数が設定されていない場合, then the Relay shall デフォルト値またはフィールドを省略する

### Requirement 6: AWS API Gatewayとの統合

**Objective:** As a システム設計者, I want NIP-11エンドポイントが既存のAWS API Gateway WebSocket構成と統合できる, so that 追加のインフラストラクチャなしでNIP-11を提供できる

#### Acceptance Criteria

1. The Relay shall WebSocket API GatewayのカスタムルートまたはHTTP統合でNIP-11リクエストを処理する
2. The Relay shall Lambda関数としてNIP-11レスポンス生成を実装する
3. If API Gatewayの制約でWebSocket URIでHTTPを直接処理できない場合, then the Relay shall 別途HTTP APIエンドポイントを提供する

### Requirement 7: コミュニティ・ロケール情報の提供

**Objective:** As a Nostrクライアント, I want リレーの地域・言語情報を取得したい, so that ユーザーに適切なリレーを推薦したり、法的管轄を考慮した利用判断ができる

#### Acceptance Criteria

1. The Relay shall `relay_countries`フィールドに法的管轄の国コード（ISO 3166-1 alpha-2）の配列を含める
2. The Relay shall `language_tags`フィールドに主要言語タグ（IETF言語タグ形式）の配列を含める
3. The Relay shall `relay_countries`として日本の国コード`["JP"]`をデフォルトとして設定可能とする
4. The Relay shall `language_tags`として日本語`["ja"]`をデフォルトとして設定可能とする
5. The Relay shall `relay_countries`および`language_tags`を環境変数から設定可能とする
