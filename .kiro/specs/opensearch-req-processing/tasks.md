# Implementation Plan

## Task 1. OpenSearch Serviceインフラストラクチャ構築

- [x] 1.1 OpenSearchドメインとEBS設定のTerraform定義
  - OpenSearch Serviceドメインを`opensearch.tf`に新規作成
  - エンジンバージョンをOpenSearch 2.11に設定
  - インスタンスタイプをt3.small.search（無料枠対象）に設定
  - シングルノード構成でEBSストレージ（gp3、10GB）を有効化
  - at-rest暗号化、node-to-node暗号化、HTTPS強制を設定
  - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 1.2 (P) OpenSearchアクセスポリシーとIAM設定
  - パブリックアクセスエンドポイントを使用する設定
  - リソースベースのアクセスポリシーでLambda実行ロールからのアクセスを許可
  - Lambda関数にOpenSearchへのアクセス権限（es:*）を付与するIAMポリシーをアタッチ
  - _Requirements: 1.5, 1.6, 1.7_

- [x] 1.3 Lambda環境変数へのOpenSearchエンドポイント設定
  - default Lambdaの環境変数にOPENSEARCH_ENDPOINTとOPENSEARCH_INDEXを追加
  - indexer Lambda用の環境変数設定を準備
  - Terraform applyでドメインが検索可能な状態になることを確認
  - _Requirements: 1.8, 1.9_

## Task 2. OpenSearchインデックステンプレートとマッピング定義

- [x] 2.1 インデックステンプレートJSON作成
  - イベントIDをドキュメントIDとして使用するインデックス設計
  - id、pubkeyフィールドをkeyword型で定義
  - kindフィールドをinteger型、created_atをlong型（UNIXエポック秒）で定義
  - 英字1文字タグ（e、p、d、a、t等）を個別のkeyword型フィールド（tag_e、tag_p等）として定義
  - event_jsonフィールドをindex: falseで格納専用として定義
  - シングルシャード、レプリカなしの設定でt3.small.search向けに最適化
  - インデックステンプレートとして新規インデックス作成時に自動適用される設定
  - Terraformのterraform_data + local-execでawscurlによる自動適用
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9_

- [x] 2.2 NostrEventDocumentドキュメント構造体（タスク7の先取り実装）
  - インデックステンプレートと整合性を持つRust構造体を定義
  - NostrイベントからOpenSearchドキュメントへの変換ロジック（from_event）
  - 英字1文字タグ（e、p、d、a、t）の抽出とフィールドへのマッピング
  - event_json（完全なイベントJSON）のシリアライズ
  - ユニットテスト（10テスト）で変換ロジックを検証
  - _Note: タスク7（indexer Lambda実装）で使用される構造体を先行実装_

## Task 3. OpenSearchクライアント基盤実装

- [x] 3.1 (P) Cargo.toml依存関係追加
  - opensearch = { version = "2.3", features = ["aws-auth"] }を追加
  - url = "2"を追加
  - 既存の依存関係との互換性を確認
  - _Requirements: 6.1_

- [x] 3.2 OpenSearchConfig設定読み取り機能
  - OPENSEARCH_ENDPOINT環境変数からエンドポイントURLを読み取る機能
  - OPENSEARCH_INDEX環境変数からインデックス名を読み取る機能（デフォルト: nostr_events）
  - 設定値のバリデーションとエラーハンドリング
  - _Requirements: 6.4_

- [x] 3.3 OpenSearchクライアント初期化とAWS認証
  - AWS SigV4認証を使用したクライアント作成
  - Lambda実行環境のIAMロールを使用した認証
  - コネクションプーリングを活用した接続再利用
  - 接続失敗時のエラーログ記録
  - _Requirements: 6.1, 6.2, 6.3, 6.5_

## Task 4. QueryRepositoryトレイトとEventRepository継承構造

- [x] 4.1 (P) QueryRepositoryトレイト定義
  - クエリ専用のリポジトリトレイトを定義
  - query(filters, limit)メソッドでフィルターに基づくイベント検索を抽象化
  - QueryRepositoryError型でクエリ実行、接続、デシリアライズエラーを定義
  - async_traitを使用した非同期トレイト定義
  - _Requirements: 9.1, 9.2_

