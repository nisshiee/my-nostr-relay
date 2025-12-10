# Implementation Plan

## Task Overview

検索基盤をOpenSearch ServiceからEC2 + SQLiteに移行するための実装タスク。Migration Strategyに沿って4つのフェーズで段階的に実施する。

---

## Phase 1: EC2セットアップ

- [x] 1. TerraformによるEC2インフラ構築
- [x] 1.1 セキュリティグループとネットワーク設定
  - HTTPS（ポート443）とHTTP（ポート80、ACME用）のインバウンドルールを設定
  - 既存VPCのパブリックサブネットを使用
  - アウトバウンドは全許可（Let's Encrypt、SSM通信用）
  - _Requirements: 1.1, 3.3_

- [x] 1.2 EC2インスタンスとストレージ定義
  - t4g.nanoインスタンスタイプを指定
  - Amazon Linux 2023 AMIを使用（SSM Agent プリインストール）
  - EBS gp3ボリューム（10GB）をアタッチ
  - IAMインスタンスプロファイルでSSMとS3アクセスを許可
  - _Requirements: 1.1, 1.2, 1.3, 8.1, 8.2_

- [x] 1.3 Elastic IPとRoute 53設定
  - Elastic IPを作成しEC2インスタンスにアタッチ
  - `random_string`リソースでサブドメインを生成
  - Route 53にAレコードを登録
  - _Requirements: 1.1, 1.4, 4.1, 8.3_

- [x] 1.4 User Dataによるプロビジョニングスクリプト作成
  - Caddyのインストールと設定（リバースプロキシ、TLS自動化）
  - SQLiteデータベースの初期化（WALモード、スキーマ作成）
  - systemdサービスファイルの配置と有効化
  - S3からバイナリをダウンロードするスクリプト
  - Parameter StoreからAPIトークンを取得し環境変数に設定
  - _Requirements: 1.5, 1.6, 1.7, 1.8, 1.9, 3.4_

- [x] 1.5 (P) APIトークンのParameter Store登録
  - SecureString形式でAPIトークンを保存
  - EC2とLambda用のIAMポリシーを設定
  - _Requirements: 3.5_

- [x] 1.6 (P) バイナリ配布用S3バケット作成
  - S3バケットを作成
  - EC2からのGetObjectを許可するバケットポリシー
  - SSM Run Commandでバイナリ更新を実行するドキュメント定義
  - _Requirements: 2.3, 2.4_

---

## Phase 2: HTTP APIサーバー実装

- [ ] 2. EC2上で動作するHTTP APIサーバーの実装
- [x] 2.1 Rustプロジェクトのセットアップ
  - 新規バイナリクレートを作成（services/sqlite-api等）
  - axum、rusqlite、deadpool-sqlite、tokio、tracing等の依存関係を追加
  - ARM64向けのビルド設定
  - _Requirements: 2.1_

- [x] 2.2 (P) SQLiteデータベーススキーマと接続管理
  - eventsテーブル（id、pubkey、kind、created_at、event_json）を定義
  - event_tagsテーブル（event_id、tag_name、tag_value、外部キー）を定義
  - 要求されたインデックスをすべて作成
  - 書き込み用単一接続とdeadpool-sqlite読み取りプールを構成
  - _Requirements: 1.7, 1.8, 1.9_

- [x] 2.3 SqliteEventStoreコア機能の実装
  - イベント保存（トランザクションでeventsとevent_tagsを原子的に挿入）
  - すべてのタグを抽出してevent_tagsテーブルに保存
  - イベント削除（CASCADE削除でタグも削除）
  - 重複イベントのスキップ（既存時は200 OKを返却）
  - _Requirements: 2.5, 2.6, 2.7_

- [x] 2.4 検索フィルター処理の実装
  - ids、authors、kinds、since、until、limitパラメータをサポート
  - タグフィルター（#e、#p、#d、#a、#t）をサポート
  - フィルター条件をSQL WHERE句に動的に変換
  - event_jsonフィールドからJSON形式でイベントを返却
  - _Requirements: 2.8, 2.9, 2.11_

- [x] 2.5 認証ミドルウェアの実装
  - Authorizationヘッダーからトークンを抽出
  - 環境変数に設定されたトークンと照合
  - /healthエンドポイントは認証をバイパス
  - 不正なトークン時は401 Unauthorizedを返却
  - _Requirements: 3.1, 3.2_

- [x] 2.6 APIエンドポイントの組み立て
  - POST /events（イベント保存）ルートを作成
  - DELETE /events/{id}（イベント削除）ルートを作成
  - POST /events/search（検索）ルートを作成
  - GET /health（ヘルスチェック）ルートを作成
  - localhost:8080でHTTPリッスン
  - _Requirements: 2.2, 2.5, 2.7, 2.8, 2.10_

- [x] 2.7 エラーハンドリングと構造化ログ
  - tracingによるリクエストログ出力
  - エラーレスポンス（400、401、404、500）の統一フォーマット
  - DBエラー時の適切なエラーメッセージ
  - _Requirements: 2.5, 2.7, 2.8, 2.10_

