# Implementation Plan

## Tasks

- [x] 1. ドメインモデルの実装
- [x] 1.1 (P) NIP-11レスポンス構造体を実装する
  - リレー情報を表現する値オブジェクトを作成
  - 基本フィールド（name, description, pubkey, contact, software, version, icon, banner）を定義
  - サポートNIP番号配列とバージョン情報の固定値を設定
  - JSON シリアライズで未設定フィールドを省略する仕組みを組み込む
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9_

- [x] 1.2 (P) リレー制限情報モデルを実装する
  - 制限情報を表現する構造体を作成
  - max_subid_length（64固定）を含める
  - 未実装の制限値は含めない設計とする
  - _Requirements: 4.1, 4.2, 4.3_

- [x] 1.3 (P) コミュニティ・ロケール情報をモデルに追加する
  - relay_countries（ISO 3166-1 alpha-2国コード配列）をモデルに含める
  - language_tags（IETF言語タグ配列）をモデルに含める
  - 空配列の場合はJSONから省略する動作を実装
  - _Requirements: 7.1, 7.2_

- [x] 2. インフラ層設定コンポーネントの実装
- [x] 2.1 (P) 環境変数からリレー設定を読み込むコンポーネントを実装する
  - 基本情報（RELAY_NAME, RELAY_DESCRIPTION, RELAY_PUBKEY, RELAY_CONTACT）の読み込み
  - メディア情報（RELAY_ICON, RELAY_BANNER）の読み込み
  - 未設定のオプションフィールドはNoneとして扱う
  - pubkeyは64文字のhex文字列として検証（設定時のみ）
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

- [x] 2.2 (P) ロケール設定の環境変数読み込みを実装する
  - RELAY_COUNTRIES（カンマ区切り）のパースと配列化
  - RELAY_LANGUAGE_TAGS（カンマ区切り）のパースと配列化
  - デフォルト値として「JP」と「ja」を設定可能にする
  - _Requirements: 7.3, 7.4, 7.5_

- [ ] 3. アプリケーション層ハンドラーの実装
- [x] 3.1 NIP-11レスポンス生成ハンドラーを実装する
  - 設定コンポーネントからリレー情報を取得
  - NIP-11仕様に準拠したJSONレスポンスを構築
  - supported_nips配列に現在実装済みのNIP番号（1, 11）を含める
  - software URLとversionをコンパイル時定数から取得
  - 依存: タスク1, タスク2の完了が必要
  - _Requirements: 1.1, 1.3, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 4.1, 4.2, 4.3, 7.1, 7.2_

- [ ] 3.2 GETレスポンスにCORSヘッダーを付与する機能を実装する
  - Access-Control-Allow-Origin: * をレスポンスに追加
  - Access-Control-Allow-Headers: Accept をレスポンスに追加
  - Access-Control-Allow-Methods: GET, OPTIONS をレスポンスに追加
  - Content-Type: application/nostr+json をレスポンスに設定
  - _Requirements: 3.1, 3.2, 3.3_

- [ ] 4. Lambda関数エントリポイントの実装
- [ ] 4.1 NIP-11用HTTP Lambda関数を実装する
  - lambda_httpクレートを依存関係に追加
  - Lambda Function URL経由のHTTPリクエストを処理
  - ハンドラーコンポーネントを呼び出してレスポンスを生成
  - 構造化ログを出力（tracingクレート使用）
  - 依存: タスク3の完了が必要
  - _Requirements: 1.1, 1.3, 6.2_

- [ ] 5. Lambda@Edgeルーターの実装
- [ ] 5.1 (P) JavaScriptでLambda@Edge関数を実装する
  - edge-router用の新規ディレクトリを作成（terraform/modules/api/edge-router/）
  - Acceptヘッダーを検査してapplication/nostr+jsonを検出
  - NIP-11リクエスト検出時にNIP-11オリジンへルーティング
  - その他のリクエストはWebSocket API Gatewayへ転送
  - _Requirements: 1.1, 1.2, 6.1_

- [ ] 5.2 (P) CORSプリフライトリクエストをエッジで処理する
  - OPTIONSメソッド検出時に直接レスポンスを生成（オリジン転送なし）
  - Access-Control-Allow-Origin, Allow-Methods, Allow-Headers, Max-Ageヘッダーを付与
  - 200 OKステータスで応答
  - _Requirements: 3.4_

- [ ] 5.3 (P) Lambda@Edge関数のユニットテストを実装する
  - OPTIONSリクエストでCORS応答が返ることを検証
  - Accept: application/nostr+jsonでオリジン切り替えを検証
  - WebSocket Upgradeヘッダーでデフォルトオリジン維持を検証

- [ ] 6. Terraformインフラ構築
- [ ] 6.1 NIP-11 Lambda関数とFunction URLのTerraformリソースを定義する
  - Lambda関数リソース（nostr_relay_nip11_info）を作成
  - 環境変数でリレー設定を注入
  - Lambda Function URL（AWS_IAM認証）を作成
  - CloudFront OAC（Origin Access Control）を設定
  - 依存: タスク4の実装完了後にデプロイ可能
  - _Requirements: 6.2, 6.3_

- [ ] 6.2 CloudFront Distributionを構築する
  - relay.nostr.nisshiee.org用のCloudFront Distributionを作成
  - デフォルトオリジンとしてWebSocket API Gatewayを設定
  - NIP-11オリジンとしてLambda Function URLを設定
  - WebSocket接続のためのキャッシュビヘイビアを設定（キャッシュ無効化、全ヘッダー転送）
  - Lambda@EdgeをViewer Requestに関連付け
  - _Requirements: 6.1, 6.3_

- [ ] 6.3 Lambda@EdgeをTerraformで定義する
  - us-east-1リージョンにLambda@Edge関数をデプロイ
  - aws providerのaliasでリージョン指定
  - templatefile関数でNIP-11 Function URLドメインを埋め込み
  - CloudFrontとの関連付けを設定
  - _Requirements: 6.1_

- [ ] 6.4 DNSをCloudFrontに移行する
  - Route53のrelay.nostr.nisshiee.orgレコードをCloudFrontに向ける
  - 既存のAPI Gateway直接参照からCloudFront経由に変更
  - ACM証明書の関連付け（us-east-1リージョン）
  - _Requirements: 6.1_

- [ ] 7. 統合テストと検証
- [ ] 7.1 Rustユニットテストを実装する
  - RelayInfoConfigの環境変数読み込みテスト
  - RelayInfoDocumentのJSONシリアライズテスト（NIP-11準拠確認）
  - Nip11HandlerのレスポンスとCORSヘッダーテスト
  - カンマ区切り値のパーステスト
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 7.1, 7.2, 7.3, 7.4, 7.5_

- [ ] 7.2 E2E手動テストを実施する
  - CORSプリフライト確認: curl -X OPTIONS https://relay.nostr.nisshiee.org/
  - NIP-11リクエスト確認: curl -H "Accept: application/nostr+json" https://relay.nostr.nisshiee.org/
  - WebSocket接続回帰テスト: websocat wss://relay.nostr.nisshiee.org
  - レスポンスのContent-TypeとCORSヘッダーを検証
  - _Requirements: 1.1, 1.2, 1.3, 3.1, 3.2, 3.3, 3.4_
