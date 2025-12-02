# Research & Design Decisions

## Summary

- **Feature**: opensearch-req-processing
- **Discovery Scope**: Complex Integration
- **Key Findings**:
  - opensearch crate v2.3.0がAWS SigV4認証をサポート（aws-auth feature）
  - AWS OpenSearch Service t3.small.searchは無料枠（750時間/月）で利用可能
  - DynamoDB StreamsからOpenSearchへのインデックス処理はLambdaベースが標準パターン

## Research Log

### OpenSearch Rust Client調査

- **Context**: RustからAWS OpenSearch Serviceに接続するためのクライアントライブラリ選定
- **Sources Consulted**:
  - [opensearch crate documentation](https://docs.rs/opensearch/latest/opensearch/)
  - [OpenSearch Rust client documentation](https://docs.opensearch.org/latest/clients/rust/)
  - [AWS SigV4 support for OpenSearch clients](https://opensearch.org/blog/aws-sigv4-support-for-clients/)
- **Findings**:
  - opensearch crate v2.3.0が最新、OpenSearch 2.x/1.x互換
  - `aws-auth` featureでAWS SigV4署名をサポート
  - aws-configから認証情報を取得、TransportBuilder.auth()で設定
  - service_name: "es"（マネージドOpenSearch）または "aoss"（Serverless）
- **Implications**: opensearch = { version = "2.3", features = ["aws-auth"] }を依存関係に追加

### AWS OpenSearch Service無料枠調査

- **Context**: コスト最適化のため無料枠利用可能なインスタンスタイプを確認
- **Sources Consulted**:
  - [Amazon OpenSearch Service Pricing](https://aws.amazon.com/opensearch-service/pricing/)
  - [AWS re:Post - free tier for OpenSearch](https://repost.aws/questions/QUmz4BwQuRTlaxaRmLSUawkQ/is-there-anything-resembling-a-free-tier-for-opensearch)
- **Findings**:
  - t2.small.searchまたはt3.small.searchが無料枠対象
  - 750時間/月（1ノード常時稼働可能）
  - EBSストレージ10GB/月も無料枠
  - コンソールでInstance Family: "General Purpose"を選択する必要あり
- **Implications**: t3.small.search、シングルノード、EBS gp3 10GBで設計

### DynamoDB Streams to OpenSearch パターン調査

- **Context**: DynamoDBの変更をOpenSearchに同期するアーキテクチャパターン
- **Sources Consulted**:
  - [AWS Documentation: Loading streaming data from DynamoDB](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/integrations-dynamodb.html)
  - [Instil Blog: Building an OpenSearch Index from DynamoDB](https://instil.co/blog/opensearch-with-dynamodb/)
  - [AWS Solutions Library: Real-Time Text Search](https://github.com/aws-solutions-library-samples/guidance-for-real-time-text-search-using-amazon-opensearch-service)
- **Findings**:
  - Lambda関数でDynamoDB Streamsをトリガー
  - Stream View Type: NEW_AND_OLD_IMAGES推奨
  - INSERT/MODIFY → PUT（upsert）、REMOVE → DELETE
  - 同期遅延: 通常3秒以内
  - DynamoDB StreamsはシャードあたりMax 2コンシューマ
  - バッチ処理で効率化（batch_size設定）
- **Implications**: indexer Lambda関数を新規作成、NEW_AND_OLD_IMAGES、batch_size=100

### OpenSearch Query DSL調査

- **Context**: NIP-01フィルター条件をOpenSearchクエリに変換するための構文調査
- **Sources Consulted**:
  - [OpenSearch Query DSL Documentation](https://docs.opensearch.org/latest/query-dsl/)
  - [OpenSearch Boolean queries](https://docs.opensearch.org/latest/query-dsl/compound/bool/)
- **Findings**:
  - bool query: must（AND）、should（OR）、filter（スコアなしAND）
  - terms query: 複数値の完全一致
  - prefix query: 前方一致
  - range query: 範囲検索（gte、lte）
  - filter句はスコア計算なし（パフォーマンス向上）
- **Implications**: FilterToQueryConverterでbool query + filter句を使用

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| DynamoDB直接クエリ | GSIを使用した検索 | シンプル、追加インフラ不要 | 複雑なフィルター不可、スキャン必要 | 現状のアプローチ |
| OpenSearch | 検索エンジン使用 | 高速検索、複雑なクエリ対応 | 追加コスト、同期遅延 | **採用** |
| OpenSearch Serverless | サーバーレス版 | 自動スケール | 無料枠なし、コスト高 | 却下 |

**採用理由**: OpenSearch Serviceマネージド版はt3.small.searchで無料枠を活用でき、NIP-01の複雑なフィルター条件を効率的に処理可能。

## Design Decisions

### Decision: OpenSearch Serviceマネージド版の採用

- **Context**: コスト効率とパフォーマンスのバランス
- **Alternatives Considered**:
  1. OpenSearch Serverless - 自動スケールだが無料枠なし
  2. Self-managed OpenSearch on EC2 - 運用負担大
  3. DynamoDB GSI拡張 - 複雑なフィルター対応困難
- **Selected Approach**: AWS OpenSearch Service t3.small.search
- **Rationale**: 無料枠（750時間/月）を活用し、低コストで運用開始可能
- **Trade-offs**: シングルノードのため可用性は限定的（障害時は検索不可）
- **Follow-up**: 利用量増加時のインスタンスタイプ変更手順を文書化

### Decision: DynamoDB Streams + Lambda による同期

- **Context**: DynamoDBからOpenSearchへのデータ同期方式
- **Alternatives Considered**:
  1. アプリケーション層での二重書き込み - 一貫性リスク
  2. EventBridge Pipes - 新しい機能、設定複雑
  3. DynamoDB Streams + Lambda - 標準パターン
- **Selected Approach**: DynamoDB Streams + Lambda
- **Rationale**: AWSの標準パターン、信頼性高い、ドキュメント豊富
- **Trade-offs**: Lambda関数の追加管理、最大3秒の同期遅延
- **Follow-up**: Lambda同時実行数の監視

### Decision: EventRepositoryトレイトの維持

- **Context**: 既存コードとの互換性維持
- **Alternatives Considered**:
  1. 新しいSearchRepository traitを作成
  2. EventRepositoryを拡張してOpenSearch専用メソッド追加
  3. EventRepositoryトレイトを維持しOpenSearch実装を追加
- **Selected Approach**: EventRepositoryトレイトを維持
- **Rationale**: SubscriptionHandlerの変更最小化、テストコードの再利用可能
- **Trade-offs**: save()とget_by_id()は未実装（DynamoEventRepository継続使用）
- **Follow-up**: 将来的なリファクタリングでComposite Repository Pattern検討

## Risks & Mitigations

- **OpenSearch障害時の検索不可** - CLOSEDメッセージで通知、DynamoDBフォールバックは非対応（設計決定）
- **同期遅延（最大3秒）** - ユーザー許容範囲内、リアルタイム性は新規イベント通知で確保
- **インデックス肥大化** - 10GB EBS制限、古いイベントのアーカイブ戦略は将来課題
- **Lambda同時実行数超過** - reserved concurrencyの設定検討

## References

- [opensearch crate documentation](https://docs.rs/opensearch/latest/opensearch/) - Rust OpenSearchクライアント
- [Amazon OpenSearch Service Pricing](https://aws.amazon.com/opensearch-service/pricing/) - 料金と無料枠
- [AWS Documentation: Loading streaming data from DynamoDB](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/integrations-dynamodb.html) - 公式統合ガイド
- [OpenSearch Query DSL](https://docs.opensearch.org/latest/query-dsl/) - クエリ構文リファレンス
