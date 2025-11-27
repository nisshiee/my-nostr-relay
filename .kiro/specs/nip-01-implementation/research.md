# Research & Design Decisions: NIP-01 Implementation

## Summary

- **Feature**: `nip-01-implementation`
- **Discovery Scope**: Complex Integration
- **Key Findings**:
  - `nostr` crate (v0.44.x) はイベントモデル、署名検証、フィルター評価に適しており、カスタム実装を大幅に削減できる
  - DynamoDBシングルテーブル設計はイベントテーブルに適用、接続/サブスクリプションは分離テーブルが適切
  - AWS SDK for Rust (GA済み) により、DynamoDB操作とAPI Gateway Management APIが型安全に利用可能

## Research Log

### nostr crate 調査

- **Context**: イベントモデル、署名検証、フィルター評価を自前実装するか既存crateを使用するか
- **Sources Consulted**:
  - [docs.rs/nostr](https://docs.rs/nostr/latest/nostr/) - APIドキュメント
  - [rust-nostr/nostr GitHub](https://github.com/rust-nostr/nostr) - リポジトリ
  - [rust-nostr.org](https://rust-nostr.org/sdk/messages/filters.html) - フィルタードキュメント
- **Findings**:
  - バージョン 0.44.x が最新、ALPHAステータスだがAPIは安定
  - `Event` 構造体が NIP-01 準拠のすべてのフィールドを持つ
  - `Event::verify()` でID検証と署名検証を一括実行可能
  - `Filter` 構造体でフィルター条件を表現、マッチング機能あり
  - secp256k1 Schnorr署名は内部で処理される
  - no_std対応あり（Lambda環境では不要）
- **Implications**:
  - イベント検証ロジックの自前実装が不要
  - JSONシリアライズルール（エスケープ等）もcrate側で処理
  - フィルター評価ロジックを再利用可能

### AWS SDK for Rust 調査

- **Context**: DynamoDB操作とWebSocket送信のSDK選定
- **Sources Consulted**:
  - [crates.io/aws-sdk-dynamodb](https://crates.io/crates/aws-sdk-dynamodb)
  - [docs.rs/aws-sdk-apigatewaymanagement](https://docs.rs/aws-sdk-apigatewaymanagement)
  - [AWS SDK for Rust GA発表](https://aws.amazon.com/blogs/developer/announcing-general-availability-of-the-aws-sdk-for-rust/)
- **Findings**:
  - AWS SDK for Rustは2024年にGAリリース済み
  - `aws-sdk-dynamodb` 1.x 系が安定版
  - `aws-sdk-apigatewaymanagement` で `post_to_connection` が利用可能
  - 非同期API、tokioランタイム推奨
  - `aws-config` で環境変数からクレデンシャル自動読み込み
- **Implications**:
  - 型安全なDynamoDB操作が可能
  - Lambda環境でのクレデンシャル管理は自動

### DynamoDB テーブル設計調査

- **Context**: イベント、接続、サブスクリプションの最適なテーブル設計
- **Sources Consulted**:
  - [AWS Compute Blog - Single Table Design](https://aws.amazon.com/blogs/compute/creating-a-single-table-design-with-amazon-dynamodb/)
  - [Alex DeBrie - Single Table Design](https://www.alexdebrie.com/posts/dynamodb-single-table/)
  - [Serverless Life - DynamoDB Design Patterns](https://www.serverlesslife.com/DynamoDB_Design_Patterns_for_Single_Table_Design.html)
- **Findings**:
  - シングルテーブル設計は同一エンティティ内の複数アクセスパターンに有効
  - GSIは最大20個まで、ストレージオーバーヘッドあり
  - スパースインデックスで特定属性を持つアイテムのみインデックス可能
  - フィルターはQuery後に適用されるため、大量データには不向き
  - 強い整合性読み取りはGSIでは利用不可
- **Implications**:
  - イベントテーブルは複数のGSIで様々なフィルターパターンに対応
  - 接続・サブスクリプションは独立テーブルが管理しやすい
  - タグインデックスはスパースGSIで実装

### WebSocket Lambda統合調査

- **Context**: API Gateway WebSocketとLambdaの統合パターン
- **Sources Consulted**:
  - [AWS Blog - Announcing WebSocket APIs](https://aws.amazon.com/blogs/compute/announcing-websocket-apis-in-amazon-api-gateway/)
  - [dfrasca.hashnode.dev - Rust WebSocket](https://dfrasca.hashnode.dev/project-doorbell-how-to-use-amazon-api-gateway-websocket-apis-with-rust)
- **Findings**:
  - `lambda-http` crateはWebSocketイベントを直接サポートしない
  - カスタム構造体でWebSocketイベントをデシリアライズ必要
  - connectionIdはリクエストコンテキストから取得
  - postToConnection時の410 GONEハンドリングが重要
  - エンドポイントURLは `https://{api-id}.execute-api.{region}.amazonaws.com/{stage}` 形式
- **Implications**:
  - WebSocketイベント用のカスタムデシリアライズ構造体を実装
  - 接続切れ検出と適切なクリーンアップ処理が必要

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Layered + Repository | Lambda→Service→Repository の3層構造 | 関心の分離、テスト容易性 | 層間のデータ変換オーバーヘッド | 選択 |
| Hexagonal | Ports & Adaptersパターン | 外部依存の完全な抽象化 | オーバーエンジニアリングの恐れ | 将来検討 |
| Transaction Script | Lambda関数ごとに全ロジック記述 | シンプル、初期実装高速 | コード重複、保守性低下 | 不採用 |

**選択理由**: Layered + Repository パターンは、既存のLambda関数構造（connect/disconnect/default）を維持しつつ、ドメインロジックとインフラストラクチャを分離できる。将来的なテスト追加や機能拡張にも対応しやすい。

## Design Decisions

### Decision: nostr crate 採用

- **Context**: イベント検証（構造、ID、署名）とフィルター評価の実装方法
- **Alternatives Considered**:
  1. 完全自前実装 - secp256k1-zkp crate + 手動JSON処理
  2. nostr crate 採用 - 検証・フィルター機能を再利用
  3. nostr-sdk 採用 - 高レベルクライアント機能込み
- **Selected Approach**: nostr crate (v0.44.x) を採用
- **Rationale**:
  - NIP-01準拠のイベント構造とシリアライズルールが実装済み
  - Schnorr署名検証が内蔵
  - フィルター評価ロジックを再利用可能
  - nostr-sdkよりも低レベルでRelay実装に適切
- **Trade-offs**:
  - ALPHAステータスのため、将来のAPI変更リスクあり
  - crate依存が増加
- **Follow-up**: バージョンアップ時のAPI変更を監視

### Decision: 3テーブル設計

- **Context**: DynamoDBのテーブル構成
- **Alternatives Considered**:
  1. 完全シングルテーブル - 全エンティティを1テーブル
  2. 3テーブル分離 - Events, Connections, Subscriptions
  3. 2テーブル - Events + ConnectionsWithSubscriptions
- **Selected Approach**: 3テーブル分離
- **Rationale**:
  - イベントテーブルは長期保存、接続/サブスクリプションは一時的データ
  - 接続テーブルにTTLを設定して孤立レコードを自動削除
  - サブスクリプションテーブルは接続IDでパーティション分割
  - 異なるスケーリング特性に対応
- **Trade-offs**:
  - テーブル間の整合性は結果整合
  - Terraform設定が複雑化
- **Follow-up**: 接続切断時のサブスクリプション削除の信頼性確認

### Decision: タグインデックス戦略

- **Context**: #e, #p, #a等のタグフィルターをDynamoDBでどう実現するか
- **Alternatives Considered**:
  1. 全タグを別テーブルに保存 - tag_name, tag_value, event_id
  2. よく使うタグを個別属性としてGSI化
  3. 全タグをスキャンで評価
- **Selected Approach**: よく使うタグ（a-z, A-Z の1文字タグ）を個別属性としてGSI化
- **Rationale**:
  - NIP-01で「英字1文字タグをインデックスすべき」と規定
  - スパースGSIにより、該当タグを持つイベントのみインデックス
  - tag_e, tag_p 等の属性名で保存
- **Trade-offs**:
  - GSI数の制限（最大20）に注意
  - 複合タグフィルターはアプリケーション層で評価
- **Follow-up**: 実際の使用パターンに基づいてGSI追加を検討

### Decision: サブスクリプションマッチング戦略

- **Context**: 新イベント受信時に、どのサブスクリプションに配信するか
- **Alternatives Considered**:
  1. 全サブスクリプションをスキャン
  2. KindベースGSIで候補を絞り込み
  3. メモリ内キャッシュ（Lambda間で共有不可）
- **Selected Approach**: KindベースGSIで候補を絞り込み、アプリ層でフィルター評価
- **Rationale**:
  - Kindは最も選択性が高いフィルター条件
  - GSIクエリで候補を100-1000件程度に絞り込み
  - 残りのフィルター条件はメモリ上で評価
- **Trade-offs**:
  - Kind指定なしのサブスクリプションは効率低下
  - 大量サブスクリプション時のスケーラビリティ課題
- **Follow-up**: サブスクリプション数の監視とスケーリング戦略の検討

## Risks & Mitigations

- **nostr crate API変更リスク** - Cargo.tomlでバージョン固定、定期的なアップデート確認
- **DynamoDB GSI数制限** - 初期は必要最小限のGSI、使用パターン分析後に追加
- **サブスクリプションマッチング性能** - Kind-GSIによる絞り込み、必要に応じてElastiCache導入検討
- **接続切断時のクリーンアップ漏れ** - TTLによる自動削除でフォールバック
- **Lambda cold start** - Rustによる高速起動、Provisioned Concurrency検討

## References

- [NIP-01 Specification](https://github.com/nostr-protocol/nips/blob/master/01.md) - ローカル `nips/01.md`
- [nostr crate documentation](https://docs.rs/nostr/latest/nostr/)
- [rust-nostr GitHub](https://github.com/rust-nostr/nostr)
- [AWS SDK for Rust - DynamoDB](https://docs.aws.amazon.com/sdk-for-rust/latest/dg/rust_dynamodb_code_examples.html)
- [AWS SDK for Rust - API Gateway Management](https://docs.aws.amazon.com/sdk-for-rust/latest/dg/rust_apigatewaymanagementapi_code_examples.html)
- [DynamoDB Single Table Design](https://aws.amazon.com/blogs/compute/creating-a-single-table-design-with-amazon-dynamodb/)
