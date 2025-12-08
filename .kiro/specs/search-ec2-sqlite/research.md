# Research & Design Decisions

## Summary
- **Feature**: search-ec2-sqlite
- **Discovery Scope**: Complex Integration
- **Key Findings**:
  - rusqlite (WALモード + synchronous=NORMAL) で高性能なSQLite操作が可能
  - axum 0.8.x で async-trait不要の最新HTTPサーバーを構築可能
  - Caddyでゼロ設定のLet's Encrypt TLS自動化が実現可能
  - tower_governorでtower互換のレート制限を実装可能

## Research Log

### rusqlite WALモード設定

- **Context**: SQLiteの並行読み書き性能を最大化する設定を調査
- **Sources Consulted**:
  - [rusqlite GitHub](https://github.com/rusqlite/rusqlite)
  - [rusqlite Documentation](https://docs.rs/rusqlite/latest/rusqlite/)
  - [SQLite WAL Guide](https://generalistprogrammer.com/tutorials/rusqlite-rust-crate-guide)
- **Findings**:
  - WALモード + synchronous=NORMAL が推奨構成
  - 読み取りと書き込みの並行処理が可能
  - 1つのwriterコネクションと複数のreaderコネクションを使用するパターン
  - 1000トランザクションごとにWALファイルをデータベースに書き戻し
  - rusqliteは SQLite 3.34.1以降をサポート (40M+ downloads)
- **Implications**:
  - t4g.nanoの限られたリソースでも十分なパフォーマンスを発揮可能
  - 単一プロセスでの運用が前提（マルチプロセスは非推奨）

### axum 0.8.x フレームワーク調査

- **Context**: EC2上のHTTP APIサーバー実装に最適なフレームワークを調査
- **Sources Consulted**:
  - [axum 0.8.0 Release Announcement](https://tokio.rs/blog/2025-01-01-announcing-axum-0-8-0)
  - [axum Documentation](https://docs.rs/axum/latest/axum/)
  - [axum GitHub](https://github.com/tokio-rs/axum)
- **Findings**:
  - axum 0.8.7が最新バージョン (2025年1月リリース)
  - パスパラメータ構文が `/:single` から `/{single}` に変更
  - `#[async_trait]` マクロが不要に（Rust native async trait使用）
  - towerミドルウェアをそのまま使用可能
  - 191M+ total downloads で本番実績あり
- **Implications**:
  - プロジェクトの Rust Edition 2024 方針と整合
  - 既存のtracing統合がそのまま適用可能

### Caddy Let's Encrypt 自動化

- **Context**: ゼロ設定でTLS証明書を自動管理できるリバースプロキシを調査
- **Sources Consulted**:
  - [Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https)
  - [Caddy Reverse Proxy Quick-Start](https://caddyserver.com/docs/quick-starts/reverse-proxy)
  - [Caddy TLS On-Demand](https://fivenines.io/blog/caddy-tls-on-demand-complete-guide-to-dynamic-https-with-lets-encrypt/)
- **Findings**:
  - ドメイン名を指定するだけで自動的にLet's Encrypt証明書を取得
  - 証明書の自動更新機能内蔵
  - HTTP-01チャレンジをデフォルトでサポート
  - PCI, HIPAA, NIST準拠のTLSデフォルト設定
  - Nginx/Apacheと異なりCertbot不要
- **Implications**:
  - User Dataで簡単にセットアップ可能
  - 80/tcp (ACME) と 443/tcp (HTTPS) のみSecurity Groupで許可

### tower_governor レート制限

- **Context**: axum互換のレート制限ミドルウェアを調査
- **Sources Consulted**:
  - [tower_governor crate](https://crates.io/crates/tower_governor)
  - [Creating a Rate Limiter Middleware using Tower](https://medium.com/@khalludi123/creating-a-rate-limiter-middleware-using-tower-for-axum-rust-be1d65fbeca)
- **Findings**:
  - governorクレートをバックエンドに使用
  - IPベース、ヘッダーベース、グローバルのキー抽出をサポート
  - Axum、Hyper、Tonicなどtowerベースのフレームワークと互換
  - PeerIpKeyExtractor: ピアIPアドレスを使用
  - SmartIpKeyExtractor: x-forwarded-for等のヘッダーを確認
- **Implications**:
  - Caddyがx-forwarded-forヘッダーを付与するため、SmartIpKeyExtractorを使用

### reqwest 再試行とエクスポネンシャルバックオフ

- **Context**: Lambda から EC2 への HTTP通信で失敗時の再試行戦略を調査
- **Sources Consulted**:
  - [reqwest_retry Documentation](https://docs.rs/reqwest-retry)
  - [backoff crate GitHub](https://github.com/ihrwein/backoff)
  - [Retrying HTTP Requests with Rust](https://tech.stonecharioteer.com/posts/2022/rust-reqwest-retry/)
- **Findings**:
  - reqwest_retry + reqwest_middleware で透過的な再試行が可能
  - ExponentialBackoff::builder().build_with_max_retries(3) でカスタマイズ
  - RetryTransientMiddleware で一時的エラーのみ再試行
  - Retry-Afterヘッダーを尊重する実装が可能
- **Implications**:
  - IndexerClientで指数バックオフ再試行を実装
  - 429/503エラー時の適切な待機

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| EC2 + SQLite | 単一EC2でSQLiteを運用 | 低コスト、シンプル、WALで並行処理 | 単一障害点、垂直スケールのみ | **採用** - コスト目標達成 |
| EFS + Lambda | LambdaからEFSマウントのSQLite | サーバーレス維持 | VPC Endpoint費用（月2,000円） | コスト超過で不採用 |
| DynamoDB GSI | GSI拡充でクエリ最適化 | マネージド、スケーラブル | フルスキャン頻発、複雑なフィルタ非対応 | 技術的制約で不採用 |
| Turso (libSQL) | 外部ホスティングSQLite | Free Tier、エッジ対応 | 外部依存、ベンダーロックイン | 将来検討の余地あり |

## Design Decisions

### Decision: HTTP APIサーバーのフレームワーク選定

- **Context**: EC2上で動作するRust HTTPサーバーの技術選定
- **Alternatives Considered**:
  1. actix-web — 高性能だが学習コストが高い
  2. warp — 型安全だがフィルターパターンが複雑
  3. axum — towerエコシステム統合、Tokio公式
- **Selected Approach**: axum 0.8.x を採用
- **Rationale**:
  - 既存のLambda関数がtokioとtracingを使用しており、エコシステムが統一される
  - tower middlewareがそのまま使用可能（認証、レート制限）
  - プロジェクトのRust Edition 2024方針と整合（async-trait不要）
- **Trade-offs**:
  - Benefits: モダンなAPI、型安全、優れたドキュメント
  - Compromises: actix-webより生のパフォーマンスは劣る可能性（本ユースケースでは問題なし）
- **Follow-up**: 0.9リリース時にマイグレーションガイドを確認

### Decision: SQLiteアクセスパターン

- **Context**: axum（async）からrusqlite（sync）へのアクセス方法
- **Alternatives Considered**:
  1. tokio::task::spawn_blocking — 同期呼び出しをブロッキングタスクでラップ
  2. sqlx — 純粋async SQLiteドライバー
  3. Connection プール — r2d2 等でコネクション管理
- **Selected Approach**: tokio::task::spawn_blocking + 単一Connection
- **Rationale**:
  - rusqliteは実績があり、WALモードのサポートが確実
  - sqlxはasyncだが、SQLiteバックエンドの成熟度が低い
  - 単一プロセス・単一ライターのためプールは不要
- **Trade-offs**:
  - Benefits: シンプル、予測可能な動作
  - Compromises: 高負荷時にブロッキングタスクがボトルネックになる可能性
- **Follow-up**: 負荷テストでパフォーマンスを検証

### Decision: APIトークン管理方式

- **Context**: Lambda関数とEC2間の認証方式
- **Alternatives Considered**:
  1. 環境変数直接埋め込み — シンプルだがセキュリティリスク
  2. Secrets Manager — 高機能だがコスト発生
  3. Parameter Store SecureString — 無料枠内、KMS暗号化
- **Selected Approach**: Systems Manager Parameter Store (SecureString)
- **Rationale**:
  - 追加コストなし
  - IAMロールベースのアクセス制御
  - KMS暗号化で保存時のセキュリティ確保
- **Trade-offs**:
  - Benefits: 低コスト、AWS標準、監査ログ
  - Compromises: 自動ローテーションなし（Secrets Managerにはあり）
- **Follow-up**: 定期的なトークン更新手順をドキュメント化

### Decision: Terraformモジュール構成

- **Context**: 新規EC2リソースのTerraform配置
- **Alternatives Considered**:
  1. api/ec2.tf — 既存apiモジュールに追加
  2. search/ — 新規独立モジュール
  3. api/sqlite.tf — 責務明示のファイル名
- **Selected Approach**: api/sqlite.tf として既存apiモジュール内に追加
- **Rationale**:
  - 検索機能はAPIモジュールの責務範囲内
  - opensearch.tf と対称的な構成
  - 変数の受け渡しが最小限
- **Trade-offs**:
  - Benefits: 既存パターン踏襲、モジュール間依存なし
  - Compromises: apiモジュールが大きくなる
- **Follow-up**: 移行完了後にopensearch.tf削除でバランス回復

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| EC2単一障害点 | 検索機能停止 | Medium | Auto Recovery有効化、ダウンタイム許容（個人リレー） |
| SQLiteディスク容量不足 | 書き込み失敗 | Low | CloudWatch監視、10GB初期容量 |
| APIトークン漏洩 | 不正アクセス | Low | Parameter Store暗号化、定期ローテーション |
| Caddy TLS更新失敗 | HTTPS停止 | Low | Caddy自動更新、アラート設定 |
| t4g.nano リソース不足 | パフォーマンス劣化 | Medium | CloudWatch監視、必要時にnano→microアップグレード |

## References

- [rusqlite GitHub](https://github.com/rusqlite/rusqlite) — Rust SQLite bindings
- [axum 0.8.0 Announcement](https://tokio.rs/blog/2025-01-01-announcing-axum-0-8-0) — Latest framework release
- [Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https) — TLS automation
- [tower_governor crate](https://crates.io/crates/tower_governor) — Rate limiting middleware
- [reqwest_retry Documentation](https://docs.rs/reqwest-retry) — HTTP retry middleware
- [AWS EC2 t4g Instances](https://aws.amazon.com/ec2/instance-types/t4g/) — Graviton2 ARM instances
