/// デフォルトハンドラー
///
/// $defaultルートでLambdaが呼び出された際の処理を実行する
/// 要件: 5.1, 6.1, 7.1, 14.4, 15.1, 15.2, 15.3
use serde_json::Value;

use crate::application::{ClientMessage, EventHandler, MessageParser, ParseError, SubscriptionHandler};
use crate::domain::{LimitationConfig, RelayMessage};
use crate::infrastructure::{EventRepository, SubscriptionRepository, WebSocketSender};

/// デフォルトハンドラーのエラー型
#[derive(Debug, Clone, PartialEq)]
pub enum DefaultHandlerError {
    /// 必須フィールド（connectionId）が欠落
    MissingConnectionId,
    /// 必須フィールド（body）が欠落
    MissingBody,
    /// requestContextが欠落
    MissingRequestContext,
    /// WebSocket送信エラー
    SendError(String),
}

impl std::fmt::Display for DefaultHandlerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DefaultHandlerError::MissingConnectionId => {
                write!(f, "Missing connectionId in request context")
            }
            DefaultHandlerError::MissingBody => {
                write!(f, "Missing body in event")
            }
            DefaultHandlerError::MissingRequestContext => {
                write!(f, "Missing requestContext in event")
            }
            DefaultHandlerError::SendError(msg) => {
                write!(f, "Send error: {}", msg)
            }
        }
    }
}

impl std::error::Error for DefaultHandlerError {}

/// WebSocketメッセージを処理するデフォルトハンドラー
///
/// API Gateway WebSocketの$defaultルートで呼び出され、
/// EVENT, REQ, CLOSEメッセージをそれぞれ適切なハンドラーに委譲する
pub struct DefaultHandler<ER, SR, WS>
where
    ER: EventRepository,
    SR: SubscriptionRepository,
    WS: WebSocketSender,
{
    /// イベントハンドラー
    event_handler: EventHandler<ER, SR, WS>,
    /// サブスクリプションハンドラー
    subscription_handler: SubscriptionHandler<ER, SR, WS>,
    /// WebSocket送信
    ws_sender: WS,
    /// 制限値設定
    limitation_config: LimitationConfig,
}

