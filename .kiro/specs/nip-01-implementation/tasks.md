# Implementation Plan

## Task 1: Project Setup and Dependencies

- [x] 1.1 Cargo.toml依存関係追加
  - nostr crate (v0.44.x) をイベントモデル・署名検証・フィルター評価用に追加
  - aws-sdk-dynamodb, aws-sdk-apigatewaymanagement, aws-config を追加
  - async-trait crateを非同期トレイト定義用に追加
  - 既存のserde, serde_json, tokioとの互換性を確認
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 3.1, 4.1, 16.1_

- [x] 1.2 DynamoDB Terraformリソース定義
  - terraform/modules/api/ にEventsテーブル定義を追加（PKはid）
  - GSI-PubkeyCreatedAt（pubkey, created_at）を定義
  - GSI-KindCreatedAt（kind, created_at）を定義
  - GSI-PkKind（pk_kind, created_at）をReplaceable用に定義
  - GSI-PkKindD（pk_kind_d, created_at）をAddressable用に定義
  - Connectionsテーブル定義を追加（PKはconnection_id、TTL設定）
  - Subscriptionsテーブル定義を追加（PKはconnection_id、SKはsubscription_id）
  - Lambda実行ロールにDynamoDB操作権限を付与
  - タグフィルター（#e, #p）はGSI化せずアプリケーション層で処理する設計に従う
  - _Requirements: 16.2, 16.3, 16.4, 16.5, 17.1, 17.2, 18.1, 18.2_

## Task 2: Domain Layer Implementation

- [x] 2.1 (P) Kind分類ヘルパー実装
  - イベントKindを4種類（Regular, Replaceable, Ephemeral, Addressable）に分類する機能を実装
  - Regular: kind 1, 2, 4-44, 1000-9999
  - Replaceable: kind 0, 3, 10000-19999
  - Ephemeral: kind 20000-29999
  - Addressable: kind 30000-39999
  - _Requirements: 9.1, 10.1, 11.1, 12.1_

- [x] 2.2 (P) イベント検証機能実装
  - 受信したJSONに必須フィールド（id, pubkey, created_at, kind, tags, content, sig）が存在することを検証
  - idが64文字の小文字16進数文字列であることを検証
  - pubkeyが64文字の小文字16進数文字列であることを検証
  - created_atがUNIXタイムスタンプ（秒）であることを検証
  - kindが0-65535の範囲であることを検証
  - tagsが文字列配列の配列であることを検証
  - contentが文字列であることを検証
  - sigが128文字の小文字16進数文字列であることを検証
  - nostr crateを使用してイベントIDのSHA256ハッシュ検証を実行
  - nostr crateを使用してSchnorr署名検証を実行
  - 検証失敗時に適切なエラーメッセージを生成
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2_

- [x] 2.3 (P) フィルター評価機能実装
  - nostr crateのFilter型を活用してフィルター条件をパース
  - idsフィルター：イベントIDの前方一致または完全一致を評価
  - authorsフィルター：pubkeyの前方一致または完全一致を評価
  - kindsフィルター：イベントkindのリストマッチを評価
  - タグフィルター（#e, #p, #a等）：英字1文字タグの値マッチを評価
  - since/untilフィルター：created_atの範囲条件を評価
  - limitフィルター：結果件数制限を処理
  - 複数条件のAND評価を実装
  - 複数フィルターのOR評価を実装
  - ids, authors, #e, #pフィルター値が64文字16進数であることを検証
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 8.11_

- [x] 2.4 (P) Relayメッセージ型定義
  - EVENT応答メッセージ（subscription_id + イベント）の型とJSON変換を実装
  - OK応答メッセージ（event_id + 成否 + メッセージ）の型とJSON変換を実装
  - EOSE応答メッセージ（subscription_id）の型とJSON変換を実装
  - CLOSED応答メッセージ（subscription_id + メッセージ）の型とJSON変換を実装
  - NOTICE応答メッセージ（メッセージ）の型とJSON変換を実装
  - OKメッセージ用のヘルパー（成功、重複、エラー各種プレフィックス付き）を実装
  - エラーメッセージプレフィックス（duplicate:, invalid:, error:等）の定数を定義
  - _Requirements: 14.1, 14.2, 14.3, 14.4_

## Task 3: Infrastructure Layer Implementation

- [x] 3.1 DynamoDB接続設定
  - aws-configを使用してAWS認証情報を環境変数から自動取得
  - DynamoDBクライアントの初期化処理を実装
  - テーブル名を環境変数から取得する設定を実装
  - _Requirements: 16.1, 17.1, 18.1_

- [x] 3.2 (P) WebSocket送信機能実装
  - API Gateway Management APIクライアントを初期化
  - エンドポイントURLを動的に設定する機能を実装
  - 接続IDを指定してメッセージを送信する機能を実装
  - 410 GONE（接続切れ）エラーを検出してハンドリング
  - 複数接続への一括送信（ブロードキャスト）機能を実装
  - 送信エラーの種類（接続切れ、ネットワークエラー等）を区別
  - _Requirements: 6.2, 6.5, 18.7_

