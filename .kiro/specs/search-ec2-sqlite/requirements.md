# Requirements Document

## Introduction

本ドキュメントは、検索基盤をAWS OpenSearch ServiceからEC2 + SQLiteに移行するプロジェクトの要件を定義する。
月額約6,000円のOpenSearchコストを約570円に削減しつつ、REQフィルタ処理機能を維持することが目標である。

## Requirements

### Requirement 1: EC2インフラストラクチャ構築

**Objective:** システム運用者として、EC2 t4g.nano上にSQLiteベースの検索基盤を構築したい。これにより、OpenSearchの代替として低コストで検索機能を提供できる。

#### Acceptance Criteria

1. EC2インスタンスは、t4g.nanoインスタンスタイプとしてパブリックサブネットにデプロイされ、Elastic IPがアタッチされること
2. EC2インスタンスには、データストレージ用にEBS gp3ボリューム（10GB）がアタッチされること
3. EC2インスタンスはAmazon Linux 2023を使用すること（SSM Agentがプリインストール済み）
4. EC2用のサブドメインは、Terraformの`random_string`リソースで生成し、Route 53にAレコードとして登録すること（tfstateにのみ保存、gitにはコミットしない）
5. EC2のプロビジョニングはUser Data（cloud-init）で行い、Caddy、systemdサービス設定を構成すること
6. EC2インスタンス起動時に、SQLiteデータベースが`/var/lib/nostr/events.db`にWALモードを有効にして初期化されること
7. SQLiteデータベースは、eventsテーブルを持ち、カラムはid（TEXT PRIMARY KEY）、pubkey（TEXT）、kind（INTEGER）、created_at（INTEGER）、event_json（TEXT）であること
8. SQLiteデータベースは、event_tagsテーブルを持ち、カラムはevent_id（TEXT）、tag_name（TEXT）、tag_value（TEXT）で、eventsテーブルへの外部キー制約を持つこと
9. SQLiteデータベースは以下のインデックスを持つこと: events.pubkey、events.kind、events.created_at DESC、events(pubkey, kind)、event_tags(tag_name, tag_value)、event_tags.event_id

### Requirement 2: HTTP APIサーバー実装

**Objective:** Lambda関数として、EC2上のHTTP APIを通じてイベントのインデックス作成とクエリ実行を行いたい。これにより、OpenSearchと同等の検索機能を利用できる。

#### Acceptance Criteria

1. HTTP APIサーバーは、Rustでaxumフレームワークを使用して実装されること
2. HTTP APIサーバーは、HTTP（localhost:8080）でリッスンし、CaddyリバースプロキシがHTTPS（ポート443）でTLS終端を行うこと
3. RustバイナリはS3バケットにアップロードし、User DataでEC2にダウンロードすること
4. バイナリの更新はSSM Run Commandを使用して行うこと（S3から再ダウンロード→サービス再起動）
5. `/events`エンドポイントで有効な認証付きPOSTリクエストを受信した場合、HTTP APIサーバーはイベントをSQLiteデータベースに保存すること
6. `/events`エンドポイントでPOSTリクエストを受信した場合、HTTP APIサーバーはすべてのタグを抽出してevent_tagsテーブルに保存すること
7. `/events/{id}`エンドポイントでDELETEリクエストを受信した場合、HTTP APIサーバーは該当イベントとそのタグをSQLiteデータベースから削除すること
8. `POST /events/search`エンドポイントでフィルタをリクエストボディとして受信した場合、HTTP APIサーバーはSQLiteデータベースから一致するイベントを返すこと
9. 検索フィルタは以下のパラメータをサポートすること: ids、authors、kinds、since、until、limit、およびタグフィルタ（#e、#p、#d、#a、#t）
10. `/health`エンドポイントでGETリクエストを受信した場合、HTTP APIサーバーはHTTP 200でヘルスステータスを返すこと
11. HTTP APIサーバーは、event_jsonフィールドの内容をJSON形式でイベントを返すこと

### Requirement 3: セキュリティ対策

