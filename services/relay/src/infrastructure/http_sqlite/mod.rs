// HTTP SQLiteイベントリポジトリモジュール
//
// EC2上のHTTP APIサーバー（SQLite）に接続するクライアント実装
// - HttpSqliteEventRepository: Lambda関数からのREQクエリ処理に使用（要件: 5.1, 5.2, 5.5）
// - IndexerClient: Indexer Lambdaからのイベントインデックス・削除に使用（要件: 5.3, 5.4, 5.5, 5.6）

mod config;
mod event_repository;
mod indexer_client;

pub use config::{HttpSqliteConfig, HttpSqliteConfigError};
pub use event_repository::{HttpSqliteEventRepository, HttpSqliteEventRepositoryError};
pub use indexer_client::{HttpSqliteIndexerError, IndexerClient};
