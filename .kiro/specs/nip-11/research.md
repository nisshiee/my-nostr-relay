# Research & Design Decisions

---
**Purpose**: NIP-11実装のためのディスカバリー結果とアーキテクチャ決定の記録
**Discovery Scope**: Complex Integration（新規HTTPエンドポイント + 既存WebSocketインフラとの統合）
---

## Summary

- **Feature**: `nip-11`
- **Discovery Scope**: Complex Integration
- **Key Findings**:
  1. AWS API Gateway WebSocketとHTTP APIは同一カスタムドメインで共存不可
  2. CloudFront + Lambda@Edgeによるヘッダーベースルーティングが最適解
  3. Lambda Function URLをHTTPオリジンとして使用することで実装を簡素化

## Research Log

### AWS API Gateway カスタムドメイン制約

- **Context**: NIP-11はWebSocketとHTTPを同一URIで提供することを要求。既存WebSocket API Gatewayの`relay.nostr.nisshiee.org`で直接HTTP対応が可能か調査。
- **Sources Consulted**:
  - [AWS API Gateway WebSocket Custom Domains](https://docs.aws.amazon.com/apigateway/latest/developerguide/websocket-api-custom-domain-names.html)
  - [Stack Overflow - Mixing REST and HTTP APIs on same domain](https://stackoverflow.com/questions/66892050/api-gateway-mixing-of-rest-apis-and-http-apis-on-the-same-domain-name-can-only)
- **Findings**:
  - WebSocket APIはHTTP APIやREST APIと同一カスタムドメインを共有できない
  - WebSocket APIは他のWebSocket APIとのみ同一ドメインで共存可能
  - Regional カスタムドメインのみWebSocket APIでサポート
- **Implications**: API Gateway単体ではNIP-11要件を満たせない。CloudFront等の前段レイヤーが必要。

### CloudFront + Lambda@Edge によるルーティング

- **Context**: 同一ドメインでWebSocketとHTTPを提供するためのアーキテクチャパターンを調査。
- **Sources Consulted**:
  - [AWS Blog - Dynamically Route Viewer Requests to Any Origin Using Lambda@Edge](https://aws.amazon.com/blogs/networking-and-content-delivery/dynamically-route-viewer-requests-to-any-origin-using-lambdaedge/)
  - [Medium - WebSocket API + CloudFront Function](https://medium.com/@lancers/amazon-api-gateway-websocket-api-cloudfront-function-ab304fd95ac3)
  - [CloudFront WebSocket Support](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.websockets.html)
- **Findings**:
  - CloudFrontは複数オリジン（WebSocket API Gateway + HTTP/Lambda）を単一ドメインで提供可能
  - Lambda@Edge（Origin Request）でヘッダーに基づく動的オリジン選択が可能
  - CloudFront Functionではオリジン選択不可、Viewer Request段階で直接レスポンス生成は可能
  - WebSocketには`Sec-WebSocket-Key`, `Sec-WebSocket-Version`等のヘッダー転送が必須
- **Implications**: CloudFront + Lambda@Edge (または Origin Lambda) による構成が最適。

### Lambda Function URL (OAC対応)

- **Context**: NIP-11用HTTPエンドポイントとしてのLambda Function URLの適合性を調査。
- **Sources Consulted**:
  - [AWS Blog - Secure Lambda Function URLs using CloudFront OAC](https://aws.amazon.com/blogs/networking-and-content-delivery/secure-your-lambda-function-urls-using-amazon-cloudfront-origin-access-control/)
  - [AWS Announcement - CloudFront OAC for Lambda URLs (April 2024)](https://aws.amazon.com/about-aws/whats-new/2024/04/amazon-cloudfront-oac-lambda-function-url-origins/)
- **Findings**:
  - Lambda Function URLは最大15分のタイムアウト（API Gatewayの30秒を大幅超過）
  - 2024年4月よりCloudFront OAC対応、IAM認証でセキュアなアクセス制御可能
  - `AllViewerExceptHostHeader`ポリシーの使用が推奨
  - POST/PUTには署名付きペイロードが必要（NIP-11はGET/OPTIONSのみなので問題なし）
- **Implications**: Lambda Function URLはNIP-11に最適。シンプルで低コスト。

### Rust Lambda HTTP レスポンス形式

- **Context**: NIP-11 Lambda関数のCORS対応とレスポンス形式を調査。
- **Sources Consulted**:
  - [AWS Lambda Rust Runtime - lambda_http](https://crates.io/crates/lambda_http)
  - [GitHub - aws-lambda-rust-runtime response.rs](https://github.com/awslabs/aws-lambda-rust-runtime/blob/main/lambda-http/src/response.rs)
  - [AWS Docs - Processing HTTP events with Rust](https://docs.aws.amazon.com/lambda/latest/dg/rust-http-events.html)
- **Findings**:
  - `lambda_http`クレートがHTTP API、REST API、Function URLを統一的に処理
  - `Response::builder()`パターンでヘッダー設定可能
  - CORSヘッダーは手動設定が必要（`Access-Control-Allow-*`系）
  - Function URL使用時は`lambda_http::run`でハンドラー登録
- **Implications**: 既存の`lambda_runtime`に加えて`lambda_http`クレートの追加が必要。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| A. API Gateway HTTP API追加 | WebSocketとは別にHTTP API Gatewayを作成 | 既存パターンとの親和性 | 同一ドメイン不可（NIP-11違反） | 却下 |
| B. CloudFront + Lambda@Edge | CloudFrontでルーティング、Lambda@Edgeでオリジン選択 | 柔軟なルーティング、単一ドメイン | Lambda@Edge追加複雑性、us-east-1デプロイ必須 | 最も堅牢 |
| C. CloudFront + NIP-11 Lambda Function URL | CloudFrontバックエンド、Lambda Function URLをHTTPオリジン | シンプル、低コスト、OAC対応 | パスベースルーティングのみ（ヘッダーベース不可）、CloudFront Function必要 | 採用候補 |
| D. Lambda@Edge直接レスポンス | Viewer RequestでNIP-11レスポンス生成 | 超低レイテンシ | 環境変数使用不可、設定変更にはLambda再デプロイ必要 | 静的設定には有効 |

## Design Decisions

### Decision: CloudFront + Lambda@Edge + Lambda Function URL 構成の採用

- **Context**: NIP-11はWebSocket URIでHTTPリクエストに応答することを要求。AWS API Gatewayの制約により、CloudFront前段配置が必須。
- **Alternatives Considered**:
  1. **Option A**: HTTP API Gateway別ドメイン → NIP-11仕様違反（却下）
  2. **Option B**: Lambda@Edge Origin Request → オリジン選択は可能だがus-east-1デプロイ必須
  3. **Option C**: CloudFront Function + Lambda Function URL → シンプルだがヘッダーベースルーティングに制限
  4. **Option D**: Lambda@Edge Viewer Request直接レスポンス → 設定が静的になる
- **Selected Approach**: **Option B + C の組み合わせ**
  - CloudFrontを`relay.nostr.nisshiee.org`に配置
  - デフォルトビヘイビア → WebSocket API Gateway（既存）
  - Lambda@Edge (Viewer Request) で`Accept: application/nostr+json`検出時にカスタムヘッダー設定
  - Origin RequestでHTTPオリジン（NIP-11 Lambda Function URL）にルーティング
- **Rationale**:
  - NIP-11仕様（同一URI）を完全に満たす
  - 既存WebSocket基盤への影響を最小化
  - Lambda Function URLの15分タイムアウトと低コスト
  - OACによるセキュアなアクセス制御
- **Trade-offs**:
  - Lambda@Edgeはus-east-1リージョンにデプロイ必須
  - CloudFront追加によるインフラ複雑性増加
  - レイテンシは微増（CloudFrontエッジ経由）
- **Follow-up**:
  - CloudFront設定のTerraformモジュール化
  - Lambda@Edge関数のテスト戦略

### Decision: RelayConfig 構造体による設定一元管理

- **Context**: NIP-11応答とハンドラー制限適用で同一の設定値を参照する必要がある。
- **Alternatives Considered**:
  1. 各ハンドラーで個別に環境変数読み込み
  2. 共通Config構造体で一元管理
- **Selected Approach**: `RelayConfig`構造体を`infrastructure`層に追加し、全ハンドラーで共有
- **Rationale**:
  - DRY原則（設定定義の重複回避）
  - テスト容易性（モック可能な設定注入）
  - 型安全性（コンパイル時チェック）
- **Trade-offs**:
  - 構造体フィールド追加時に複数箇所の変更が必要
- **Follow-up**: 環境変数名の命名規則統一

### Decision: 既存ハンドラーへの制限適用は段階的に実装

- **Context**: 要件4では9種類の制限を適用する必要があるが、一度に全て実装するとスコープが大きい。
- **Selected Approach**:
  - Phase 1: NIP-11レスポンス生成 + 基本的な制限（max_message_length, max_subscriptions, max_subid_length）
  - Phase 2: 残りの制限（max_event_tags, max_content_length, created_at_*）
- **Rationale**:
  - NIP-11レスポンスは制限値を報告するだけなので先行実装可能
  - 既存ハンドラーへの変更はテスト範囲が広い
- **Trade-offs**:
  - 一時的にNIP-11報告値と実際の制限が不一致になる可能性

## Risks & Mitigations

- **Risk 1**: CloudFront導入により既存WebSocket接続に影響
  - **Mitigation**: 段階的ロールアウト、WebSocketヘッダー転送設定の事前検証
- **Risk 2**: Lambda@Edge us-east-1デプロイの運用複雑化
  - **Mitigation**: Terraformによる自動化、CI/CDパイプラインにus-east-1対応追加
- **Risk 3**: 環境変数増加による設定管理の煩雑化
  - **Mitigation**: RelayConfig構造体での一元管理、デフォルト値の適切な設定

## References

- [NIP-11 Specification](https://github.com/nostr-protocol/nips/blob/master/11.md) - Relay Information Document仕様
- [AWS CloudFront WebSocket Support](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.websockets.html)
- [Lambda@Edge Dynamic Origin Selection](https://aws.amazon.com/blogs/networking-and-content-delivery/dynamically-route-viewer-requests-to-any-origin-using-lambdaedge/)
- [CloudFront OAC for Lambda Function URLs](https://aws.amazon.com/blogs/networking-and-content-delivery/secure-your-lambda-function-urls-using-amazon-cloudfront-origin-access-control/)
- [lambda_http crate](https://crates.io/crates/lambda_http) - Rust Lambda HTTP処理