- [x] 3.3 (P) 接続リポジトリ実装
  - 接続IDをキーとしてDynamoDBに接続情報を保存
  - 接続時刻とエンドポイントURLを属性として記録
  - TTL属性を設定して古い接続を自動削除
  - 接続IDで接続情報を取得する機能を実装
  - 接続IDで接続レコードを削除する機能を実装
  - DynamoDB操作失敗時のエラーハンドリング
  - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5_

- [x] 3.4 (P) サブスクリプションリポジトリ実装
  - 接続ID+subscription_idを複合キーとしてサブスクリプションを保存
  - フィルター条件をJSON文字列として保存
  - 同じsubscription_idへの上書き更新（upsert）を実装
  - 接続ID+subscription_idでサブスクリプションを削除
  - 接続IDに関連する全サブスクリプションを一括削除
  - 全サブスクリプションをスキャンしてイベントにマッチするものを検索
  - アプリケーション層でフィルター条件を評価してマッチング判定
  - DynamoDB操作失敗時のエラーハンドリング
  - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8_

- [x] 3.5 イベントリポジトリ実装
  - 3.4の完了後に実施（サブスクリプション検索との連携のため）
  - イベントIDをプライマリキーとしてDynamoDBに保存
  - pubkey, kind, created_at, tags, content, sigを属性として保存
  - 完全なイベントJSONを属性として保存
  - pk_kind（pubkey#kind）属性をReplaceableイベント用に生成・保存
  - pk_kind_d（pubkey#kind#d_tag）属性をAddressableイベント用に生成・保存
  - 英字1文字タグの最初の値を個別属性（tag_e, tag_p等）として保存
  - 重複イベント（同一ID）の検出とDuplicate応答
  - Replaceableイベントの条件付き書き込み（created_at比較）
  - Addressableイベントの条件付き書き込み（pk_kind_d + created_at比較）
  - GSI-PubkeyCreatedAtを使用したauthorsフィルタークエリ
  - GSI-KindCreatedAtを使用したkindsフィルタークエリ
  - GSI-PkKindを使用したReplaceableイベント検索
  - GSI-PkKindDを使用したAddressableイベント検索
  - タグフィルター（#e, #p）はテーブルスキャン+アプリケーション層フィルタリングで実装
  - created_at降順、同一タイムスタンプはid辞書順でソート
  - limit指定時の結果件数制限
  - DynamoDB書き込み失敗時のエラーハンドリング
  - _Requirements: 8.10, 9.1, 10.2, 10.3, 10.4, 12.2, 12.3, 13.1, 13.2, 13.3, 13.4, 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.8_

## Task 4: Application Layer Implementation

- [ ] 4.1 メッセージパーサー実装
  - 受信したWebSocketメッセージをJSONとしてパース
  - JSON配列形式であることを検証
  - 配列の先頭要素からメッセージタイプ（EVENT, REQ, CLOSE）を識別
  - EVENTメッセージ：第2要素をイベントJSONとして抽出
  - REQメッセージ：第2要素をsubscription_id、第3要素以降をフィルター配列として抽出
  - CLOSEメッセージ：第2要素をsubscription_idとして抽出
  - subscription_idが1-64文字の非空文字列であることを検証
  - パース失敗時の適切なエラーメッセージ生成
  - 不明なメッセージタイプへのエラー応答
  - _Requirements: 5.1, 6.1, 6.6, 6.7, 7.1, 15.1, 15.2, 15.3_

- [ ] 4.2 イベントハンドラー実装
  - EVENTメッセージを受信してイベント検証を実行
  - Kind分類を行いイベント種別を判定
  - Regularイベント：検証後にリポジトリへ保存
  - Replaceableイベント：同一pubkey+kindの最新イベントのみ保持
  - Ephemeralイベント：保存せずに購読者への配信のみ実行
  - Addressableイベント：同一pubkey+kind+d_tagの最新イベントのみ保持
  - 保存成功時にOK成功応答を生成
  - 重複イベント時にOK重複応答を生成
  - 検証失敗時にOKエラー応答（invalid:プレフィックス）を生成
  - 保存失敗時にOKエラー応答（error:プレフィックス）を生成
  - 新イベント受信時にマッチするサブスクリプションを検索
  - マッチした購読者へイベントを配信
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 9.1, 10.1, 10.2, 10.3, 11.1, 11.2, 12.1, 12.2, 12.3_

