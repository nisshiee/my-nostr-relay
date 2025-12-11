// HTTP SQLiteイベントリポジトリモジュール
//
// EC2上のHTTP APIサーバー（SQLite）に接続するクライアント実装
// - HttpSqliteEventRepository: Lambda関数からのREQクエリ処理に使用（要件: 5.1, 5.2, 5.5）
// - IndexerClient: Indexer Lambdaからのイベントインデックス・削除に使用（要件: 5.3, 5.4, 5.5, 5.6）
// - HttpSqliteIndexer: DynamoDB Streams処理でIndexerClientを使用（要件: 5.3, 5.4）
// - HttpSqliteRebuilder: DynamoDBからSQLiteインデックスを再構築（要件: 6.1, 6.2, 6.3, 6.4, 6.5）

mod config;
mod event_repository;
mod http_sqlite_indexer;
mod indexer_client;
mod rebuilder;

pub use config::{HttpSqliteConfig, HttpSqliteConfigError};
pub use event_repository::{HttpSqliteEventRepository, HttpSqliteEventRepositoryError};
pub use http_sqlite_indexer::{
    HttpSqliteIndexer, HttpSqliteIndexerProcessError, HttpSqliteIndexerResult,
    HttpSqliteProcessAction,
};
pub use indexer_client::{HttpSqliteIndexerError, IndexerClient};
pub use rebuilder::{
    HttpSqliteRebuildConfig, HttpSqliteRebuildConfigError, HttpSqliteRebuildResult,
    HttpSqliteRebuilder, HttpSqliteRebuilderError,
};
