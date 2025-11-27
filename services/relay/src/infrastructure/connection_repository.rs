/// DynamoDBでWebSocket接続を管理するための接続リポジトリ
///
/// 要件: 17.1, 17.2, 17.3, 17.4, 17.5
use async_trait::async_trait;
use aws_sdk_dynamodb::types::AttributeValue;
use aws_sdk_dynamodb::Client as DynamoDbClient;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

/// リポジトリ操作のエラー型
#[derive(Debug, Error, Clone, PartialEq)]
pub enum RepositoryError {
    /// DynamoDBへの接続に失敗
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),

    /// DynamoDBへの書き込みに失敗
    #[error("Write error: {0}")]
    WriteError(String),

    /// DynamoDBからの読み取りに失敗
    #[error("Read error: {0}")]
    ReadError(String),

    /// データのシリアライズ/デシリアライズに失敗
    #[error("Serialization error: {0}")]
    SerializationError(String),
}

/// WebSocket接続の情報
#[derive(Debug, Clone, PartialEq)]
pub struct ConnectionInfo {
    /// API Gateway接続ID
    pub connection_id: String,
    /// API Gateway Management APIエンドポイントURL
    pub endpoint_url: String,
    /// 接続が確立されたUnixタイムスタンプ
    pub connected_at: i64,
}

/// WebSocket接続管理用トレイト
///
/// このトレイトは接続永続化機能を抽象化し、
/// 異なる実装を可能にします（実際のDynamoDB、テスト用モック）。
#[async_trait]
pub trait ConnectionRepository: Send + Sync {
    /// リポジトリに新しい接続を保存
    ///
    /// # 引数
    /// * `connection_id` - API Gateway接続ID
    /// * `endpoint_url` - API Gateway Management APIエンドポイントURL
    ///
    /// # 戻り値
    /// * 成功時は`Ok(())`
    /// * 失敗時は`Err(RepositoryError)`
    ///
    /// 要件: 17.1, 17.2
    async fn save(&self, connection_id: &str, endpoint_url: &str) -> Result<(), RepositoryError>;

    /// リポジトリから接続を削除
    ///
    /// # 引数
    /// * `connection_id` - API Gateway接続ID
    ///
    /// # 戻り値
    /// * 成功時は`Ok(())`（接続が存在しなかった場合も含む）
    /// * 失敗時は`Err(RepositoryError)`
    ///
    /// 要件: 17.3
    async fn delete(&self, connection_id: &str) -> Result<(), RepositoryError>;

    /// 接続IDで接続情報を取得
    ///
    /// # 引数
    /// * `connection_id` - API Gateway接続ID
    ///
    /// # 戻り値
    /// * 見つかった場合は`Ok(Some(ConnectionInfo))`
    /// * 見つからなかった場合は`Ok(None)`
    /// * 失敗時は`Err(RepositoryError)`
    ///
    /// 要件: 17.4
    async fn get(&self, connection_id: &str) -> Result<Option<ConnectionInfo>, RepositoryError>;
}

/// 接続のTTL期間（24時間を秒で）
const CONNECTION_TTL_SECONDS: i64 = 24 * 60 * 60;

/// ConnectionRepositoryのDynamoDB実装
///
/// この構造体はDynamoDBを使用してWebSocket接続情報を
/// 永続的に保存するConnectionRepositoryトレイトを実装します。
#[derive(Debug, Clone)]
pub struct DynamoConnectionRepository {
    /// DynamoDBクライアント
    client: DynamoDbClient,
    /// 接続テーブル名
    table_name: String,
}

impl DynamoConnectionRepository {
    /// 新しいDynamoConnectionRepositoryを作成
    ///
    /// # 引数
    /// * `client` - DynamoDBクライアント
    /// * `table_name` - 接続テーブルの名前
    pub fn new(client: DynamoDbClient, table_name: String) -> Self {
        Self { client, table_name }
    }