**Objective:** システム運用者として、適切なセキュリティ対策を実装したい。これにより、不正アクセスやデータ漏洩を防止できる。

#### Acceptance Criteria

1. HTTP APIサーバーは、`/health`を除くすべてのエンドポイントでAuthorizationヘッダーによるAPIトークン認証を要求すること
2. 無効または欠落したAPIトークンが提供された場合、HTTP APIサーバーはHTTP 401 Unauthorizedを返すこと
3. EC2インスタンスは、ポート443/tcp（HTTPS）および80/tcp（ACME HTTP-01チャレンジ用）のインバウンドトラフィックを許可するようにSecurity Groupが設定されること
4. Caddyは、Let's Encryptから自動でTLS証明書を取得・更新すること
5. APIトークンはSystems Manager Parameter Store（SecureString）に保存され、EC2とLambda関数がIAMロールを通じて取得すること

### Requirement 4: 可用性

**Objective:** システム運用者として、EC2の可用性を確保したい。これにより、安定した検索サービスを提供できる。

#### Acceptance Criteria

1. EC2インスタンスは、再起動間で固定IPアドレスを維持するためにElastic IPがアタッチされていること
2. EC2インスタンスが停止または復旧中の間、Lambda関数は接続エラーを適切に処理すること

### Requirement 5: Lambda関数改修

**Objective:** 開発者として、Lambda関数の検索基盤接続先をEC2 + SQLiteに変更したい。これにより、新しい検索基盤を利用できる。

#### Acceptance Criteria

1. Default Lambdaは、REQクエリ処理にOpenSearchEventRepositoryの代わりにHttpSqliteEventRepositoryを使用すること
2. Indexer Lambdaは、インデックス作成のためにOpenSearchの代わりにEC2 HTTP APIにイベントを送信すること
3. DynamoDBでイベントが挿入または変更された場合、Indexer LambdaはEC2の`/events`エンドポイントにイベントをPOSTすること
4. DynamoDBからイベントが削除された場合、Indexer LambdaはSQLiteからイベントを削除するためにEC2にDELETEリクエストを送信すること
5. Lambda関数は、EC2 HTTP API呼び出し時にAuthorizationヘッダーにAPIトークンを含めること
6. EC2 HTTP API呼び出しが失敗した場合、Lambda関数はエラーをログに記録し、指数バックオフで再試行すること

### Requirement 6: インデックス復元

**Objective:** システム運用者として、DynamoDBからSQLiteインデックスを復元したい。これにより、初回構築時やインデックス破損時に再構築できる。

#### Acceptance Criteria

1. 復元ツールは、DynamoDBから既存のすべてのイベントを読み取ること
2. 復元ツールは、イベントをバッチでSQLiteデータベースに挿入すること
3. 復元バッチが処理された場合、復元ツールはイベント数とともに進捗をログに記録すること
4. SQLiteにイベントが既に存在する場合、復元ツールはスキップすること
5. 復元ツールは、初回構築および障害復旧時に実行可能であること

### Requirement 7: OpenSearch廃止とクリーンアップ

**Objective:** システム運用者として、移行完了後にOpenSearch関連リソースを削除したい。これにより、不要なコストを削減できる。

#### Acceptance Criteria

1. 移行が完了確認された場合、OpenSearch ServiceドメインはTerraformを通じて削除されること
2. Terraform設定は、apiモジュールからOpenSearch関連リソースを削除すること
3. Rustコードベースは、移行後にOpenSearch関連の依存関係とコードを削除すること
4. Lambda Indexerは、OpenSearchインデックス作成ロジックを削除するように更新されること

### Requirement 8: コスト目標達成

**Objective:** プロジェクトオーナーとして、月額コストを1,000円以下に抑えたい。これにより、持続可能な運用コストを実現できる。

#### Acceptance Criteria

1. EC2インスタンス（t4g.nano）は、月額約450円であること
2. EBSボリューム（gp3 10GB）は、月額約120円であること
3. Elastic IPは、実行中のインスタンスにアタッチされている間は無料であること
4. 検索インフラストラクチャの月額総コストは1,000円を超えないこと
