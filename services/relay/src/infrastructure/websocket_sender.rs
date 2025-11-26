/// WebSocket message sender using API Gateway Management API
///
/// Requirements: 6.2, 6.5, 18.7
use async_trait::async_trait;
use aws_sdk_apigatewaymanagement::{primitives::Blob, Client as ApiGatewayManagementClient};
use thiserror::Error;

/// Error types for WebSocket send operations
#[derive(Debug, Error, Clone, PartialEq)]
pub enum SendError {
    /// Connection is gone (410 GONE from API Gateway)
    #[error("Connection is gone")]
    ConnectionGone,

    /// Network or service error
    #[error("Network error: {0}")]
    NetworkError(String),

    /// Message serialization error
    #[error("Serialization error: {0}")]
    SerializationError(String),
}

/// Trait for sending WebSocket messages
///
/// This trait abstracts the WebSocket sending functionality to allow
/// for different implementations (real API Gateway client, mock for testing).
#[async_trait]
pub trait WebSocketSender: Send + Sync {
    /// Send a message to a specific connection
    ///
    /// # Arguments
    /// * `connection_id` - The API Gateway connection ID
    /// * `message` - The message to send (JSON string)
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err(SendError::ConnectionGone)` if the connection no longer exists
    /// * `Err(SendError::NetworkError)` for other network failures
    async fn send(&self, connection_id: &str, message: &str) -> Result<(), SendError>;

    /// Send a message to multiple connections (broadcast)
    ///
    /// # Arguments
    /// * `connection_ids` - List of connection IDs to send to
    /// * `message` - The message to send
    ///
    /// # Returns
    /// A vector of (connection_id, result) pairs for each connection
    async fn broadcast(
        &self,
        connection_ids: &[String],
        message: &str,
    ) -> Vec<(String, Result<(), SendError>)>;
}

/// API Gateway Management API WebSocket sender implementation
///
/// This struct implements the WebSocketSender trait using the AWS API Gateway
/// Management API to send messages to WebSocket connections.
#[derive(Debug, Clone)]
pub struct ApiGatewayWebSocketSender {
    /// The API Gateway Management API client
    client: ApiGatewayManagementClient,
}

impl ApiGatewayWebSocketSender {
    /// Create a new ApiGatewayWebSocketSender with the given endpoint URL
    ///
    /// # Arguments
    /// * `endpoint_url` - The API Gateway Management API endpoint URL
    ///   (e.g., "https://{api-id}.execute-api.{region}.amazonaws.com/{stage}")
    ///
    /// # Example
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

    /// Create a new ApiGatewayWebSocketSender with a pre-configured client
    ///
    /// This is useful for testing with a mock client.
    pub fn with_client(client: ApiGatewayManagementClient) -> Self {
        Self { client }
    }

    /// Build the endpoint URL from API Gateway request context
    ///
    /// # Arguments
    /// * `domain_name` - The domain name from the request context
    /// * `stage` - The stage from the request context
    ///
    /// # Returns
    /// The endpoint URL for the API Gateway Management API
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

                // Check if the error is a 410 GONE (connection gone)
                if service_error.is_gone_exception() {
                    return Err(SendError::ConnectionGone);
                }

                // Other errors are network errors
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

    // ==================== 3.2 WebSocket Sender Tests ====================

    // Test SendError display messages (Req 6.2, 6.5, 18.7)
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

    // Test SendError equality
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

    // Test SendError clone
    #[test]
    fn test_send_error_clone() {
        let error = SendError::NetworkError("test".to_string());
        let cloned = error.clone();
        assert_eq!(error, cloned);
    }

    // Test build_endpoint_url helper (Req 6.2)
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

    // Mock WebSocket sender for unit testing
    #[derive(Debug, Clone)]
    pub struct MockWebSocketSender {
        /// Track sent messages: connection_id -> messages
        sent_messages: Arc<Mutex<HashMap<String, Vec<String>>>>,
        /// Connections that should return ConnectionGone error
        gone_connections: Arc<Mutex<Vec<String>>>,
        /// Connections that should return NetworkError
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

    // Test MockWebSocketSender send success (Req 6.2)
    #[tokio::test]
    async fn test_mock_sender_send_success() {
        let sender = MockWebSocketSender::new();
        let result = sender.send("conn-123", r#"["OK","abc",true,""]"#).await;

        assert!(result.is_ok());
        let messages = sender.get_sent_messages("conn-123");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0], r#"["OK","abc",true,""]"#);
    }

    // Test MockWebSocketSender send multiple messages (Req 6.2)
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

    // Test MockWebSocketSender connection gone (Req 6.2, 18.7)
    #[tokio::test]
    async fn test_mock_sender_connection_gone() {
        let sender = MockWebSocketSender::new();
        sender.mark_connection_gone("conn-gone");

        let result = sender.send("conn-gone", "test message").await;

        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), SendError::ConnectionGone);
    }

    // Test MockWebSocketSender network error (Req 6.2, 18.7)
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

    // Test broadcast to multiple connections (Req 6.5, 18.7)
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

        // Verify all connections received the message
        assert_eq!(sender.get_sent_messages("conn-1"), vec!["broadcast message"]);
        assert_eq!(sender.get_sent_messages("conn-2"), vec!["broadcast message"]);
        assert_eq!(sender.get_sent_messages("conn-3"), vec!["broadcast message"]);
    }

    // Test broadcast with some connections gone (Req 6.5, 18.7)
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

        // conn-1 should succeed
        assert_eq!(results[0].0, "conn-1");
        assert!(results[0].1.is_ok());

        // conn-2 should be gone
        assert_eq!(results[1].0, "conn-2");
        assert_eq!(results[1].1, Err(SendError::ConnectionGone));

        // conn-3 should have network error
        assert_eq!(results[2].0, "conn-3");
        assert_eq!(
            results[2].1,
            Err(SendError::NetworkError("timeout".to_string()))
        );

        // Only conn-1 should have the message
        assert_eq!(sender.get_sent_messages("conn-1"), vec!["broadcast message"]);
        assert!(sender.get_sent_messages("conn-2").is_empty());
        assert!(sender.get_sent_messages("conn-3").is_empty());
    }

    // Test broadcast to empty list (Req 6.5)
    #[tokio::test]
    async fn test_mock_sender_broadcast_empty() {
        let sender = MockWebSocketSender::new();
        let results = sender.broadcast(&[], "broadcast message").await;
        assert!(results.is_empty());
    }

    // Test error types are properly distinguished (Req 18.7)
    #[test]
    fn test_error_types_distinguished() {
        let gone = SendError::ConnectionGone;
        let network = SendError::NetworkError("test".to_string());
        let serialization = SendError::SerializationError("test".to_string());

        // All three types should be different
        assert_ne!(gone, network);
        assert_ne!(gone, serialization);
        assert_ne!(network, serialization);
    }
}
