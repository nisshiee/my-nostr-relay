/// API Gateway Management APIを使用したWebSocketメッセージ送信
///
/// 要件: 6.2, 6.5, 18.7
use async_trait::async_trait;
use aws_sdk_apigatewaymanagement::{primitives::Blob, Client as ApiGatewayManagementClient};
use thiserror::Error;

/// WebSocket送信操作のエラー型
#[derive(Debug, Error, Clone, PartialEq)]
pub enum SendError {
    /// 接続が切断された（API Gatewayからの410 GONE）
    #[error("Connection is gone")]
    ConnectionGone,

    /// ネットワークまたはサービスエラー
    #[error("Network error: {0}")]
    NetworkError(String),

    /// メッセージシリアライズエラー
    #[error("Serialization error: {0}")]
    SerializationError(String),
}

/// WebSocketメッセージ送信用トレイト
///
/// このトレイトはWebSocket送信機能を抽象化し、
/// 異なる実装を可能にします（実際のAPI Gatewayクライアント、テスト用モック）。
#[async_trait]
pub trait WebSocketSender: Send + Sync {
    /// 特定の接続にメッセージを送信
    ///
    /// # 引数
    /// * `connection_id` - API Gateway接続ID
    /// * `message` - 送信するメッセージ（JSON文字列）
    ///
    /// # 戻り値
    /// * 成功時は`Ok(())`
    /// * 接続が存在しない場合は`Err(SendError::ConnectionGone)`
    /// * その他のネットワーク障害は`Err(SendError::NetworkError)`
    async fn send(&self, connection_id: &str, message: &str) -> Result<(), SendError>;

    /// 複数の接続にメッセージを送信（ブロードキャスト）
    ///
    /// # 引数
    /// * `connection_ids` - 送信先の接続IDリスト
    /// * `message` - 送信するメッセージ
    ///
    /// # 戻り値
    /// 各接続の(connection_id, result)ペアのベクター
    async fn broadcast(
        &self,
        connection_ids: &[String],
        message: &str,
    ) -> Vec<(String, Result<(), SendError>)>;
}

/// API Gateway Management API WebSocket送信実装
///
/// この構造体はWebSocketSenderトレイトを実装し、AWS API Gateway
/// Management APIを使用してWebSocket接続にメッセージを送信します。
#[derive(Debug, Clone)]
pub struct ApiGatewayWebSocketSender {
    /// API Gateway Management APIクライアント
    client: ApiGatewayManagementClient,
}

impl ApiGatewayWebSocketSender {
    /// 指定されたエンドポイントURLで新しいApiGatewayWebSocketSenderを作成
    ///
    /// # 引数
    /// * `endpoint_url` - API Gateway Management APIエンドポイントURL
    ///   (例: "https://{api-id}.execute-api.{region}.amazonaws.com/{stage}")
    ///
    /// # 例
    /// ```ignore
    /// let sender = ApiGatewayWebSocketSender::new("https://abc123.execute-api.us-east-1.amazonaws.com/prod").await;
    /// ```
    pub async fn new(endpoint_url: &str) -> Self {
        let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
        let client = ApiGatewayManagementClient::from_conf(
            aws_sdk_apigatewaymanagement::config::Builder::from(&aws_config)
                .endpoint_url(endpoint_url)
                .build(),
        );
        Self { client }
    }

    /// 事前設定されたクライアントで新しいApiGatewayWebSocketSenderを作成
    ///
    /// モッククライアントでのテストに便利です。
    pub fn with_client(client: ApiGatewayManagementClient) -> Self {
        Self { client }
    }

    /// API GatewayリクエストコンテキストからエンドポイントURLを構築
    ///
    /// # 引数
    /// * `domain_name` - リクエストコンテキストからのドメイン名
    /// * `stage` - リクエストコンテキストからのステージ
    ///
    /// # 戻り値
    /// API Gateway Management APIのエンドポイントURL
    pub fn build_endpoint_url(domain_name: &str, stage: &str) -> String {
        format!("https://{domain_name}/{stage}")
    }
}

#[async_trait]
impl WebSocketSender for ApiGatewayWebSocketSender {
    async fn send(&self, connection_id: &str, message: &str) -> Result<(), SendError> {
        let data = Blob::new(message.as_bytes().to_vec());

        match self
            .client
            .post_to_connection()
            .connection_id(connection_id)
            .data(data)
            .send()
            .await
        {
            Ok(_) => Ok(()),
            Err(err) => {
                let service_error = err.into_service_error();

                // エラーが410 GONE（接続切断）かチェック
                if service_error.is_gone_exception() {
                    return Err(SendError::ConnectionGone);
                }

                // その他のエラーはネットワークエラー
                Err(SendError::NetworkError(service_error.to_string()))
            }
        }
    }