impl<ER, SR, WS> DefaultHandler<ER, SR, WS>
where
    ER: EventRepository + Clone,
    SR: SubscriptionRepository + Clone,
    WS: WebSocketSender + Clone,
{
    /// 新しいDefaultHandlerを作成
    pub fn new(event_repo: ER, subscription_repo: SR, ws_sender: WS) -> Self {
        Self::with_config(event_repo, subscription_repo, ws_sender, LimitationConfig::default())
    }

    /// 制限値設定を指定してDefaultHandlerを作成
    pub fn with_config(
        event_repo: ER,
        subscription_repo: SR,
        ws_sender: WS,
        limitation_config: LimitationConfig,
    ) -> Self {
        let event_handler = EventHandler::new(
            event_repo.clone(),
            subscription_repo.clone(),
            ws_sender.clone(),
        );
        let subscription_handler = SubscriptionHandler::new(
            event_repo,
            subscription_repo,
            ws_sender.clone(),
        );

        Self {
            event_handler,
            subscription_handler,
            ws_sender,
            limitation_config,
        }
    }

    /// WebSocketメッセージを処理
    ///
    /// # 処理フロー
    /// 1. イベントからrequestContextとbodyを取得
    /// 2. メッセージをパース
    /// 3. メッセージタイプに応じてハンドラーに委譲
    /// 4. 応答をWebSocket経由でクライアントに送信
    ///
    /// # 引数
    /// * `event` - API Gateway WebSocketイベント
    ///
    /// # 戻り値
    /// * 成功時は`Ok(())`
    /// * 失敗時は`Err(DefaultHandlerError)`
    ///
    /// 要件: 5.1, 6.1, 7.1, 14.4, 15.1, 15.2, 15.3
    pub async fn handle(&self, event: &Value) -> Result<(), DefaultHandlerError> {
        // requestContextを取得
        let request_context = event
            .get("requestContext")
            .ok_or(DefaultHandlerError::MissingRequestContext)?;

        // connectionIdを取得
        let connection_id = request_context
            .get("connectionId")
            .and_then(|v| v.as_str())
            .ok_or(DefaultHandlerError::MissingConnectionId)?;

        // bodyを取得
        let body = event
            .get("body")
            .and_then(|v| v.as_str())
            .ok_or(DefaultHandlerError::MissingBody)?;

        // メッセージをパース
        let client_message = match MessageParser::parse(body) {
            Ok(msg) => msg,
            Err(err) => {
                // パースエラー時はNOTICE応答を送信 (要件 15.1, 15.2, 15.3)
                let notice = self.create_parse_error_notice(&err);
                let _ = self.ws_sender.send(connection_id, &notice.to_json()).await;
                return Ok(());
            }
        };

        // メッセージタイプに応じてハンドラーに委譲
        match client_message {
            ClientMessage::Event(event_json) => {
                // EVENTメッセージを処理 (要件 5.1, 3.4-3.7)
                let response = self.event_handler
                    .handle_with_config(event_json, connection_id, &self.limitation_config)
                    .await;
                let _ = self.ws_sender.send(connection_id, &response.to_json()).await;
            }
            ClientMessage::Req { subscription_id, filters } => {
                // REQメッセージを処理 (要件 6.1)
                // SubscriptionHandlerは内部でEVENT/EOSEを送信するため、ここでは結果を無視
                let _ = self.subscription_handler
                    .handle_req(subscription_id, filters, connection_id, &self.limitation_config)
                    .await;
            }
            ClientMessage::Close { subscription_id } => {
                // CLOSEメッセージを処理 (要件 7.1)
                let _ = self.subscription_handler
                    .handle_close(subscription_id, connection_id, &self.limitation_config)
                    .await;
            }
        }

        Ok(())
    }

    /// パースエラーに応じたNOTICEメッセージを作成
    fn create_parse_error_notice(&self, err: &ParseError) -> RelayMessage {
        match err {
            ParseError::InvalidJson => RelayMessage::notice_parse_error(),
            ParseError::NotArray => RelayMessage::notice_invalid_format(),
            ParseError::UnknownMessageType(_) => RelayMessage::notice_unknown_type(),
            _ => RelayMessage::notice_invalid_format(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::event_repository::tests::MockEventRepository;
    use crate::infrastructure::subscription_repository::tests::MockSubscriptionRepository;
    use crate::infrastructure::websocket_sender::tests::MockWebSocketSender;
    use nostr::{EventBuilder, Keys, Kind};
    use serde_json::json;

    // ==================== テストヘルパー ====================

    /// テスト用のDefaultHandlerを作成
    fn create_test_handler() -> (
        DefaultHandler<MockEventRepository, MockSubscriptionRepository, MockWebSocketSender>,
        MockEventRepository,
        MockSubscriptionRepository,
        MockWebSocketSender,
    ) {
        let event_repo = MockEventRepository::new();
        let subscription_repo = MockSubscriptionRepository::new();
        let ws_sender = MockWebSocketSender::new();

        let handler = DefaultHandler::new(
            event_repo.clone(),
            subscription_repo.clone(),
            ws_sender.clone(),
        );

        (handler, event_repo, subscription_repo, ws_sender)
    }

    /// 有効なAPI Gateway WebSocket $defaultイベントを作成
    fn create_valid_event(body: &str) -> Value {
        json!({
            "requestContext": {
                "connectionId": "test-connection-123",
                "domainName": "abc123.execute-api.ap-northeast-1.amazonaws.com",
                "stage": "prod",
                "routeKey": "$default"
            },
            "body": body
        })
    }

    /// 有効なテストイベントを作成
    fn create_valid_nostr_event() -> nostr::Event {
        let keys = Keys::generate();
        EventBuilder::text_note("test content")
            .sign_with_keys(&keys)
            .expect("Failed to create event")
    }

    // ==================== 5.3 デフォルトハンドラー統合テスト ====================

    /// 要件 5.1: EVENTメッセージをイベントハンドラーに委譲
    #[tokio::test]
    async fn test_handle_event_message() {
        let (handler, event_repo, _, ws_sender) = create_test_handler();

        // 有効なNostrイベントを作成
        let nostr_event = create_valid_nostr_event();
        let event_json = serde_json::to_value(&nostr_event).unwrap();
        let message = json!(["EVENT", event_json]).to_string();

        let event = create_valid_event(&message);
        let result = handler.handle(&event).await;

        assert!(result.is_ok());

        // イベントが保存されたことを確認
        assert_eq!(event_repo.event_count(), 1);

        // OK応答が送信されたことを確認
        let messages = ws_sender.get_sent_messages("test-connection-123");
        assert_eq!(messages.len(), 1);
        let sent: Value = serde_json::from_str(&messages[0]).unwrap();
        assert_eq!(sent[0], "OK");
        assert_eq!(sent[2], true); // accepted
    }

    /// 要件 6.1: REQメッセージをサブスクリプションハンドラーに委譲
    #[tokio::test]
    async fn test_handle_req_message() {
        let (handler, _, subscription_repo, ws_sender) = create_test_handler();

        let message = json!(["REQ", "sub-1", {"kinds": [1]}]).to_string();
        let event = create_valid_event(&message);

        let result = handler.handle(&event).await;

        assert!(result.is_ok());

        // サブスクリプションが作成されたことを確認
        let sub = subscription_repo.get("test-connection-123", "sub-1").await.unwrap();
        assert!(sub.is_some());

        // EOSEが送信されたことを確認
        let messages = ws_sender.get_sent_messages("test-connection-123");
        assert!(!messages.is_empty());
        let last_msg: Value = serde_json::from_str(messages.last().unwrap()).unwrap();
        assert_eq!(last_msg[0], "EOSE");
    }

    /// 要件 7.1: CLOSEメッセージをサブスクリプションハンドラーに委譲
    #[tokio::test]
    async fn test_handle_close_message() {
        let (handler, _, subscription_repo, _) = create_test_handler();

        // 先にサブスクリプションを作成
        let filter = nostr::Filter::new().kind(Kind::TextNote);
        subscription_repo
            .upsert("test-connection-123", "sub-1", &[filter])
            .await
            .unwrap();
        assert!(subscription_repo.get("test-connection-123", "sub-1").await.unwrap().is_some());

        // CLOSEメッセージを処理
        let message = json!(["CLOSE", "sub-1"]).to_string();
        let event = create_valid_event(&message);

        let result = handler.handle(&event).await;

        assert!(result.is_ok());

        // サブスクリプションが削除されたことを確認
        assert!(subscription_repo.get("test-connection-123", "sub-1").await.unwrap().is_none());
    }

    // ==================== パースエラーテスト (要件 15.1, 15.2, 15.3) ====================

    /// 要件 15.3: 無効なJSONの場合はNOTICE応答を送信
    #[tokio::test]
    async fn test_handle_invalid_json_sends_notice() {
        let (handler, _, _, ws_sender) = create_test_handler();

        let message = "not valid json";
        let event = create_valid_event(message);

        let result = handler.handle(&event).await;

        // エラーにはならない（NOTICEを送信して正常終了）
        assert!(result.is_ok());

        // NOTICE応答が送信されたことを確認
        let messages = ws_sender.get_sent_messages("test-connection-123");
        assert_eq!(messages.len(), 1);
        let sent: Value = serde_json::from_str(&messages[0]).unwrap();
        assert_eq!(sent[0], "NOTICE");
        assert!(sent[1].as_str().unwrap().contains("failed to parse JSON"));
    }

    /// 要件 15.1: 配列でないメッセージの場合はNOTICE応答を送信
    #[tokio::test]
    async fn test_handle_not_array_sends_notice() {
        let (handler, _, _, ws_sender) = create_test_handler();

        let message = r#"{"type": "EVENT"}"#;
        let event = create_valid_event(message);

        let result = handler.handle(&event).await;

        assert!(result.is_ok());

        let messages = ws_sender.get_sent_messages("test-connection-123");
        assert_eq!(messages.len(), 1);
        let sent: Value = serde_json::from_str(&messages[0]).unwrap();
        assert_eq!(sent[0], "NOTICE");
        assert!(sent[1].as_str().unwrap().contains("invalid message format"));
    }

    /// 要件 15.2: 未知のメッセージタイプの場合はNOTICE応答を送信
    #[tokio::test]
    async fn test_handle_unknown_type_sends_notice() {
        let (handler, _, _, ws_sender) = create_test_handler();

        let message = r#"["UNKNOWN", "data"]"#;
        let event = create_valid_event(message);

        let result = handler.handle(&event).await;

        assert!(result.is_ok());

        let messages = ws_sender.get_sent_messages("test-connection-123");
        assert_eq!(messages.len(), 1);
        let sent: Value = serde_json::from_str(&messages[0]).unwrap();
        assert_eq!(sent[0], "NOTICE");
        assert!(sent[1].as_str().unwrap().contains("unknown message type"));
    }

    // ==================== エラーケーステスト ====================

    /// requestContextが欠落している場合のエラー
    #[tokio::test]
    async fn test_handle_missing_request_context() {
        let (handler, _, _, _) = create_test_handler();

        let event = json!({
            "body": r#"["EVENT", {}]"#
        });

        let result = handler.handle(&event).await;

        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            DefaultHandlerError::MissingRequestContext
        );
    }

    /// connectionIdが欠落している場合のエラー
    #[tokio::test]
    async fn test_handle_missing_connection_id() {
        let (handler, _, _, _) = create_test_handler();

        let event = json!({
            "requestContext": {
                "routeKey": "$default"
            },
            "body": r#"["EVENT", {}]"#
        });

        let result = handler.handle(&event).await;

        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            DefaultHandlerError::MissingConnectionId
        );
    }

    /// bodyが欠落している場合のエラー
    #[tokio::test]
    async fn test_handle_missing_body() {
        let (handler, _, _, _) = create_test_handler();

        let event = json!({
            "requestContext": {
                "connectionId": "test-connection-123",
                "routeKey": "$default"
            }
        });

        let result = handler.handle(&event).await;

        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            DefaultHandlerError::MissingBody
        );
    }

    // ==================== 複合シナリオテスト ====================

    /// REQでイベントを取得し、EOSEを受け取る
    #[tokio::test]
    async fn test_handle_req_with_existing_events() {
        let (handler, event_repo, _, ws_sender) = create_test_handler();

        // 先にイベントを保存
        let nostr_event = create_valid_nostr_event();
        event_repo.save(&nostr_event).await.unwrap();

        // REQメッセージを処理
        let message = json!(["REQ", "sub-1", {"kinds": [1]}]).to_string();
        let event = create_valid_event(&message);

        handler.handle(&event).await.unwrap();

        // EVENT + EOSE が送信されたことを確認
        let messages = ws_sender.get_sent_messages("test-connection-123");
        assert_eq!(messages.len(), 2);

        let event_msg: Value = serde_json::from_str(&messages[0]).unwrap();
        assert_eq!(event_msg[0], "EVENT");

        let eose_msg: Value = serde_json::from_str(&messages[1]).unwrap();
        assert_eq!(eose_msg[0], "EOSE");
    }

    /// 無効なイベントの場合はOK(false)応答を送信
    #[tokio::test]
    async fn test_handle_invalid_event_sends_ok_error() {
        let (handler, _, _, ws_sender) = create_test_handler();

        // 無効なイベント（IDが短い）
        let invalid_event = json!({
            "id": "invalid",
            "pubkey": "a".repeat(64),
            "created_at": 1234567890,
            "kind": 1,
            "tags": [],
            "content": "hello",
            "sig": "b".repeat(128)
        });
        let message = json!(["EVENT", invalid_event]).to_string();
        let event = create_valid_event(&message);

        handler.handle(&event).await.unwrap();

        // OK(false)応答が送信されたことを確認
        let messages = ws_sender.get_sent_messages("test-connection-123");
        assert_eq!(messages.len(), 1);
        let sent: Value = serde_json::from_str(&messages[0]).unwrap();
        assert_eq!(sent[0], "OK");
        assert_eq!(sent[2], false); // accepted = false
        assert!(sent[3].as_str().unwrap().contains("invalid:"));
    }

    // ==================== エラー型テスト ====================

    #[test]
    fn test_default_handler_error_display() {
        assert_eq!(
            DefaultHandlerError::MissingConnectionId.to_string(),
            "Missing connectionId in request context"
        );
        assert_eq!(
            DefaultHandlerError::MissingBody.to_string(),
            "Missing body in event"
        );
        assert_eq!(
            DefaultHandlerError::MissingRequestContext.to_string(),
            "Missing requestContext in event"
        );
        assert_eq!(
            DefaultHandlerError::SendError("test error".to_string()).to_string(),
            "Send error: test error"
        );
    }
}
