/// 切断ハンドラー
///
/// $disconnectルートでLambdaが呼び出された際の処理を実行する
/// 要件: 1.2, 1.3, 17.3, 18.5
use serde_json::Value;

use crate::infrastructure::{
    ConnectionRepository, RepositoryError, SubscriptionRepository, SubscriptionRepositoryError,
};

/// 切断ハンドラーのエラー型
#[derive(Debug, Clone, PartialEq)]
pub enum DisconnectHandlerError {
    /// 必須フィールド（connectionId）が欠落
    MissingConnectionId,
    /// requestContextが欠落
    MissingRequestContext,
    /// サブスクリプションリポジトリ操作エラー
    SubscriptionRepositoryError(String),
    /// 接続リポジトリ操作エラー
    ConnectionRepositoryError(String),
}

impl From<RepositoryError> for DisconnectHandlerError {
    fn from(err: RepositoryError) -> Self {
        DisconnectHandlerError::ConnectionRepositoryError(err.to_string())
    }
}

impl From<SubscriptionRepositoryError> for DisconnectHandlerError {
    fn from(err: SubscriptionRepositoryError) -> Self {
        DisconnectHandlerError::SubscriptionRepositoryError(err.to_string())
    }
}

impl std::fmt::Display for DisconnectHandlerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DisconnectHandlerError::MissingConnectionId => {
                write!(f, "Missing connectionId in request context")
            }
            DisconnectHandlerError::MissingRequestContext => {
                write!(f, "Missing requestContext in event")
            }
            DisconnectHandlerError::SubscriptionRepositoryError(msg) => {
                write!(f, "Subscription repository error: {}", msg)
            }
            DisconnectHandlerError::ConnectionRepositoryError(msg) => {
                write!(f, "Connection repository error: {}", msg)
            }
        }
    }
}

impl std::error::Error for DisconnectHandlerError {}

/// WebSocket切断リクエストを処理するハンドラー
///
/// API Gateway WebSocketイベントから接続IDを抽出し、
/// 関連するサブスクリプションと接続レコードを削除する
pub struct DisconnectHandler<CR, SR>
where
    CR: ConnectionRepository,
    SR: SubscriptionRepository,
{
    /// 接続リポジトリ
    connection_repo: CR,
    /// サブスクリプションリポジトリ
    subscription_repo: SR,
}

