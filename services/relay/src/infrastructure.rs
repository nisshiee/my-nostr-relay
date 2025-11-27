// インフラストラクチャ層モジュール
pub mod config;
pub mod connection_repository;
pub mod event_repository;
pub mod logging;
pub mod subscription_repository;
pub mod websocket_sender;

// 再エクスポート
pub use config::{DynamoDbConfig, DynamoDbConfigError};
pub use logging::init_logging;
pub use connection_repository::{
    ConnectionInfo, ConnectionRepository, DynamoConnectionRepository, RepositoryError,
};
pub use event_repository::{
    DynamoEventRepository, EventRepository, EventRepositoryError, SaveResult,
};
pub use subscription_repository::{
    DynamoSubscriptionRepository, MatchedSubscription, SubscriptionInfo, SubscriptionRepository,
    SubscriptionRepositoryError,
};
pub use websocket_sender::{ApiGatewayWebSocketSender, SendError, WebSocketSender};