- [x] 4.2 EventRepositoryトレイト継承構造への変更
  - EventRepositoryをQueryRepositoryの継承トレイトとして再定義
  - save()とget_by_id()は引き続きEventRepositoryで定義
  - 既存のDynamoEventRepositoryが両トレイトを実装するよう調整
  - _Requirements: 9.1, 9.2_

- [x] 4.3 DynamoEventRepositoryのQueryRepository互換性維持
  - 既存のquery()実装をQueryRepositoryトレイトに準拠させる
  - エラー型の変換を実装
  - 既存のテストが引き続きパスすることを確認
  - _Requirements: 9.3, 9.4_

## Task 5. FilterToQueryConverter実装

- [x] 5.1 (P) 基本フィルター変換（ids、authors、kinds）
  - idsフィルターをterms query（完全一致）に変換
  - authorsフィルターをterms query（完全一致）に変換
  - kindsフィルターをterms queryに変換
  - 注: nostrクレートの制約（EventId/PublicKeyは64文字hex必須）により前方一致は非サポート
  - _Requirements: 4.1, 4.2, 4.3_

- [x] 5.2 時間範囲とタグフィルター変換
  - sinceフィルターをrange query（created_at >= since）に変換
  - untilフィルターをrange query（created_at <= until）に変換
  - #タグフィルター（#e、#p等）を対応するtag_eフィールドのterms queryに変換
  - _Requirements: 4.4, 4.5, 4.6_

- [x] 5.3 複数フィルター条件の結合ロジック
  - 単一フィルター内の複数条件をANDで結合したbool queryのmust句を生成
  - 複数フィルターオブジェクトをORで結合したbool queryのshould句を生成
  - 空のフィルター配列はmatch_all queryを返す
  - filter句を使用してスコア計算をスキップしパフォーマンスを向上
  - _Requirements: 4.7, 4.8_

## Task 6. OpenSearchEventRepository実装

- [x] 6.1 クエリ実行とevent_jsonデシリアライズ
  - FilterToQueryConverterを使用してクエリJSONを構築
  - _source: ["event_json"]でevent_jsonフィールドのみを取得
  - created_at降順、id昇順でソートを設定
  - limitパラメータでsizeを設定（未指定時はdefault_limit、max_limit超過時はクランプ）
  - レスポンスからevent_jsonをNostr Event形式にデシリアライズ
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

- [x] 6.2 OpenSearchEventRepositoryエラーハンドリング
  - クエリタイムアウト時のエラー処理
  - 一時的サービス利用不能時のエラー処理
  - インデックス不存在時は空結果を返す処理
  - OpenSearchエラーを構造化ログに記録
  - QueryRepositoryErrorへのエラー変換
  - _Requirements: 7.1, 7.2, 7.3, 7.4_

- [x] 6.3 OpenSearchEventRepositoryユニットテスト
  - 各フィルター条件の変換ロジックをテスト
  - クエリ構築とソート設定のテスト
  - limit適用ロジックのテスト
  - エラーハンドリングのテスト
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8_

## Task 7. indexer Lambda実装

- [x] 7.1 (P) indexer Lambda関数作成
  - 新規バイナリとしてsrc/bin/indexer.rsを作成
  - lambda_runtimeを使用したLambda実行環境のセットアップ
  - OpenSearchクライアントの初期化
  - _Requirements: 3.1_

- [x] 7.2 DynamoDB Streamsレコード処理ロジック
  - INSERTイベントでNostrEventDocument（タスク2.2で実装済み）を使用してPUT
  - MODIFYイベントを同様にPUT（upsert動作）
  - REMOVEイベントで対応するドキュメントをDELETE
  - バッチ処理で複数レコードを効率的に処理
  - _Requirements: 3.1, 3.2, 3.3, 3.6, 3.7_

- [x] 7.3 indexer Lambdaエラーハンドリングとロギング
  - 処理失敗時のリトライ対応（Lambda標準リトライに依存）
  - インデックス処理の成功/失敗件数をログに記録
  - event_json欠損時はスキップしてログ記録
  - _Requirements: 3.5, 8.4_

- [x] 7.4 DynamoDB StreamsとindexerのTerraform設定
  - DynamoDB EventsテーブルにStreamsを有効化（NEW_AND_OLD_IMAGES）
  - indexer Lambda関数のリソース定義（ARM64アーキテクチャ）
  - イベントソースマッピングでStreamsとLambdaを接続（batch_size=100、LATEST）
  - indexer LambdaにOpenSearch環境変数を設定
  - _Requirements: 3.4, 3.1_

