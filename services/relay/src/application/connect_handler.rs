/// 接続ハンドラー
///
/// $connectルートでLambdaが呼び出された際の処理を実行する
/// 要件: 1.1, 17.1, 17.2
use serde_json::Value;

use crate::infrastructure::{ConnectionRepository, RepositoryError};

/// 接続ハンドラーのエラー型
#[derive(Debug, Clone, PartialEq)]
pub enum ConnectHandlerError {
    /// 必須フィールド（connectionId）が欠落
    MissingConnectionId,
    /// 必須フィールド（domainName）が欠落
    MissingDomainName,
    /// 必須フィールド（stage）が欠落
    MissingStage,
    /// requestContextが欠落
    MissingRequestContext,
    /// リポジトリ操作エラー
    RepositoryError(String),
}

impl From<RepositoryError> for ConnectHandlerError {
    fn from(err: RepositoryError) -> Self {
        ConnectHandlerError::RepositoryError(err.to_string())
    }
}

impl std::fmt::Display for ConnectHandlerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectHandlerError::MissingConnectionId => {
                write!(f, "Missing connectionId in request context")
            }
            ConnectHandlerError::MissingDomainName => {
                write!(f, "Missing domainName in request context")
            }
            ConnectHandlerError::MissingStage => {
                write!(f, "Missing stage in request context")
            }
            ConnectHandlerError::MissingRequestContext => {
                write!(f, "Missing requestContext in event")
            }
            ConnectHandlerError::RepositoryError(msg) => {
                write!(f, "Repository error: {}", msg)
            }
        }
    }
}

impl std::error::Error for ConnectHandlerError {}

/// WebSocket接続リクエストを処理するハンドラー
///
/// API Gateway WebSocketイベントから接続情報を抽出し、
/// ConnectionRepositoryを使用して永続化する
pub struct ConnectHandler<CR>
where
    CR: ConnectionRepository,
{
    /// 接続リポジトリ
    connection_repo: CR,
}