impl<CR, SR> DisconnectHandler<CR, SR>
where
    CR: ConnectionRepository,
    SR: SubscriptionRepository,
{
    /// 新しいDisconnectHandlerを作成
    pub fn new(connection_repo: CR, subscription_repo: SR) -> Self {
        Self {
            connection_repo,
            subscription_repo,
        }
    }

    /// WebSocket切断リクエストを処理
    ///
    /// # 処理フロー
    /// 1. イベントからrequestContextを取得
    /// 2. connectionIdを抽出
    /// 3. 関連する全サブスクリプションを削除（要件 18.5）
    /// 4. 接続レコードを削除（要件 17.3）
    ///
    /// # 引数
    /// * `event` - API Gateway WebSocketイベント
    ///
    /// # 戻り値
    /// * 成功時は`Ok(())`
    /// * 失敗時は`Err(DisconnectHandlerError)`
    ///
    /// 要件: 1.2, 1.3, 17.3, 18.5
    pub async fn handle(&self, event: &Value) -> Result<(), DisconnectHandlerError> {
        // requestContextを取得
        let request_context = event
            .get("requestContext")
            .ok_or(DisconnectHandlerError::MissingRequestContext)?;

        // connectionIdを取得
        let connection_id = request_context
            .get("connectionId")
            .and_then(|v| v.as_str())
            .ok_or(DisconnectHandlerError::MissingConnectionId)?;

        // 関連する全サブスクリプションを削除（要件 18.5, 1.2）
        self.subscription_repo
            .delete_by_connection(connection_id)
            .await?;

        // 接続レコードを削除（要件 17.3）
        self.connection_repo.delete(connection_id).await?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::connection_repository::tests::MockConnectionRepository;
    use crate::infrastructure::subscription_repository::tests::MockSubscriptionRepository;
    use nostr::{Filter, Kind};
    use serde_json::json;

    // ==================== テストヘルパー ====================

    /// テスト用のDisconnectHandlerを作成
    fn create_test_handler() -> (
        DisconnectHandler<MockConnectionRepository, MockSubscriptionRepository>,
        MockConnectionRepository,
        MockSubscriptionRepository,
    ) {
        let connection_repo = MockConnectionRepository::new();
        let subscription_repo = MockSubscriptionRepository::new();
        let handler = DisconnectHandler::new(connection_repo.clone(), subscription_repo.clone());
        (handler, connection_repo, subscription_repo)
    }

    /// 有効なAPI Gateway WebSocket切断イベントを作成
    fn create_valid_disconnect_event() -> Value {
        json!({
            "requestContext": {
                "connectionId": "test-connection-123",
                "routeKey": "$disconnect"
            }
        })
    }

    // ==================== 5.2 切断ハンドラーテスト ====================

    /// 要件 1.2: 有効な切断リクエストを処理する
    #[tokio::test]
    async fn test_handle_valid_disconnect_request() {
        let (handler, _, _) = create_test_handler();
        let event = create_valid_disconnect_event();

        let result = handler.handle(&event).await;

        assert!(result.is_ok());
    }

    /// 要件 17.3: 接続レコードを削除する
    #[tokio::test]
    async fn test_handle_deletes_connection_record() {
        let (handler, connection_repo, _) = create_test_handler();

        // 事前に接続を保存
        connection_repo
            .save("test-connection-123", "https://example.com/prod")
            .await
            .unwrap();
        assert_eq!(connection_repo.connection_count(), 1);

        let event = create_valid_disconnect_event();
        handler.handle(&event).await.unwrap();

        // 接続が削除されたことを確認
        assert_eq!(connection_repo.connection_count(), 0);
        assert!(connection_repo.get_connection("test-connection-123").is_none());
    }

    /// 要件 18.5: 関連する全サブスクリプションを削除する
    #[tokio::test]
    async fn test_handle_deletes_all_subscriptions() {
        let (handler, _, subscription_repo) = create_test_handler();
        let filters = vec![Filter::new().kind(Kind::TextNote)];

        // 事前にサブスクリプションを保存
        subscription_repo
            .upsert("test-connection-123", "sub-1", &filters)
            .await
            .unwrap();
        subscription_repo
            .upsert("test-connection-123", "sub-2", &filters)
            .await
            .unwrap();
        subscription_repo
            .upsert("other-connection", "sub-3", &filters)
            .await
            .unwrap();
        assert_eq!(subscription_repo.subscription_count(), 3);

        let event = create_valid_disconnect_event();
        handler.handle(&event).await.unwrap();

        // 該当接続のサブスクリプションのみ削除されたことを確認
        assert_eq!(subscription_repo.subscription_count(), 1);
        assert!(subscription_repo
            .get_subscription_sync("test-connection-123", "sub-1")
            .is_none());
        assert!(subscription_repo
            .get_subscription_sync("test-connection-123", "sub-2")
            .is_none());
        assert!(subscription_repo
            .get_subscription_sync("other-connection", "sub-3")
            .is_some());
    }

    /// 要件 1.3: 接続ごとにサブスクリプションを独立して管理
    #[tokio::test]
    async fn test_handle_does_not_affect_other_connections() {
        let (handler, connection_repo, subscription_repo) = create_test_handler();
        let filters = vec![Filter::new().kind(Kind::TextNote)];

        // 複数の接続とサブスクリプションを保存
        connection_repo
            .save("test-connection-123", "https://example.com/prod")
            .await
            .unwrap();
        connection_repo
            .save("other-connection", "https://example.com/prod")
            .await
            .unwrap();
        subscription_repo
            .upsert("test-connection-123", "sub-1", &filters)
            .await
            .unwrap();
        subscription_repo
            .upsert("other-connection", "sub-2", &filters)
            .await
            .unwrap();

        let event = create_valid_disconnect_event();
        handler.handle(&event).await.unwrap();

        // 他の接続は影響を受けないことを確認
        assert!(connection_repo.get_connection("other-connection").is_some());
        assert!(subscription_repo
            .get_subscription_sync("other-connection", "sub-2")
            .is_some());
    }

    /// サブスクリプションがない場合も正常に処理する
    #[tokio::test]
    async fn test_handle_no_subscriptions() {
        let (handler, connection_repo, _) = create_test_handler();

        // 接続のみ保存（サブスクリプションなし）
        connection_repo
            .save("test-connection-123", "https://example.com/prod")
            .await
            .unwrap();

        let event = create_valid_disconnect_event();
        let result = handler.handle(&event).await;

        assert!(result.is_ok());
        assert!(connection_repo.get_connection("test-connection-123").is_none());
    }

    /// 接続レコードが存在しない場合も正常に処理する
    #[tokio::test]
    async fn test_handle_no_connection_record() {
        let (handler, _, _) = create_test_handler();
        let event = create_valid_disconnect_event();

        // 接続レコードがなくても正常に処理される
        let result = handler.handle(&event).await;
        assert!(result.is_ok());
    }

    // ==================== エラーケーステスト ====================

    /// requestContextが欠落している場合のエラー
    #[tokio::test]
    async fn test_handle_missing_request_context() {
        let (handler, _, _) = create_test_handler();
        let event = json!({});

        let result = handler.handle(&event).await;

        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            DisconnectHandlerError::MissingRequestContext
        );
    }

    /// connectionIdが欠落している場合のエラー
    #[tokio::test]
    async fn test_handle_missing_connection_id() {
        let (handler, _, _) = create_test_handler();
        let event = json!({
            "requestContext": {
                "routeKey": "$disconnect"
            }
        });

        let result = handler.handle(&event).await;

        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            DisconnectHandlerError::MissingConnectionId
        );
    }

    /// サブスクリプションリポジトリエラー時のエラーハンドリング
    #[tokio::test]
    async fn test_handle_subscription_repository_error() {
        let (handler, _, subscription_repo) = create_test_handler();
        let event = create_valid_disconnect_event();

        // サブスクリプションリポジトリにエラーを設定
        subscription_repo.set_next_error(SubscriptionRepositoryError::ReadError(
            "DynamoDB unavailable".to_string(),
        ));

        let result = handler.handle(&event).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            DisconnectHandlerError::SubscriptionRepositoryError(msg) => {
                assert!(msg.contains("DynamoDB unavailable"));
            }
            _ => panic!("Expected SubscriptionRepositoryError"),
        }
    }

    /// 接続リポジトリエラー時のエラーハンドリング
    #[tokio::test]
    async fn test_handle_connection_repository_error() {
        let (handler, connection_repo, _) = create_test_handler();
        let event = create_valid_disconnect_event();

        // 接続リポジトリにエラーを設定
        connection_repo.set_next_error(RepositoryError::WriteError(
            "DynamoDB unavailable".to_string(),
        ));

        let result = handler.handle(&event).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            DisconnectHandlerError::ConnectionRepositoryError(msg) => {
                assert!(msg.contains("DynamoDB unavailable"));
            }
            _ => panic!("Expected ConnectionRepositoryError"),
        }
    }

    // ==================== エラー型テスト ====================

    #[test]
    fn test_disconnect_handler_error_display() {
        assert_eq!(
            DisconnectHandlerError::MissingConnectionId.to_string(),
            "Missing connectionId in request context"
        );
        assert_eq!(
            DisconnectHandlerError::MissingRequestContext.to_string(),
            "Missing requestContext in event"
        );
        assert_eq!(
            DisconnectHandlerError::SubscriptionRepositoryError("test error".to_string())
                .to_string(),
            "Subscription repository error: test error"
        );
        assert_eq!(
            DisconnectHandlerError::ConnectionRepositoryError("test error".to_string()).to_string(),
            "Connection repository error: test error"
        );
    }

    #[test]
    fn test_disconnect_handler_error_from_repository_error() {
        let repo_err = RepositoryError::WriteError("test".to_string());
        let handler_err: DisconnectHandlerError = repo_err.into();
        match handler_err {
            DisconnectHandlerError::ConnectionRepositoryError(msg) => {
                assert!(msg.contains("Write error"));
            }
            _ => panic!("Expected ConnectionRepositoryError"),
        }
    }

    #[test]
    fn test_disconnect_handler_error_from_subscription_repository_error() {
        let repo_err = SubscriptionRepositoryError::ReadError("test".to_string());
        let handler_err: DisconnectHandlerError = repo_err.into();
        match handler_err {
            DisconnectHandlerError::SubscriptionRepositoryError(msg) => {
                assert!(msg.contains("Read error"));
            }
            _ => panic!("Expected SubscriptionRepositoryError"),
        }
    }

    /// 処理順序のテスト: サブスクリプション削除が接続削除より先に実行される
    #[tokio::test]
    async fn test_handle_order_subscriptions_before_connection() {
        let (handler, connection_repo, subscription_repo) = create_test_handler();
        let filters = vec![Filter::new().kind(Kind::TextNote)];

        // 接続とサブスクリプションを保存
        connection_repo
            .save("test-connection-123", "https://example.com/prod")
            .await
            .unwrap();
        subscription_repo
            .upsert("test-connection-123", "sub-1", &filters)
            .await
            .unwrap();

        let event = create_valid_disconnect_event();
        handler.handle(&event).await.unwrap();

        // 両方とも削除されていることを確認
        assert!(connection_repo.get_connection("test-connection-123").is_none());
        assert!(subscription_repo
            .get_subscription_sync("test-connection-123", "sub-1")
            .is_none());
    }
}