    /// 現在のUnixタイムスタンプを秒で取得
    fn current_timestamp() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64
    }

    /// TTLタイムスタンプを計算（現在時刻 + 24時間）
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

    // ==================== 3.3 接続リポジトリテスト ====================

    // RepositoryError表示メッセージのテスト (要件 17.5)
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

    // RepositoryError等価性のテスト
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

    // RepositoryErrorクローンのテスト
    #[test]
    fn test_repository_error_clone() {
        let error = RepositoryError::WriteError("test".to_string());
        let cloned = error.clone();
        assert_eq!(error, cloned);
    }

    // ConnectionInfoフィールドのテスト (要件 17.1, 17.2)
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

    // ConnectionInfoクローンのテスト
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

    // TTL計算のテスト (要件 17.2)
    #[test]
    fn test_ttl_calculation() {
        let connected_at: i64 = 1700000000;
        let ttl = DynamoConnectionRepository::calculate_ttl(connected_at);

        // TTLはconnected_atの24時間後（86400秒）であるべき
        assert_eq!(ttl, connected_at + CONNECTION_TTL_SECONDS);
        assert_eq!(ttl, 1700000000 + 86400);
    }

    // current_timestampが妥当な値を返すテスト
    #[test]
    fn test_current_timestamp() {
        let timestamp = DynamoConnectionRepository::current_timestamp();

        // 2020年1月1日（1577836800）より後であるべき
        assert!(timestamp > 1577836800);
        // 3000年より前であるべき（健全性チェック）
        assert!(timestamp < 32503680000);
    }

    // ユニットテスト用のモックConnectionRepository
    #[derive(Debug, Clone)]
    pub struct MockConnectionRepository {
        /// 保存された接続: connection_id -> ConnectionInfo
        connections: Arc<Mutex<HashMap<String, ConnectionInfo>>>,
        /// 次の操作で返すエラー（エラーパスのテスト用）
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

    // MockConnectionRepository保存成功のテスト (要件 17.1, 17.2)
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

    // MockConnectionRepository複数接続保存のテスト (要件 17.1)
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

    // MockConnectionRepository保存が既存を上書きするテスト (要件 17.1)
    #[tokio::test]
    async fn test_mock_repo_save_overwrite() {
        let repo = MockConnectionRepository::new();

        repo.save("conn-123", "https://old.example.com/stage").await.unwrap();
        repo.save("conn-123", "https://new.example.com/stage").await.unwrap();

        assert_eq!(repo.connection_count(), 1);
        let info = repo.get_connection("conn-123").unwrap();
        assert_eq!(info.endpoint_url, "https://new.example.com/stage");
    }

    // MockConnectionRepository削除成功のテスト (要件 17.3)
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

    // MockConnectionRepository存在しない接続の削除のテスト (要件 17.3)
    #[tokio::test]
    async fn test_mock_repo_delete_non_existent() {
        let repo = MockConnectionRepository::new();

        // 存在しない接続の削除は成功するべき
        let result = repo.delete("non-existent").await;
        assert!(result.is_ok());
    }

    // MockConnectionRepository取得成功のテスト (要件 17.4)
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

    // MockConnectionRepository存在しない接続の取得のテスト (要件 17.4)
    #[tokio::test]
    async fn test_mock_repo_get_non_existent() {
        let repo = MockConnectionRepository::new();

        let result = repo.get("non-existent").await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }

    // MockConnectionRepository保存エラーのテスト (要件 17.5)
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

    // MockConnectionRepository削除エラーのテスト (要件 17.5)
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

    // MockConnectionRepository取得エラーのテスト (要件 17.5)
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

    // 接続がエンドポイントURLを記録するテスト (要件 17.2)
    #[tokio::test]
    async fn test_connection_records_endpoint_url() {
        let repo = MockConnectionRepository::new();
        let endpoint_url = "https://abc123.execute-api.us-east-1.amazonaws.com/prod";

        repo.save("conn-123", endpoint_url).await.unwrap();

        let info = repo.get("conn-123").await.unwrap().unwrap();
        assert_eq!(info.endpoint_url, endpoint_url);
    }

    // 接続がconnected_atタイムスタンプを記録するテスト (要件 17.2)
    #[tokio::test]
    async fn test_connection_records_timestamp() {
        let repo = MockConnectionRepository::new();
        let before = DynamoConnectionRepository::current_timestamp();

        repo.save("conn-123", "https://example.com/stage").await.unwrap();

        let after = DynamoConnectionRepository::current_timestamp();
        let info = repo.get("conn-123").await.unwrap().unwrap();

        // connected_atはbeforeとafterの間であるべき
        assert!(info.connected_at >= before);
        assert!(info.connected_at <= after);
    }

    // 1つの接続を削除しても他に影響しないテスト (要件 17.3)
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