    async fn broadcast(
        &self,
        connection_ids: &[String],
        message: &str,
    ) -> Vec<(String, Result<(), SendError>)> {
        let mut results = Vec::with_capacity(connection_ids.len());

        for connection_id in connection_ids {
            let result = self.send(connection_id, message).await;
            results.push((connection_id.clone(), result));
        }

        results
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    // ==================== 3.2 WebSocket送信テスト ====================

    // SendError表示メッセージのテスト (要件 6.2, 6.5, 18.7)
    #[test]
    fn test_send_error_connection_gone_display() {
        let error = SendError::ConnectionGone;
        assert_eq!(error.to_string(), "Connection is gone");
    }

    #[test]
    fn test_send_error_network_error_display() {
        let error = SendError::NetworkError("timeout".to_string());
        assert_eq!(error.to_string(), "Network error: timeout");
    }

    #[test]
    fn test_send_error_serialization_error_display() {
        let error = SendError::SerializationError("invalid utf8".to_string());
        assert_eq!(error.to_string(), "Serialization error: invalid utf8");
    }

    // SendError等価性のテスト
    #[test]
    fn test_send_error_equality() {
        assert_eq!(SendError::ConnectionGone, SendError::ConnectionGone);
        assert_eq!(
            SendError::NetworkError("test".to_string()),
            SendError::NetworkError("test".to_string())
        );
        assert_ne!(
            SendError::NetworkError("test1".to_string()),
            SendError::NetworkError("test2".to_string())
        );
    }

    // SendErrorクローンのテスト
    #[test]
    fn test_send_error_clone() {
        let error = SendError::NetworkError("test".to_string());
        let cloned = error.clone();
        assert_eq!(error, cloned);
    }

    // build_endpoint_urlヘルパーのテスト (要件 6.2)
    #[test]
    fn test_build_endpoint_url() {
        let url = ApiGatewayWebSocketSender::build_endpoint_url(
            "abc123.execute-api.us-east-1.amazonaws.com",
            "prod",
        );
        assert_eq!(
            url,
            "https://abc123.execute-api.us-east-1.amazonaws.com/prod"
        );
    }

    #[test]
    fn test_build_endpoint_url_with_different_stage() {
        let url = ApiGatewayWebSocketSender::build_endpoint_url(
            "xyz789.execute-api.ap-northeast-1.amazonaws.com",
            "dev",
        );
        assert_eq!(
            url,
            "https://xyz789.execute-api.ap-northeast-1.amazonaws.com/dev"
        );
    }

    // ユニットテスト用のモックWebSocket送信
    #[derive(Debug, Clone)]
    pub struct MockWebSocketSender {
        /// 送信されたメッセージを追跡: connection_id -> messages
        sent_messages: Arc<Mutex<HashMap<String, Vec<String>>>>,
        /// ConnectionGoneエラーを返す接続
        gone_connections: Arc<Mutex<Vec<String>>>,
        /// NetworkErrorを返す接続
        error_connections: Arc<Mutex<HashMap<String, String>>>,
    }

    impl MockWebSocketSender {
        pub fn new() -> Self {
            Self {
                sent_messages: Arc::new(Mutex::new(HashMap::new())),
                gone_connections: Arc::new(Mutex::new(Vec::new())),
                error_connections: Arc::new(Mutex::new(HashMap::new())),
            }
        }

        pub fn mark_connection_gone(&self, connection_id: &str) {
            self.gone_connections
                .lock()
                .unwrap()
                .push(connection_id.to_string());
        }

        pub fn mark_connection_error(&self, connection_id: &str, error_message: &str) {
            self.error_connections
                .lock()
                .unwrap()
                .insert(connection_id.to_string(), error_message.to_string());
        }

        pub fn get_sent_messages(&self, connection_id: &str) -> Vec<String> {
            self.sent_messages
                .lock()
                .unwrap()
                .get(connection_id)
                .cloned()
                .unwrap_or_default()
        }
    }

    #[async_trait]
    impl WebSocketSender for MockWebSocketSender {
        async fn send(&self, connection_id: &str, message: &str) -> Result<(), SendError> {
            // Check if connection is marked as gone
            if self
                .gone_connections
                .lock()
                .unwrap()
                .contains(&connection_id.to_string())
            {
                return Err(SendError::ConnectionGone);
            }

            // Check if connection should return an error
            if let Some(error_msg) = self
                .error_connections
                .lock()
                .unwrap()
                .get(connection_id)
                .cloned()
            {
                return Err(SendError::NetworkError(error_msg));
            }

            // Record the message
            self.sent_messages
                .lock()
                .unwrap()
                .entry(connection_id.to_string())
                .or_default()
                .push(message.to_string());

            Ok(())
        }

        async fn broadcast(
            &self,
            connection_ids: &[String],
            message: &str,
        ) -> Vec<(String, Result<(), SendError>)> {
            let mut results = Vec::with_capacity(connection_ids.len());
            for connection_id in connection_ids {
                let result = self.send(connection_id, message).await;
                results.push((connection_id.clone(), result));
            }
            results
        }
    }

    // MockWebSocketSender送信成功のテスト (要件 6.2)
    #[tokio::test]
    async fn test_mock_sender_send_success() {
        let sender = MockWebSocketSender::new();
        let result = sender.send("conn-123", r#"["OK","abc",true,""]"#).await;

        assert!(result.is_ok());
        let messages = sender.get_sent_messages("conn-123");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0], r#"["OK","abc",true,""]"#);
    }

    // MockWebSocketSender複数メッセージ送信のテスト (要件 6.2)
    #[tokio::test]
    async fn test_mock_sender_send_multiple_messages() {
        let sender = MockWebSocketSender::new();

        sender.send("conn-123", "message1").await.unwrap();
        sender.send("conn-123", "message2").await.unwrap();
        sender.send("conn-456", "message3").await.unwrap();

        let messages_123 = sender.get_sent_messages("conn-123");
        assert_eq!(messages_123.len(), 2);
        assert_eq!(messages_123[0], "message1");
        assert_eq!(messages_123[1], "message2");

        let messages_456 = sender.get_sent_messages("conn-456");
        assert_eq!(messages_456.len(), 1);
        assert_eq!(messages_456[0], "message3");
    }

    // MockWebSocketSender接続切断のテスト (要件 6.2, 18.7)
    #[tokio::test]
    async fn test_mock_sender_connection_gone() {
        let sender = MockWebSocketSender::new();
        sender.mark_connection_gone("conn-gone");

        let result = sender.send("conn-gone", "test message").await;

        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), SendError::ConnectionGone);
    }

    // MockWebSocketSenderネットワークエラーのテスト (要件 6.2, 18.7)
    #[tokio::test]
    async fn test_mock_sender_network_error() {
        let sender = MockWebSocketSender::new();
        sender.mark_connection_error("conn-error", "connection refused");

        let result = sender.send("conn-error", "test message").await;

        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            SendError::NetworkError("connection refused".to_string())
        );
    }

    // 複数接続へのブロードキャストのテスト (要件 6.5, 18.7)
    #[tokio::test]
    async fn test_mock_sender_broadcast_success() {
        let sender = MockWebSocketSender::new();

        let connection_ids = vec![
            "conn-1".to_string(),
            "conn-2".to_string(),
            "conn-3".to_string(),
        ];
        let results = sender.broadcast(&connection_ids, "broadcast message").await;

        assert_eq!(results.len(), 3);
        for (conn_id, result) in &results {
            assert!(result.is_ok(), "Failed for connection {conn_id}");
        }

        // すべての接続がメッセージを受信したことを検証
        assert_eq!(sender.get_sent_messages("conn-1"), vec!["broadcast message"]);
        assert_eq!(sender.get_sent_messages("conn-2"), vec!["broadcast message"]);
        assert_eq!(sender.get_sent_messages("conn-3"), vec!["broadcast message"]);
    }

    // 一部の接続が切断されたブロードキャストのテスト (要件 6.5, 18.7)
    #[tokio::test]
    async fn test_mock_sender_broadcast_partial_failure() {
        let sender = MockWebSocketSender::new();
        sender.mark_connection_gone("conn-2");
        sender.mark_connection_error("conn-3", "timeout");

        let connection_ids = vec![
            "conn-1".to_string(),
            "conn-2".to_string(),
            "conn-3".to_string(),
        ];
        let results = sender.broadcast(&connection_ids, "broadcast message").await;

        assert_eq!(results.len(), 3);

        // conn-1は成功すべき
        assert_eq!(results[0].0, "conn-1");
        assert!(results[0].1.is_ok());

        // conn-2は切断されているべき
        assert_eq!(results[1].0, "conn-2");
        assert_eq!(results[1].1, Err(SendError::ConnectionGone));

        // conn-3はネットワークエラーがあるべき
        assert_eq!(results[2].0, "conn-3");
        assert_eq!(
            results[2].1,
            Err(SendError::NetworkError("timeout".to_string()))
        );

        // conn-1のみがメッセージを持つべき
        assert_eq!(sender.get_sent_messages("conn-1"), vec!["broadcast message"]);
        assert!(sender.get_sent_messages("conn-2").is_empty());
        assert!(sender.get_sent_messages("conn-3").is_empty());
    }

    // 空リストへのブロードキャストのテスト (要件 6.5)
    #[tokio::test]
    async fn test_mock_sender_broadcast_empty() {
        let sender = MockWebSocketSender::new();
        let results = sender.broadcast(&[], "broadcast message").await;
        assert!(results.is_empty());
    }

    // エラー型が適切に区別されるテスト (要件 18.7)
    #[test]
    fn test_error_types_distinguished() {
        let gone = SendError::ConnectionGone;
        let network = SendError::NetworkError("test".to_string());
        let serialization = SendError::SerializationError("test".to_string());

        // 3つの型はすべて異なるべき
        assert_ne!(gone, network);
        assert_ne!(gone, serialization);
        assert_ne!(network, serialization);
    }
}
