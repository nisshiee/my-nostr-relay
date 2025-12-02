# Requirements Document

## Introduction

OpenSearch Service（マネージド版）を使用したREQ（サブスクリプション）メッセージ処理の実装。現在のDynamoDBテーブルスキャンベースのクエリを、OpenSearchによる効率的なインデックスベースのクエリに置き換えることで、REQ処理のパフォーマンスとスケーラビリティを向上させる。

本機能は、NIP-01準拠のフィルター条件（ids、authors、kinds、#タグ、since、until、limit）をOpenSearchクエリに変換し、保存済みイベントの検索を高速化する。

### アーキテクチャ方針

- **DynamoDBを「真実の源」として維持**: 書き込みは引き続きDynamoDBに行い、OpenSearchは検索用のマテリアライズドビューとして位置づける
- **OpenSearchに全イベントデータを格納**: 検索パフォーマンスのため、ID参照ではなく完全なイベントデータをOpenSearchに格納する
- **再構築可能な設計**: OpenSearch障害時はDynamoDBから完全に再構築できる
- **コスト最適化**: OpenSearch Serverlessではなくマネージド版（t3.small.search）を使用し、無料枠を活用する

## Requirements

### Requirement 1: OpenSearch Serviceインフラストラクチャ

**Objective:** インフラ管理者として、OpenSearch Serviceのドメインを適切に構成したい。これにより、コスト効率の良いイベント検索基盤を整備できる。

#### Acceptance Criteria

1. The Terraform configuration shall OpenSearch Serviceドメインを作成する
2. The Terraform configuration shall インスタンスタイプをt3.small.searchに設定する（無料枠対象）
3. The Terraform configuration shall EBSストレージ（gp3）を設定する
4. The Terraform configuration shall シングルノード構成（開発/低コスト運用向け）をサポートする
5. The Terraform configuration shall パブリックアクセスエンドポイントを使用する（VPCアクセスは使用しない）
6. The Terraform configuration shall リソースベースのアクセスポリシーでLambda関数のIAMロールからのみアクセスを許可する
7. The Terraform configuration shall Lambda関数にOpenSearchへのアクセスを許可するIAMポリシーをアタッチする
8. The Terraform configuration shall OpenSearchエンドポイントURLを環境変数としてLambda関数に渡す
9. When Terraformがapplyされた場合、the OpenSearch domain shall 検索可能な状態で起動する

### Requirement 2: イベントインデックス構造

**Objective:** 開発者として、Nostrイベントを効率的に検索できるインデックス構造を定義したい。これにより、NIP-01フィルター条件を高速に処理でき、かつ完全なイベントデータを返却できる。

#### Acceptance Criteria

1. The OpenSearch index shall イベントIDをドキュメントIDとして使用する
2. The OpenSearch index shall 以下の検索用フィールドをインデックス化する: id、pubkey、kind、created_at、tags
3. The OpenSearch index shall 完全なイベントJSON（event_json）を_sourceとして格納する
4. The OpenSearch index shall kindフィールドをinteger型としてマッピングする
5. The OpenSearch index shall created_atフィールドをlong型（UNIXエポック秒）としてマッピングする
6. The OpenSearch index shall pubkeyフィールドをkeyword型としてマッピングする
7. The OpenSearch index shall idフィールドをkeyword型としてマッピングする
8. The OpenSearch index shall 英字1文字タグ（e、p、dなど）を個別のkeyword型フィールドとしてインデックス化する
9. The index template shall 新規インデックス作成時に自動適用される

### Requirement 3: DynamoDB Streamsによるイベント同期

**Objective:** 開発者として、DynamoDBに保存されたイベントを自動的にOpenSearchにインデックス化したい。これにより、DynamoDBを真実の源として維持しながら、検索インデックスを最新に保てる。

#### Acceptance Criteria

1. When DynamoDB Eventsテーブルに新しいイベントが保存された場合、the indexing Lambda shall そのイベントをOpenSearchにインデックス化する
2. When DynamoDB Eventsテーブルのイベントが削除された場合、the indexing Lambda shall 対応するOpenSearchドキュメントを削除する
3. When Replaceableイベントが置換された場合、the indexing Lambda shall 旧イベントを削除し新イベントをインデックス化する
4. The DynamoDB Streams configuration shall NEW_AND_OLD_IMAGESストリームビュータイプを使用する
5. If DynamoDB Streamsの処理が失敗した場合、the indexing Lambda shall リトライを実行する
6. The indexing Lambda shall バッチ処理で複数のストリームレコードを効率的に処理する
7. The indexing Lambda shall 完全なイベントJSON（event_json）をOpenSearchドキュメントに含める

### Requirement 4: REQフィルターからOpenSearchクエリへの変換

**Objective:** 開発者として、NIP-01フィルター条件をOpenSearchクエリに正確に変換したい。これにより、プロトコル準拠のイベント検索を実現できる。

#### Acceptance Criteria

1. When idsフィルターが指定された場合、the query builder shall イベントIDの完全一致検索（terms query）を生成する（注: nostrクレートの制約により前方一致は非サポート）
2. When authorsフィルターが指定された場合、the query builder shall pubkeyの完全一致検索（terms query）を生成する（注: nostrクレートの制約により前方一致は非サポート）
3. When kindsフィルターが指定された場合、the query builder shall kind値のterms検索を生成する
4. When sinceフィルターが指定された場合、the query builder shall created_at >= sinceの範囲検索を生成する
5. When untilフィルターが指定された場合、the query builder shall created_at <= untilの範囲検索を生成する
6. When #タグフィルター（#e、#pなど）が指定された場合、the query builder shall 対応するタグフィールドの検索を生成する
7. When 複数のフィルター条件が指定された場合、the query builder shall 条件をANDで結合したbool queryを生成する
8. When 複数のフィルターオブジェクトが指定された場合、the query builder shall 各フィルターをORで結合したbool queryを生成する