impl<CR> ConnectHandler<CR>
where
    CR: ConnectionRepository,
{
    /// 新しいConnectHandlerを作成
    pub fn new(connection_repo: CR) -> Self {
        Self { connection_repo }
    }

    /// WebSocket接続リクエストを処理
    ///
    /// # 処理フロー
    /// 1. イベントからrequestContextを取得
    /// 2. connectionId、domainName、stageを抽出
    /// 3. エンドポイントURLを構築
    /// 4. ConnectionRepositoryに接続情報を保存
    ///
    /// # 引数
    /// * `event` - API Gateway WebSocketイベント
    ///
    /// # 戻り値
    /// * 成功時は`Ok(())`
    /// * 失敗時は`Err(ConnectHandlerError)`
    ///
    /// 要件: 1.1, 17.1, 17.2
    pub async fn handle(&self, event: &Value) -> Result<(), ConnectHandlerError> {
        // requestContextを取得
        let request_context = event
            .get("requestContext")
            .ok_or(ConnectHandlerError::MissingRequestContext)?;

        // connectionIdを取得
        let connection_id = request_context
            .get("connectionId")
            .and_then(|v| v.as_str())
            .ok_or(ConnectHandlerError::MissingConnectionId)?;

        // domainNameを取得
        let domain_name = request_context
            .get("domainName")
            .and_then(|v| v.as_str())
            .ok_or(ConnectHandlerError::MissingDomainName)?;

        // stageを取得
        let stage = request_context
            .get("stage")
            .and_then(|v| v.as_str())
            .ok_or(ConnectHandlerError::MissingStage)?;

        // エンドポイントURLを構築
        let endpoint_url = format!("https://{}/{}", domain_name, stage);

        // 接続情報をリポジトリに保存
        self.connection_repo
            .save(connection_id, &endpoint_url)
            .await?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::connection_repository::tests::MockConnectionRepository;
    use serde_json::json;

    // ==================== テストヘルパー ====================

    /// テスト用のConnectHandlerを作成
    fn create_test_handler() -> (ConnectHandler<MockConnectionRepository>, MockConnectionRepository)
    {
        let connection_repo = MockConnectionRepository::new();
        let handler = ConnectHandler::new(connection_repo.clone());
        (handler, connection_repo)
    }

    /// 有効なAPI Gateway WebSocketイベントを作成
    fn create_valid_event() -> Value {
        json!({
            "requestContext": {
                "connectionId": "test-connection-123",
                "domainName": "abc123.execute-api.ap-northeast-1.amazonaws.com",
                "stage": "prod",
                "routeKey": "$connect"
            }
        })
    }

    // ==================== 5.1 接続ハンドラーテスト ====================

    /// 要件 1.1: 有効な接続リクエストを受け入れる
    #[tokio::test]
    async fn test_handle_valid_connection_request() {
        let (handler, _) = create_test_handler();
        let event = create_valid_event();

        let result = handler.handle(&event).await;

        assert!(result.is_ok());
    }

    /// 要件 17.1: 接続IDをDynamoDBに保存する
    #[tokio::test]
    async fn test_handle_saves_connection_id() {
        let (handler, connection_repo) = create_test_handler();
        let event = create_valid_event();

        handler.handle(&event).await.unwrap();

        // 接続が保存されたことを確認
        let info = connection_repo.get_connection("test-connection-123");
        assert!(info.is_some());
        assert_eq!(info.unwrap().connection_id, "test-connection-123");
    }

    /// 要件 17.2: エンドポイントURLを正しく構築して保存する
    #[tokio::test]
    async fn test_handle_saves_endpoint_url() {
        let (handler, connection_repo) = create_test_handler();
        let event = create_valid_event();

        handler.handle(&event).await.unwrap();

        let info = connection_repo.get_connection("test-connection-123").unwrap();
        assert_eq!(
            info.endpoint_url,
            "https://abc123.execute-api.ap-northeast-1.amazonaws.com/prod"
        );
    }

    /// 要件 17.2: 接続時刻を記録する
    #[tokio::test]
    async fn test_handle_records_connected_at() {
        let (handler, connection_repo) = create_test_handler();
        let event = create_valid_event();

        handler.handle(&event).await.unwrap();

        let info = connection_repo.get_connection("test-connection-123").unwrap();
        // connected_atは現在のUnixタイムスタンプ（2020年以降）であるべき
        assert!(info.connected_at > 1577836800);
    }

    // ==================== エラーケーステスト ====================

    /// requestContextが欠落している場合のエラー
    #[tokio::test]
    async fn test_handle_missing_request_context() {
        let (handler, _) = create_test_handler();
        let event = json!({});

        let result = handler.handle(&event).await;

        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            ConnectHandlerError::MissingRequestContext
        );
    }

    /// connectionIdが欠落している場合のエラー
    #[tokio::test]
    async fn test_handle_missing_connection_id() {
        let (handler, _) = create_test_handler();
        let event = json!({
            "requestContext": {
                "domainName": "example.com",
                "stage": "prod"
            }
        });

        let result = handler.handle(&event).await;

        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), ConnectHandlerError::MissingConnectionId);
    }

    /// domainNameが欠落している場合のエラー
    #[tokio::test]
    async fn test_handle_missing_domain_name() {
        let (handler, _) = create_test_handler();
        let event = json!({
            "requestContext": {
                "connectionId": "test-conn",
                "stage": "prod"
            }
        });

        let result = handler.handle(&event).await;

        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), ConnectHandlerError::MissingDomainName);
    }

    /// stageが欠落している場合のエラー
    #[tokio::test]
    async fn test_handle_missing_stage() {
        let (handler, _) = create_test_handler();
        let event = json!({
            "requestContext": {
                "connectionId": "test-conn",
                "domainName": "example.com"
            }
        });

        let result = handler.handle(&event).await;

        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), ConnectHandlerError::MissingStage);
    }

    /// 要件 17.5: リポジトリエラー時のエラーハンドリング
    #[tokio::test]
    async fn test_handle_repository_error() {
        let (handler, connection_repo) = create_test_handler();
        let event = create_valid_event();

        // リポジトリにエラーを設定
        connection_repo.set_next_error(RepositoryError::WriteError(
            "DynamoDB unavailable".to_string(),
        ));

        let result = handler.handle(&event).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            ConnectHandlerError::RepositoryError(msg) => {
                assert!(msg.contains("DynamoDB unavailable"));
            }
            _ => panic!("Expected RepositoryError"),
        }
    }

    // ==================== エンドポイントURL構築テスト ====================

    /// 様々なステージ名でエンドポイントURLを正しく構築
    #[tokio::test]
    async fn test_handle_endpoint_url_with_different_stages() {
        let (handler, connection_repo) = create_test_handler();

        // dev ステージ
        let event = json!({
            "requestContext": {
                "connectionId": "conn-dev",
                "domainName": "api.example.com",
                "stage": "dev"
            }
        });

        handler.handle(&event).await.unwrap();

        let info = connection_repo.get_connection("conn-dev").unwrap();
        assert_eq!(info.endpoint_url, "https://api.example.com/dev");
    }

    /// 複数の接続を保存
    #[tokio::test]
    async fn test_handle_multiple_connections() {
        let (handler, connection_repo) = create_test_handler();

        let event1 = json!({
            "requestContext": {
                "connectionId": "conn-1",
                "domainName": "api.example.com",
                "stage": "prod"
            }
        });

        let event2 = json!({
            "requestContext": {
                "connectionId": "conn-2",
                "domainName": "api.example.com",
                "stage": "prod"
            }
        });

        handler.handle(&event1).await.unwrap();
        handler.handle(&event2).await.unwrap();

        assert_eq!(connection_repo.connection_count(), 2);
        assert!(connection_repo.get_connection("conn-1").is_some());
        assert!(connection_repo.get_connection("conn-2").is_some());
    }

    // ==================== エラー型テスト ====================

    #[test]
    fn test_connect_handler_error_display() {
        assert_eq!(
            ConnectHandlerError::MissingConnectionId.to_string(),
            "Missing connectionId in request context"
        );
        assert_eq!(
            ConnectHandlerError::MissingDomainName.to_string(),
            "Missing domainName in request context"
        );
        assert_eq!(
            ConnectHandlerError::MissingStage.to_string(),
            "Missing stage in request context"
        );
        assert_eq!(
            ConnectHandlerError::MissingRequestContext.to_string(),
            "Missing requestContext in event"
        );
        assert_eq!(
            ConnectHandlerError::RepositoryError("test error".to_string()).to_string(),
            "Repository error: test error"
        );
    }

    #[test]
    fn test_connect_handler_error_from_repository_error() {
        let repo_err = RepositoryError::WriteError("test".to_string());
        let handler_err: ConnectHandlerError = repo_err.into();
        match handler_err {
            ConnectHandlerError::RepositoryError(msg) => {
                assert!(msg.contains("Write error"));
            }
            _ => panic!("Expected RepositoryError"),
        }
    }
}