## Task 8. SubscriptionHandlerへのOpenSearch統合

- [ ] 8.1 QueryRepository依存注入とクエリ切り替え
  - SubscriptionHandlerにQueryRepositoryを依存注入
  - REQメッセージ受信時にOpenSearchEventRepositoryを使用してクエリ
  - 既存のフィルター検証ロジックを引き続き使用
  - limit適用ロジック（default_limit、max_limit）を維持
  - _Requirements: 5.1, 5.4, 5.5, 5.6, 9.3, 9.4_

- [ ] 8.2 エラー応答とCLOSEDメッセージ処理
  - クエリタイムアウト時にCLOSEDメッセージ（error:プレフィックス付き）を返す
  - サービス一時利用不能時に同様のCLOSEDメッセージを返す
  - インデックス不存在時は空結果を返しEOSEを送信
  - DynamoDBへのフォールバックは行わない（設計決定）
  - _Requirements: 7.1, 7.2, 7.4, 7.5_

- [ ] 8.3 クエリパフォーマンスロギング
  - OpenSearchクエリの実行時間をログに記録
  - クエリで取得したイベント件数をログに記録
  - 構造化ログフィールド（query_duration_ms、result_count、filter_count）を追加
  - _Requirements: 8.1, 8.2_

- [ ] 8.4 EVENT/EOSEメッセージ応答
  - クエリ結果のイベントをEVENTメッセージとして順次送信
  - 全イベント送信後にEOSEを送信
  - 従来と同じメッセージ形式を維持
  - サブスクリプション管理（作成/更新/削除）の動作を変更しない
  - _Requirements: 5.8, 9.5_

## Task 9. インデックス再構築機能

- [x] 9. DynamoDBからのインデックス再構築スクリプト
  - DynamoDB Eventsテーブルの全イベントをスキャンする機能
  - スキャンしたイベントをOpenSearchにバルクインデックスする機能
  - 既存インデックスを削除してから再構築を開始するオプション
  - 進捗状況のログ出力
  - バッチサイズを設定可能にしDynamoDBの読み取りキャパシティを考慮
  - Lambda関数またはローカルスクリプトとして実行可能な設計
  - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_

## Task 10. OpenSearchモニタリングとCloudWatch連携

- [ ] 10. OpenSearch CloudWatch Metrics設定
  - OpenSearchドメインのCloudWatch Metricsが出力されることを確認
  - クラスタヘルス、レイテンシ、ストレージ使用量のモニタリング
  - 必要に応じてアラーム設定を追加
  - _Requirements: 8.3_

## Task 11. 統合テストとE2Eテスト

- [ ] 11.1 OpenSearch接続統合テスト
  - ローカルOpenSearchコンテナを使用した接続テスト
  - インデックス作成/削除操作のテスト
  - クエリ実行と結果取得のテスト
  - _Requirements: 6.1, 6.2, 6.3, 6.5_

- [ ] 11.2 REQ処理E2Eフロー検証
  - REQメッセージからEVENT/EOSEメッセージまでの完全なフローをテスト
  - 複数フィルター条件の組み合わせテスト
  - limit適用のテスト
  - エラーケース（タイムアウト、サービス不可）のテスト
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 7.1, 7.2, 7.4_

- [ ] 11.3 DynamoDB Streams同期フロー検証
  - イベント保存後のOpenSearchインデックス反映確認
  - Replaceable/Addressableイベントの置換処理確認
  - 削除イベントのインデックス削除確認
  - _Requirements: 3.1, 3.2, 3.3_

## Task 12. DynamoDB GSI最適化

- [ ] 12. 未使用GSIの削除（OpenSearch安定稼働確認後）
  - GSI-PubkeyCreatedAtを削除（REQクエリがOpenSearchに移行のため不要）
  - GSI-KindCreatedAtを削除（同上）
  - GSI-PkKindを維持（Replaceableイベント書き込み処理で使用）
  - GSI-PkKindDを維持（Addressableイベント書き込み処理で使用）
  - OpenSearch移行完了と安定稼働を確認してから実施
  - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_
