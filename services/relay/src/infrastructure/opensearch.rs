// OpenSearch関連のインフラストラクチャ実装
//
// OpenSearch Serviceへの接続、クエリ実行、インデックス操作を提供する。
// DynamoDBを「真実の源」として維持し、OpenSearchは検索用のマテリアライズドビューとして機能。

mod client;
mod config;
mod index_document;

// 再エクスポート
pub use client::{OpenSearchClient, OpenSearchClientError};
pub use config::{OpenSearchConfig, OpenSearchConfigError};
pub use index_document::{DocumentBuildError, NostrEventDocument};