- [ ] 4.3 サブスクリプションハンドラー実装
  - REQメッセージを受信してサブスクリプションを作成
  - subscription_idの長さ検証（1-64文字）
  - フィルター条件をパースして検証
  - 同一subscription_idの既存サブスクリプションを置換
  - フィルターに合致する保存済みイベントをリポジトリからクエリ
  - 取得したイベントを順次EVENT応答として送信
  - 全イベント送信後にEOSE応答を送信
  - CLOSEメッセージを受信してサブスクリプションを停止
  - サブスクリプション停止後はイベント配信を行わない
  - 無効なsubscription_id時にCLOSED応答（invalid:プレフィックス）を生成
  - リポジトリエラー時にCLOSED応答（error:プレフィックス）を生成
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 7.1, 7.2_

## Task 5: Lambda Handler Integration

- [ ] 5.1 接続ハンドラー統合
  - $connectルートでLambdaが呼び出された際の処理を実装
  - API Gateway WebSocketイベントからconnectionIdを取得
  - リクエストコンテキストからエンドポイントURLを構築
  - ConnectionRepositoryを使用して接続情報を保存
  - 成功時に200 OKを返却
  - エラー時にログ出力して500エラーを返却
  - _Requirements: 1.1, 17.1, 17.2_

- [ ] 5.2 切断ハンドラー統合
  - $disconnectルートでLambdaが呼び出された際の処理を実装
  - connectionIdに関連する全サブスクリプションを削除
  - connectionIdの接続レコードを削除
  - エラー発生時もログ出力のみで200 OKを返却（クリーンアップ処理のため）
  - _Requirements: 1.2, 1.3, 17.3, 18.5_

- [ ] 5.3 デフォルトハンドラー統合
  - $defaultルートでLambdaが呼び出された際の処理を実装
  - メッセージパーサーでWebSocketメッセージをパース
  - EVENTメッセージの場合はイベントハンドラーに委譲
  - REQメッセージの場合はサブスクリプションハンドラーに委譲
  - CLOSEメッセージの場合はサブスクリプションハンドラーに委譲
  - パースエラー時はNOTICE応答を送信
  - 各ハンドラーの応答をWebSocket経由でクライアントに送信
  - _Requirements: 5.1, 6.1, 7.1, 14.4, 15.1, 15.2, 15.3_

## Task 6: Unit Tests

- [ ] 6.1 (P) ドメイン層ユニットテスト
  - Kind分類ロジックの境界値テスト（各種別の範囲境界）
  - イベント構造検証の正常系・異常系テスト
  - イベントID検証（SHA256ハッシュ計算）のテスト
  - 署名検証の正常系・異常系テスト
  - フィルター評価の各条件（ids, authors, kinds, tags, since, until）テスト
  - フィルターAND/OR評価のテスト
  - RelayMessage各種のJSON変換テスト
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 3.1, 4.1, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.8, 8.9, 9.1, 10.1, 11.1, 12.1, 14.1, 14.2, 14.3, 14.4_

- [ ] 6.2 (P) アプリケーション層ユニットテスト
  - メッセージパーサーのEVENT/REQ/CLOSEパーステスト
  - 不正JSONへのエラーハンドリングテスト
  - 不明メッセージタイプへのエラーハンドリングテスト
  - subscription_id検証テスト
  - _Requirements: 5.1, 6.1, 6.6, 6.7, 7.1, 15.1, 15.2, 15.3_

## Task 7: Integration Tests

- [ ] 7.1 リポジトリ統合テスト
  - EventRepository: イベント保存・取得・重複検出
  - EventRepository: Replaceable/Addressableイベントの条件付き書き込み
  - EventRepository: 各種GSIを使用したクエリ
  - ConnectionRepository: 接続情報のCRUD
  - SubscriptionRepository: サブスクリプションのCRUD・一括削除
  - SubscriptionRepository: イベントマッチング検索
  - DynamoDB Local または AWS実環境での動作確認
  - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.8, 17.1, 17.2, 17.3, 17.4, 17.5, 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8_

- [ ] 7.2 ハンドラー統合テスト
  - イベントハンドラー: 各Kind別イベントの処理フロー
  - イベントハンドラー: 購読者へのイベント配信
  - サブスクリプションハンドラー: REQ→EVENT→EOSEフロー
  - サブスクリプションハンドラー: CLOSEによる購読停止
  - モックリポジトリを使用した単体での動作確認
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 6.3, 6.4, 6.5, 7.1, 7.2, 9.1, 10.1, 10.2, 10.3, 10.4, 11.1, 11.2, 12.1, 12.2, 12.3_

## Task 8: End-to-End Tests

- [ ] 8.1 WebSocket E2Eテスト
  - WebSocket接続確立の動作確認
  - EVENT送信→OK応答の受信確認
  - REQ送信→EVENT→EOSE応答の受信確認
  - CLOSE送信後のイベント非配信確認
  - 接続切断時のサブスクリプションクリーンアップ確認
  - 不正メッセージへのNOTICE応答確認
  - ローカルまたはステージング環境での動作確認
  - _Requirements: 1.1, 1.2, 1.3, 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 6.3, 6.4, 6.5, 7.1, 7.2, 14.1, 14.2, 14.3, 14.4, 15.1, 15.2, 15.3_