### Requirement 5: OpenSearchクエリ実行とイベント取得

**Objective:** 開発者として、OpenSearchからイベントを効率的に取得したい。これにより、REQ応答のレイテンシーを最小化できる。

#### Acceptance Criteria

1. When REQメッセージを受信した場合、the subscription handler shall OpenSearchを使用してイベントをクエリする
2. The OpenSearch query shall created_at降順でソートする
3. The OpenSearch query shall _sourceからevent_jsonを取得し、完全なイベントデータを返却する
4. When limitが指定された場合、the OpenSearch query shall 結果件数をlimit値に制限する
5. When limitが未指定の場合、the OpenSearch query shall default_limit設定値を適用する
6. When limitがmax_limitを超える場合、the OpenSearch query shall max_limit値にクランプする
7. The subscription handler shall クエリ結果のevent_jsonをNostr Event形式にデシリアライズする
8. The subscription handler shall 取得したイベントをEVENT応答として送信し、最後にEOSEを送信する

### Requirement 6: OpenSearch接続管理

**Objective:** 開発者として、Lambda関数からOpenSearchへの接続を効率的に管理したい。これにより、コールドスタート時間とリクエストレイテンシーを最適化できる。

#### Acceptance Criteria

1. The OpenSearch client shall AWS署名バージョン4（SigV4）認証を使用する
2. The OpenSearch client shall Lambda実行環境のIAMロールを使用して認証する
3. The OpenSearch client shall コネクションプーリングを活用して接続を再利用する
4. The OpenSearch client configuration shall 環境変数からエンドポイントURLを読み取る
5. If OpenSearchへの接続が失敗した場合、the relay shall エラーをログに記録する

### Requirement 7: エラーハンドリング

**Objective:** 開発者として、OpenSearchの障害時に適切なエラー応答を返したい。これにより、クライアントが障害を認識し適切に対応できる。

#### Acceptance Criteria

1. If OpenSearchクエリがタイムアウトした場合、the subscription handler shall CLOSEDメッセージをerror:プレフィックス付きで返す
2. If OpenSearchが一時的に利用不能な場合、the subscription handler shall CLOSEDメッセージをerror:プレフィックス付きで返す
3. The relay shall OpenSearchエラーを構造化ログに記録する
4. If インデックスが存在しない場合、the subscription handler shall CLOSEDメッセージをerror:プレフィックス付きで返す（システム構成エラーとして扱う）
5. The relay shall DynamoDBへのフォールバックは行わない（OpenSearch障害時は検索不可として扱う）

### Requirement 8: パフォーマンスとモニタリング

**Objective:** 運用者として、OpenSearchクエリのパフォーマンスを監視したい。これにより、問題を早期に検出し対応できる。

#### Acceptance Criteria

1. The relay shall OpenSearchクエリの実行時間をログに記録する
2. The relay shall クエリで取得したイベント件数をログに記録する
3. The OpenSearch domain shall CloudWatch Metricsにメトリクスを出力する
4. The indexing Lambda shall インデックス処理の成功/失敗件数をログに記録する

### Requirement 9: 既存機能との互換性

**Objective:** 開発者として、既存のREQ処理機能との互換性を維持したい。これにより、クライアントへの影響なく移行できる。

#### Acceptance Criteria

1. The subscription handler shall 既存のEventRepositoryインターフェースを維持する
2. The OpenSearch implementation shall EventRepositoryトレイトを実装する
3. The subscription handler shall 既存のフィルター検証ロジックを引き続き使用する
4. The subscription handler shall サブスクリプション管理（作成/更新/削除）の動作を変更しない
5. When REQ処理が完了した場合、the relay shall 従来と同じEVENT/EOSEメッセージ形式で応答する

### Requirement 10: インデックス再構築

**Objective:** 運用者として、OpenSearchのインデックスをDynamoDBから再構築できるようにしたい。これにより、OpenSearch障害やデータ不整合から復旧できる。

#### Acceptance Criteria

1. The rebuild process shall DynamoDB Eventsテーブルの全イベントをスキャンできる
2. The rebuild process shall スキャンしたイベントをOpenSearchにバルクインデックスする
3. The rebuild process shall 既存のインデックスを削除してから再構築を開始するオプションを提供する
4. The rebuild process shall 進捗状況をログに出力する
5. The rebuild process shall バッチサイズを設定可能とし、DynamoDBの読み取りキャパシティを考慮する
6. The rebuild process shall Lambda関数またはローカルスクリプトとして実行可能とする

### Requirement 11: DynamoDB GSIの最適化

**Objective:** インフラ管理者として、REQクエリ用に作成されたが未使用のDynamoDB GSIを削除したい。これにより、書き込みコストを削減し、インフラを簡素化できる。

#### Acceptance Criteria

1. The Terraform configuration shall GSI-PubkeyCreatedAtを削除する（REQクエリがOpenSearchに移行するため不要）
2. The Terraform configuration shall GSI-KindCreatedAtを削除する（REQクエリがOpenSearchに移行するため不要）
3. The Terraform configuration shall GSI-PkKindを維持する（Replaceableイベントの書き込み処理で使用）
4. The Terraform configuration shall GSI-PkKindDを維持する（Addressableイベントの書き込み処理で使用）
5. The GSI deletion shall OpenSearch移行完了後に実施する（段階的な移行を考慮）