- [x] 2.8 HTTP APIサーバーのユニットテスト
  - SqliteEventStoreのCRUD操作テスト
  - フィルター変換ロジックのテスト
  - 認証ミドルウェアのテスト
  - _Requirements: 2.5, 2.6, 2.7, 2.8, 2.9_

---

## Phase 3: Lambda関数改修

- [ ] 3. Lambda関数の検索基盤接続先変更
- [x] 3.1 (P) HttpSqliteEventRepositoryの実装
  - QueryRepositoryトレイトを実装
  - EC2エンドポイントへのHTTPS通信
  - Authorizationヘッダーにトークンを付与
  - Parameter StoreからトークンをLambda初期化時に取得
  - レスポンスをNostr Event形式にデシリアライズ
  - _Requirements: 5.1, 5.2, 5.5_

- [x] 3.2 (P) IndexerClientの実装
  - イベントインデックス（POST /events）メソッドを実装
  - イベント削除（DELETE /events/{id}）メソッドを実装
  - reqwest_retryで指数バックオフ再試行（最大3回）
  - エラー時のログ記録
  - _Requirements: 5.3, 5.4, 5.5, 5.6_

- [x] 3.3 Default Lambdaの改修
  - OpenSearchEventRepositoryをHttpSqliteEventRepositoryに置き換え
  - EC2エンドポイントURLを環境変数から取得
  - 接続エラー時の適切なエラーハンドリング
  - _Requirements: 5.1, 4.2_

- [ ] 3.4 Indexer Lambdaの改修
  - OpenSearchインデックスロジックをIndexerClientに置き換え
  - DynamoDB INSERT/MODIFYイベントでPOSTを送信
  - DynamoDB REMOVEイベントでDELETEを送信
  - _Requirements: 5.3, 5.4_

- [ ] 3.5 Lambda環境変数とIAM設定（Terraform）
  - EC2エンドポイントURLの環境変数を追加
  - Parameter Storeアクセス用IAMポリシーを追加
  - 既存のOpenSearch関連環境変数は一旦維持（Phase 4で削除）
  - _Requirements: 5.5, 3.5_

---

## Phase 4: データ移行

- [ ] 4. インデックス復元ツールの実装
- [ ] 4.1 RebuilderToolのHTTP API対応
  - 既存のrebuilder.rsをIndexerClient使用に改修
  - DynamoDBから全イベントをスキャン
  - バッチ単位でEC2 HTTP APIにPOST
  - 既存イベントのスキップ（409をエラーとしない）
  - _Requirements: 6.1, 6.2, 6.4_

- [ ] 4.2 進捗ログとリカバリー機能
  - バッチ処理ごとにイベント数をログ出力
  - 中断時のLastEvaluatedKeyをログ出力
  - 障害復旧時の再開をサポート
  - _Requirements: 6.3, 6.5_

---

## Phase 5: 統合テスト

- [ ] 5. 統合テストと検証
- [ ] 5.1 EC2デプロイと動作確認
  - Terraformでインフラをデプロイ
  - /healthエンドポイントの疎通確認
  - HTTPS証明書の自動取得確認
  - 手動でイベント保存・検索のAPI動作確認
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.10, 3.3, 3.4_

- [ ] 5.2 Lambda連携テスト
  - テスト環境でLambda→EC2通信を確認
  - REQクエリ処理のエンドツーエンド動作確認
  - Indexer Lambdaのインデックス作成確認
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

- [ ] 5.3 データ移行の実行と検証
  - RebuilderでDynamoDBから全イベントを移行
  - DynamoDBとSQLiteのイベント数を比較
  - サンプルクエリで検索結果の整合性を確認
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

---

## Phase 6: OpenSearch廃止

- [ ] 6. OpenSearch関連リソースのクリーンアップ
- [ ] 6.1 OpenSearch接続の無効化
  - Lambda関数からOpenSearch参照を削除
  - 環境変数からOpenSearch関連設定を削除
  - デプロイして新構成での動作を確認
  - _Requirements: 7.4_

- [ ] 6.2 TerraformからOpenSearchリソース削除
  - opensearch.tfからOpenSearch Serviceドメインを削除
  - Indexer LambdaのOpenSearch関連IAMポリシーを削除
  - terraform applyでリソースを削除
  - _Requirements: 7.1, 7.2_

- [ ] 6.3 Rustコードベースのクリーンアップ
  - OpenSearch関連の依存関係を削除（Cargo.toml）
  - OpenSearchEventRepository等の関連コードを削除
  - 未使用のインポートを整理
  - cargo clippy/testで警告がないことを確認
  - _Requirements: 7.3_

---

## Requirements Coverage

| Requirement | Tasks |
|-------------|-------|
| 1.1-1.9 | 1.1, 1.2, 1.3, 1.4, 2.2, 5.1 |
| 2.1-2.11 | 2.1, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8 |
| 3.1-3.5 | 1.1, 1.4, 1.5, 2.5, 3.1, 3.2, 3.5 |
| 4.1-4.2 | 1.3, 3.3 |
| 5.1-5.6 | 3.1, 3.2, 3.3, 3.4, 3.5, 5.2 |
| 6.1-6.5 | 4.1, 4.2, 5.3 |
| 7.1-7.4 | 6.1, 6.2, 6.3 |
| 8.1-8.4 | 1.2, 1.3 |
