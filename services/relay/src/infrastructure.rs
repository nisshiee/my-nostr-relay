// インフラストラクチャ層モジュール
pub mod config;
pub mod connection_repository;
pub mod event_repository;
pub mod http_sqlite;
pub mod logging;
pub mod opensearch;
pub mod relay_info_config;
pub mod subscription_repository;
pub mod websocket_sender;

// 再エクスポート
pub use config::{DynamoDbConfig, DynamoDbConfigError};
pub use connection_repository::{
    ConnectionInfo, ConnectionRepository, DynamoConnectionRepository, RepositoryError,
};
pub use event_repository::{
    DynamoEventRepository, EventRepository, EventRepositoryError, QueryRepository,
    QueryRepositoryError, SaveResult,
};
pub use http_sqlite::{
    HttpSqliteConfig, HttpSqliteConfigError, HttpSqliteEventRepository,
    HttpSqliteEventRepositoryError,
};
pub use logging::init_logging;
pub use opensearch::{
    DocumentBuildError, Indexer, IndexerError, IndexerResult, NostrEventDocument,
    OpenSearchClient, OpenSearchClientError, OpenSearchConfig, OpenSearchConfigError,
    OpenSearchEventRepository, OpenSearchEventRepositoryError, ProcessAction, RebuildConfig,
    RebuildConfigError, RebuildResult, Rebuilder, RebuilderError,
};
pub use relay_info_config::{is_valid_pubkey, parse_comma_separated, RelayInfoConfig};
pub use subscription_repository::{
    DynamoSubscriptionRepository, MatchedSubscription, SubscriptionInfo, SubscriptionRepository,
    SubscriptionRepositoryError,
};
pub use websocket_sender::{ApiGatewayWebSocketSender, SendError, WebSocketSender};
