/// Connection repository for managing WebSocket connections in DynamoDB
///
/// Requirements: 17.1, 17.2, 17.3, 17.4, 17.5
use async_trait::async_trait;
use aws_sdk_dynamodb::types::AttributeValue;
use aws_sdk_dynamodb::Client as DynamoDbClient;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

/// Error types for repository operations
#[derive(Debug, Error, Clone, PartialEq)]
pub enum RepositoryError {
    /// Failed to connect to DynamoDB
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),

    /// Failed to write to DynamoDB
    #[error("Write error: {0}")]
    WriteError(String),

    /// Failed to read from DynamoDB
    #[error("Read error: {0}")]
    ReadError(String),

    /// Failed to serialize/deserialize data
    #[error("Serialization error: {0}")]
    SerializationError(String),
}

/// Information about a WebSocket connection
#[derive(Debug, Clone, PartialEq)]
pub struct ConnectionInfo {
    /// The API Gateway connection ID
    pub connection_id: String,
    /// The API Gateway Management API endpoint URL
    pub endpoint_url: String,
    /// Unix timestamp of when the connection was established
    pub connected_at: i64,
}

/// Trait for managing WebSocket connections
///
/// This trait abstracts the connection persistence functionality to allow
/// for different implementations (real DynamoDB, mock for testing).
#[async_trait]
pub trait ConnectionRepository: Send + Sync {
    /// Save a new connection to the repository
    ///
    /// # Arguments
    /// * `connection_id` - The API Gateway connection ID
    /// * `endpoint_url` - The API Gateway Management API endpoint URL
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err(RepositoryError)` on failure
    ///
    /// Requirements: 17.1, 17.2
    async fn save(&self, connection_id: &str, endpoint_url: &str) -> Result<(), RepositoryError>;

    /// Delete a connection from the repository
    ///
    /// # Arguments
    /// * `connection_id` - The API Gateway connection ID
    ///
    /// # Returns
    /// * `Ok(())` on success (even if the connection didn't exist)
    /// * `Err(RepositoryError)` on failure
    ///
    /// Requirement: 17.3
    async fn delete(&self, connection_id: &str) -> Result<(), RepositoryError>;

    /// Get connection information by connection ID
    ///
    /// # Arguments
    /// * `connection_id` - The API Gateway connection ID
    ///
    /// # Returns
    /// * `Ok(Some(ConnectionInfo))` if found
    /// * `Ok(None)` if not found
    /// * `Err(RepositoryError)` on failure
    ///
    /// Requirement: 17.4
    async fn get(&self, connection_id: &str) -> Result<Option<ConnectionInfo>, RepositoryError>;
}

/// TTL duration for connections (24 hours in seconds)
const CONNECTION_TTL_SECONDS: i64 = 24 * 60 * 60;

/// DynamoDB implementation of ConnectionRepository
///
/// This struct implements the ConnectionRepository trait using DynamoDB
/// for persistent storage of WebSocket connection information.
#[derive(Debug, Clone)]
pub struct DynamoConnectionRepository {
    /// DynamoDB client
    client: DynamoDbClient,
    /// Table name for connections
    table_name: String,
}

impl DynamoConnectionRepository {
    /// Create a new DynamoConnectionRepository
    ///
    /// # Arguments
    /// * `client` - DynamoDB client
    /// * `table_name` - Name of the connections table
    pub fn new(client: DynamoDbClient, table_name: String) -> Self {
        Self { client, table_name }
    }

    /// Get current Unix timestamp in seconds
    fn current_timestamp() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64
    }

    /// Calculate TTL timestamp (current time + 24 hours)
    fn calculate_ttl(connected_at: i64) -> i64 {
        connected_at + CONNECTION_TTL_SECONDS
    }
}

#[async_trait]
impl ConnectionRepository for DynamoConnectionRepository {
    async fn save(&self, connection_id: &str, endpoint_url: &str) -> Result<(), RepositoryError> {
        let connected_at = Self::current_timestamp();
        let ttl = Self::calculate_ttl(connected_at);

        self.client
            .put_item()
            .table_name(&self.table_name)
            .item("connection_id", AttributeValue::S(connection_id.to_string()))
            .item("endpoint_url", AttributeValue::S(endpoint_url.to_string()))
            .item("connected_at", AttributeValue::N(connected_at.to_string()))
            .item("ttl", AttributeValue::N(ttl.to_string()))
            .send()
            .await
            .map_err(|e| RepositoryError::WriteError(e.to_string()))?;

        Ok(())
    }

    async fn delete(&self, connection_id: &str) -> Result<(), RepositoryError> {
        self.client
            .delete_item()
            .table_name(&self.table_name)
            .key("connection_id", AttributeValue::S(connection_id.to_string()))
            .send()
            .await
            .map_err(|e| RepositoryError::WriteError(e.to_string()))?;

        Ok(())
    }

    async fn get(&self, connection_id: &str) -> Result<Option<ConnectionInfo>, RepositoryError> {
        let result = self
            .client
            .get_item()
            .table_name(&self.table_name)
            .key("connection_id", AttributeValue::S(connection_id.to_string()))
            .send()
            .await
            .map_err(|e| RepositoryError::ReadError(e.to_string()))?;

        match result.item {
            Some(item) => {
                let connection_id = item
                    .get("connection_id")
                    .and_then(|v| v.as_s().ok())
                    .ok_or_else(|| {
                        RepositoryError::SerializationError(
                            "Missing connection_id field".to_string(),
                        )
                    })?
                    .clone();

                let endpoint_url = item
                    .get("endpoint_url")
                    .and_then(|v| v.as_s().ok())
                    .ok_or_else(|| {
                        RepositoryError::SerializationError("Missing endpoint_url field".to_string())
                    })?
                    .clone();

                let connected_at = item
                    .get("connected_at")
                    .and_then(|v| v.as_n().ok())
                    .and_then(|n| n.parse::<i64>().ok())
                    .ok_or_else(|| {
                        RepositoryError::SerializationError("Missing connected_at field".to_string())
                    })?;

                Ok(Some(ConnectionInfo {
                    connection_id,
                    endpoint_url,
                    connected_at,
                }))
            }
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    // ==================== 3.3 Connection Repository Tests ====================

    // Test RepositoryError display messages (Req 17.5)
    #[test]
    fn test_repository_error_connection_failed_display() {
        let error = RepositoryError::ConnectionFailed("timeout".to_string());
        assert_eq!(error.to_string(), "Connection failed: timeout");
    }

    #[test]
    fn test_repository_error_write_error_display() {
        let error = RepositoryError::WriteError("conditional check failed".to_string());
        assert_eq!(error.to_string(), "Write error: conditional check failed");
    }

    #[test]
    fn test_repository_error_read_error_display() {
        let error = RepositoryError::ReadError("item not found".to_string());
        assert_eq!(error.to_string(), "Read error: item not found");
    }

    #[test]
    fn test_repository_error_serialization_error_display() {
        let error = RepositoryError::SerializationError("invalid format".to_string());
        assert_eq!(error.to_string(), "Serialization error: invalid format");
    }

    // Test RepositoryError equality
    #[test]
    fn test_repository_error_equality() {
        assert_eq!(
            RepositoryError::ConnectionFailed("test".to_string()),
            RepositoryError::ConnectionFailed("test".to_string())
        );
        assert_ne!(
            RepositoryError::ConnectionFailed("test1".to_string()),
            RepositoryError::ConnectionFailed("test2".to_string())
        );
        assert_ne!(
            RepositoryError::WriteError("test".to_string()),
            RepositoryError::ReadError("test".to_string())
        );
    }

    // Test RepositoryError clone
    #[test]
    fn test_repository_error_clone() {
        let error = RepositoryError::WriteError("test".to_string());
        let cloned = error.clone();
        assert_eq!(error, cloned);
    }

    // Test ConnectionInfo fields (Req 17.1, 17.2)
    #[test]
    fn test_connection_info_fields() {
        let info = ConnectionInfo {
            connection_id: "conn-123".to_string(),
            endpoint_url: "https://example.com/stage".to_string(),
            connected_at: 1700000000,
        };

        assert_eq!(info.connection_id, "conn-123");
        assert_eq!(info.endpoint_url, "https://example.com/stage");
        assert_eq!(info.connected_at, 1700000000);
    }

    // Test ConnectionInfo clone
    #[test]
    fn test_connection_info_clone() {
        let info = ConnectionInfo {
            connection_id: "conn-123".to_string(),
            endpoint_url: "https://example.com/stage".to_string(),
            connected_at: 1700000000,
        };
        let cloned = info.clone();
        assert_eq!(info, cloned);
    }

    // Test TTL calculation (Req 17.2)
    #[test]
    fn test_ttl_calculation() {
        let connected_at: i64 = 1700000000;
        let ttl = DynamoConnectionRepository::calculate_ttl(connected_at);

        // TTL should be 24 hours (86400 seconds) after connected_at
        assert_eq!(ttl, connected_at + CONNECTION_TTL_SECONDS);
        assert_eq!(ttl, 1700000000 + 86400);
    }

    // Test current_timestamp returns reasonable value
    #[test]
    fn test_current_timestamp() {
        let timestamp = DynamoConnectionRepository::current_timestamp();

        // Should be after Jan 1, 2020 (1577836800)
        assert!(timestamp > 1577836800);
        // Should be before year 3000 (just a sanity check)
        assert!(timestamp < 32503680000);
    }

    // Mock ConnectionRepository for unit testing
    #[derive(Debug, Clone)]
    pub struct MockConnectionRepository {
        /// Stored connections: connection_id -> ConnectionInfo
        connections: Arc<Mutex<HashMap<String, ConnectionInfo>>>,
        /// Error to return on next operation (for testing error paths)
        next_error: Arc<Mutex<Option<RepositoryError>>>,
    }

    impl MockConnectionRepository {
        pub fn new() -> Self {
            Self {
                connections: Arc::new(Mutex::new(HashMap::new())),
                next_error: Arc::new(Mutex::new(None)),
            }
        }

        pub fn set_next_error(&self, error: RepositoryError) {
            *self.next_error.lock().unwrap() = Some(error);
        }

        pub fn get_connection(&self, connection_id: &str) -> Option<ConnectionInfo> {
            self.connections.lock().unwrap().get(connection_id).cloned()
        }

        pub fn connection_count(&self) -> usize {
            self.connections.lock().unwrap().len()
        }

        fn take_error(&self) -> Option<RepositoryError> {
            self.next_error.lock().unwrap().take()
        }
    }

    #[async_trait]
    impl ConnectionRepository for MockConnectionRepository {
        async fn save(&self, connection_id: &str, endpoint_url: &str) -> Result<(), RepositoryError> {
            if let Some(error) = self.take_error() {
                return Err(error);
            }

            let connected_at = DynamoConnectionRepository::current_timestamp();
            let info = ConnectionInfo {
                connection_id: connection_id.to_string(),
                endpoint_url: endpoint_url.to_string(),
                connected_at,
            };

            self.connections
                .lock()
                .unwrap()
                .insert(connection_id.to_string(), info);

            Ok(())
        }

        async fn delete(&self, connection_id: &str) -> Result<(), RepositoryError> {
            if let Some(error) = self.take_error() {
                return Err(error);
            }

            self.connections.lock().unwrap().remove(connection_id);
            Ok(())
        }

        async fn get(&self, connection_id: &str) -> Result<Option<ConnectionInfo>, RepositoryError> {
            if let Some(error) = self.take_error() {
                return Err(error);
            }

            Ok(self.connections.lock().unwrap().get(connection_id).cloned())
        }
    }

    // Test MockConnectionRepository save success (Req 17.1, 17.2)
    #[tokio::test]
    async fn test_mock_repo_save_success() {
        let repo = MockConnectionRepository::new();
        let result = repo
            .save("conn-123", "https://example.com/stage")
            .await;

        assert!(result.is_ok());
        assert_eq!(repo.connection_count(), 1);

        let info = repo.get_connection("conn-123").unwrap();
        assert_eq!(info.connection_id, "conn-123");
        assert_eq!(info.endpoint_url, "https://example.com/stage");
        assert!(info.connected_at > 0);
    }

    // Test MockConnectionRepository save multiple connections (Req 17.1)
    #[tokio::test]
    async fn test_mock_repo_save_multiple() {
        let repo = MockConnectionRepository::new();

        repo.save("conn-1", "https://example.com/stage1").await.unwrap();
        repo.save("conn-2", "https://example.com/stage2").await.unwrap();
        repo.save("conn-3", "https://example.com/stage3").await.unwrap();

        assert_eq!(repo.connection_count(), 3);
        assert!(repo.get_connection("conn-1").is_some());
        assert!(repo.get_connection("conn-2").is_some());
        assert!(repo.get_connection("conn-3").is_some());
    }

    // Test MockConnectionRepository save overwrites existing (Req 17.1)
    #[tokio::test]
    async fn test_mock_repo_save_overwrite() {
        let repo = MockConnectionRepository::new();

        repo.save("conn-123", "https://old.example.com/stage").await.unwrap();
        repo.save("conn-123", "https://new.example.com/stage").await.unwrap();

        assert_eq!(repo.connection_count(), 1);
        let info = repo.get_connection("conn-123").unwrap();
        assert_eq!(info.endpoint_url, "https://new.example.com/stage");
    }

    // Test MockConnectionRepository delete success (Req 17.3)
    #[tokio::test]
    async fn test_mock_repo_delete_success() {
        let repo = MockConnectionRepository::new();

        repo.save("conn-123", "https://example.com/stage").await.unwrap();
        assert_eq!(repo.connection_count(), 1);

        let result = repo.delete("conn-123").await;
        assert!(result.is_ok());
        assert_eq!(repo.connection_count(), 0);
        assert!(repo.get_connection("conn-123").is_none());
    }

    // Test MockConnectionRepository delete non-existent (Req 17.3)
    #[tokio::test]
    async fn test_mock_repo_delete_non_existent() {
        let repo = MockConnectionRepository::new();

        // Deleting non-existent connection should succeed
        let result = repo.delete("non-existent").await;
        assert!(result.is_ok());
    }

    // Test MockConnectionRepository get success (Req 17.4)
    #[tokio::test]
    async fn test_mock_repo_get_success() {
        let repo = MockConnectionRepository::new();

        repo.save("conn-123", "https://example.com/stage").await.unwrap();

        let result = repo.get("conn-123").await;
        assert!(result.is_ok());

        let info = result.unwrap().unwrap();
        assert_eq!(info.connection_id, "conn-123");
        assert_eq!(info.endpoint_url, "https://example.com/stage");
    }

    // Test MockConnectionRepository get non-existent (Req 17.4)
    #[tokio::test]
    async fn test_mock_repo_get_non_existent() {
        let repo = MockConnectionRepository::new();

        let result = repo.get("non-existent").await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }

    // Test MockConnectionRepository save error (Req 17.5)
    #[tokio::test]
    async fn test_mock_repo_save_error() {
        let repo = MockConnectionRepository::new();
        repo.set_next_error(RepositoryError::WriteError("DynamoDB unavailable".to_string()));

        let result = repo.save("conn-123", "https://example.com/stage").await;

        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            RepositoryError::WriteError("DynamoDB unavailable".to_string())
        );
    }

    // Test MockConnectionRepository delete error (Req 17.5)
    #[tokio::test]
    async fn test_mock_repo_delete_error() {
        let repo = MockConnectionRepository::new();
        repo.set_next_error(RepositoryError::WriteError("DynamoDB unavailable".to_string()));

        let result = repo.delete("conn-123").await;

        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            RepositoryError::WriteError("DynamoDB unavailable".to_string())
        );
    }

    // Test MockConnectionRepository get error (Req 17.5)
    #[tokio::test]
    async fn test_mock_repo_get_error() {
        let repo = MockConnectionRepository::new();
        repo.set_next_error(RepositoryError::ReadError("DynamoDB unavailable".to_string()));

        let result = repo.get("conn-123").await;

        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            RepositoryError::ReadError("DynamoDB unavailable".to_string())
        );
    }

    // Test connection records endpoint URL (Req 17.2)
    #[tokio::test]
    async fn test_connection_records_endpoint_url() {
        let repo = MockConnectionRepository::new();
        let endpoint_url = "https://abc123.execute-api.us-east-1.amazonaws.com/prod";

        repo.save("conn-123", endpoint_url).await.unwrap();

        let info = repo.get("conn-123").await.unwrap().unwrap();
        assert_eq!(info.endpoint_url, endpoint_url);
    }

    // Test connection records connected_at timestamp (Req 17.2)
    #[tokio::test]
    async fn test_connection_records_timestamp() {
        let repo = MockConnectionRepository::new();
        let before = DynamoConnectionRepository::current_timestamp();

        repo.save("conn-123", "https://example.com/stage").await.unwrap();

        let after = DynamoConnectionRepository::current_timestamp();
        let info = repo.get("conn-123").await.unwrap().unwrap();

        // connected_at should be between before and after
        assert!(info.connected_at >= before);
        assert!(info.connected_at <= after);
    }

    // Test deleting one connection doesn't affect others (Req 17.3)
    #[tokio::test]
    async fn test_delete_does_not_affect_others() {
        let repo = MockConnectionRepository::new();

        repo.save("conn-1", "https://example.com/1").await.unwrap();
        repo.save("conn-2", "https://example.com/2").await.unwrap();
        repo.save("conn-3", "https://example.com/3").await.unwrap();

        repo.delete("conn-2").await.unwrap();

        assert_eq!(repo.connection_count(), 2);
        assert!(repo.get_connection("conn-1").is_some());
        assert!(repo.get_connection("conn-2").is_none());
        assert!(repo.get_connection("conn-3").is_some());
    }
}
