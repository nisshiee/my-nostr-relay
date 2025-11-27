/// サブスクリプションハンドラー
///
/// NIP-01準拠のREQ/CLOSEメッセージ処理を実行する
/// 要件: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 7.1, 7.2
use nostr::Filter;
use serde_json::Value;
use thiserror::Error;

use crate::domain::{FilterEvaluator, FilterValidationError, RelayMessage};
use crate::infrastructure::{
    EventRepository, EventRepositoryError, SendError, SubscriptionRepository,
    SubscriptionRepositoryError, WebSocketSender,
};

/// サブスクリプションハンドラーのエラー型
#[derive(Debug, Clone, Error)]
pub enum SubscriptionHandlerError {
    /// 無効なサブスクリプションID (要件 6.6, 6.7)
    #[error("invalid subscription id: {0}")]
    InvalidSubscriptionId(String),

    /// フィルター検証エラー (要件 8.11)
    #[error("invalid filter: {0}")]
    InvalidFilter(String),

    /// リポジトリエラー (要件 18.8)
    #[error("repository error: {0}")]
    RepositoryError(String),

    /// WebSocket送信エラー
    #[error("send error: {0}")]
    SendError(String),
}

impl From<SubscriptionRepositoryError> for SubscriptionHandlerError {
    fn from(err: SubscriptionRepositoryError) -> Self {
        SubscriptionHandlerError::RepositoryError(err.to_string())
    }
}

impl From<EventRepositoryError> for SubscriptionHandlerError {
    fn from(err: EventRepositoryError) -> Self {
        SubscriptionHandlerError::RepositoryError(err.to_string())
    }
}

impl From<SendError> for SubscriptionHandlerError {
    fn from(err: SendError) -> Self {
        SubscriptionHandlerError::SendError(err.to_string())
    }
}

impl From<FilterValidationError> for SubscriptionHandlerError {
    fn from(err: FilterValidationError) -> Self {
        SubscriptionHandlerError::InvalidFilter(err.to_string())
    }
}

/// REQ/CLOSEメッセージを処理するハンドラー
///
/// サブスクリプションの作成、クエリ実行、イベント配信を行う
pub struct SubscriptionHandler<ER, SR, WS>
where
    ER: EventRepository,
    SR: SubscriptionRepository,
    WS: WebSocketSender,
{
    /// イベントリポジトリ
    event_repo: ER,
    /// サブスクリプションリポジトリ
    subscription_repo: SR,
    /// WebSocket送信
    ws_sender: WS,
}

impl<ER, SR, WS> SubscriptionHandler<ER, SR, WS>
where
    ER: EventRepository,
    SR: SubscriptionRepository,
    WS: WebSocketSender,
{
    /// 新しいSubscriptionHandlerを作成
    pub fn new(event_repo: ER, subscription_repo: SR, ws_sender: WS) -> Self {
        Self {
            event_repo,
            subscription_repo,
            ws_sender,
        }
    }

    /// REQメッセージを処理 (要件 6.1-6.7)
    ///
    /// # 処理フロー
    /// 1. subscription_idの検証（1-64文字）
    /// 2. フィルター条件のパースと検証
    /// 3. サブスクリプションを作成/更新
    /// 4. フィルターに合致する保存済みイベントをクエリ
    /// 5. 取得したイベントをEVENT応答として送信
    /// 6. EOSE応答を送信
    ///
    /// # 引数
    /// * `subscription_id` - サブスクリプションID
    /// * `filter_values` - フィルター条件のJSON配列
    /// * `connection_id` - API Gateway接続ID
    ///
    /// # 戻り値
    /// 成功時はOk(()), エラー時はErr(SubscriptionHandlerError)
    /// エラー発生時はCLOSED応答をクライアントに送信済み
    pub async fn handle_req(
        &self,
        subscription_id: String,
        filter_values: Vec<Value>,
        connection_id: &str,
    ) -> Result<(), SubscriptionHandlerError> {
        // subscription_idの検証 (要件 6.6, 6.7)
        if let Err(e) = Self::validate_subscription_id(&subscription_id) {
            // CLOSED応答を送信
            let closed_msg = RelayMessage::closed_invalid_subscription_id(&subscription_id);
            let _ = self.ws_sender.send(connection_id, &closed_msg.to_json()).await;
            return Err(e);
        }

        // フィルター条件をパース (要件 6.1)
        let filters = match self.parse_filters(&filter_values) {
            Ok(filters) => filters,
            Err(e) => {
                // CLOSED応答を送信
                let closed_msg = RelayMessage::closed_invalid(&subscription_id, &e.to_string());
                let _ = self.ws_sender.send(connection_id, &closed_msg.to_json()).await;
                return Err(e);
            }
        };

        // フィルター検証 (要件 8.11)
        for filter in &filters {
            if let Err(e) = FilterEvaluator::validate_filter(filter) {
                let closed_msg = RelayMessage::closed_invalid(&subscription_id, &e.to_string());
                let _ = self.ws_sender.send(connection_id, &closed_msg.to_json()).await;
                return Err(e.into());
            }
        }

        // サブスクリプションを作成/更新 (要件 6.4, 18.1, 18.4)
        if let Err(e) = self.subscription_repo.upsert(connection_id, &subscription_id, &filters).await {
            // CLOSED応答を送信 (要件 18.8)
            let closed_msg = RelayMessage::closed_subscription_error(&subscription_id);
            let _ = self.ws_sender.send(connection_id, &closed_msg.to_json()).await;
            return Err(e.into());
        }

        // フィルターに合致する保存済みイベントをクエリ (要件 6.2)
        // limitはフィルターから取得（複数フィルターの場合は最小値を使用）
        let limit = self.extract_limit(&filters);
        let events = match self.event_repo.query(&filters, limit).await {
            Ok(events) => events,
            Err(e) => {
                // クエリエラー時もCLOSED応答を送信
                let closed_msg = RelayMessage::closed_subscription_error(&subscription_id);
                let _ = self.ws_sender.send(connection_id, &closed_msg.to_json()).await;
                return Err(e.into());
            }
        };

        // 取得したイベントを順次EVENT応答として送信 (要件 6.2)
        for event in events {
            let event_msg = RelayMessage::Event {
                subscription_id: subscription_id.clone(),
                event,
            };
            // 送信エラーは無視（接続切れ等は後続処理で対応）
            let _ = self.ws_sender.send(connection_id, &event_msg.to_json()).await;
        }

        // EOSE応答を送信 (要件 6.3)
        let eose_msg = RelayMessage::Eose {
            subscription_id: subscription_id.clone(),
        };
        let _ = self.ws_sender.send(connection_id, &eose_msg.to_json()).await;

        Ok(())
    }

    /// CLOSEメッセージを処理 (要件 7.1, 7.2)
    ///
    /// # 処理フロー
    /// 1. subscription_idの検証
    /// 2. サブスクリプションを削除
    ///
    /// # 引数
    /// * `subscription_id` - サブスクリプションID
    /// * `connection_id` - API Gateway接続ID
    ///
    /// # 戻り値
    /// 成功時はOk(()), エラー時はErr(SubscriptionHandlerError)
    pub async fn handle_close(
        &self,
        subscription_id: String,
        connection_id: &str,
    ) -> Result<(), SubscriptionHandlerError> {
        // subscription_idの検証 (要件 6.6, 6.7 - CLOSEにも適用)
        if let Err(e) = Self::validate_subscription_id(&subscription_id) {
            let closed_msg = RelayMessage::closed_invalid_subscription_id(&subscription_id);
            let _ = self.ws_sender.send(connection_id, &closed_msg.to_json()).await;
            return Err(e);
        }

        // サブスクリプションを削除 (要件 7.1, 18.3)
        if let Err(e) = self.subscription_repo.delete(connection_id, &subscription_id).await {
            // エラー時はCLOSED応答を送信
            let closed_msg = RelayMessage::closed_subscription_error(&subscription_id);
            let _ = self.ws_sender.send(connection_id, &closed_msg.to_json()).await;
            return Err(e.into());
        }

        // 成功時は応答なし（NIP-01仕様）
        Ok(())
    }

    /// subscription_idの検証 (要件 6.6, 6.7)
    /// 1-64文字の非空文字列であることを確認
    fn validate_subscription_id(subscription_id: &str) -> Result<(), SubscriptionHandlerError> {
        let char_count = subscription_id.chars().count();
        if char_count == 0 || char_count > 64 {
            return Err(SubscriptionHandlerError::InvalidSubscriptionId(
                "subscription id must be 1-64 characters".to_string(),
            ));
        }
        Ok(())
    }

    /// フィルター条件をパース
    fn parse_filters(&self, filter_values: &[Value]) -> Result<Vec<Filter>, SubscriptionHandlerError> {
        let mut filters = Vec::new();

        for value in filter_values {
            let filter: Filter = serde_json::from_value(value.clone())
                .map_err(|e| SubscriptionHandlerError::InvalidFilter(e.to_string()))?;
            filters.push(filter);
        }

        Ok(filters)
    }

    /// フィルターからlimitを抽出（複数フィルターの場合は最小値）
    fn extract_limit(&self, filters: &[Filter]) -> Option<u32> {
        filters
            .iter()
            .filter_map(|f| f.limit)
            .min()
            .map(|l| l as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::event_repository::tests::MockEventRepository;
    use crate::infrastructure::subscription_repository::tests::MockSubscriptionRepository;
    use crate::infrastructure::websocket_sender::tests::MockWebSocketSender;
    use nostr::{EventBuilder, Keys, Timestamp};
    use serde_json::json;

    // ==================== テストヘルパー ====================

    /// テスト用のSubscriptionHandlerを作成
    fn create_test_handler() -> (
        SubscriptionHandler<MockEventRepository, MockSubscriptionRepository, MockWebSocketSender>,
        MockEventRepository,
        MockSubscriptionRepository,
        MockWebSocketSender,
    ) {
        let event_repo = MockEventRepository::new();
        let subscription_repo = MockSubscriptionRepository::new();
        let ws_sender = MockWebSocketSender::new();

        let handler = SubscriptionHandler::new(
            event_repo.clone(),
            subscription_repo.clone(),
            ws_sender.clone(),
        );

        (handler, event_repo, subscription_repo, ws_sender)
    }

    /// テスト用のイベントを作成
    fn create_test_event(content: &str) -> nostr::Event {
        let keys = Keys::generate();
        EventBuilder::text_note(content)
            .sign_with_keys(&keys)
            .expect("Failed to create event")
    }

    /// 特定のタイムスタンプでテスト用のイベントを作成
    fn create_test_event_with_timestamp(content: &str, timestamp: u64) -> nostr::Event {
        let keys = Keys::generate();
        EventBuilder::text_note(content)
            .custom_created_at(Timestamp::from_secs(timestamp))
            .sign_with_keys(&keys)
            .expect("Failed to create event")
    }

    // ==================== 6.1 REQメッセージ処理テスト ====================

    /// 要件 6.1: 有効なREQメッセージでサブスクリプションを作成
    #[tokio::test]
    async fn test_handle_req_creates_subscription() {
        let (handler, _, subscription_repo, _) = create_test_handler();

        let filters = vec![json!({"kinds": [1]})];
        let result = handler.handle_req("sub-1".to_string(), filters, "conn-123").await;

        assert!(result.is_ok());

        // サブスクリプションが作成されたことを確認
        let sub = subscription_repo.get("conn-123", "sub-1").await.unwrap();
        assert!(sub.is_some());
        assert_eq!(sub.unwrap().subscription_id, "sub-1");
    }

    /// 要件 6.1: フィルターなしのREQメッセージ
    #[tokio::test]
    async fn test_handle_req_no_filters() {
        let (handler, _, subscription_repo, ws_sender) = create_test_handler();

        let filters: Vec<Value> = vec![];
        let result = handler.handle_req("sub-1".to_string(), filters, "conn-123").await;

        assert!(result.is_ok());

        // サブスクリプションが作成されたことを確認
        let sub = subscription_repo.get("conn-123", "sub-1").await.unwrap();
        assert!(sub.is_some());

        // EOSEが送信されたことを確認
        let messages = ws_sender.get_sent_messages("conn-123");
        assert!(!messages.is_empty());
        let last_msg: Value = serde_json::from_str(messages.last().unwrap()).unwrap();
        assert_eq!(last_msg[0], "EOSE");
        assert_eq!(last_msg[1], "sub-1");
    }

    // ==================== 6.2 保存済みイベント送信テスト ====================

    /// 要件 6.2: フィルターに合致する保存済みイベントをEVENT形式で送信
    #[tokio::test]
    async fn test_handle_req_sends_matching_events() {
        let (handler, event_repo, _, ws_sender) = create_test_handler();

        // イベントを保存
        let event1 = create_test_event("event 1");
        let event2 = create_test_event("event 2");
        event_repo.save(&event1).await.unwrap();
        event_repo.save(&event2).await.unwrap();

        // kind=1のフィルターでREQ
        let filters = vec![json!({"kinds": [1]})];
        handler.handle_req("sub-1".to_string(), filters, "conn-123").await.unwrap();

        // 送信されたメッセージを確認
        let messages = ws_sender.get_sent_messages("conn-123");
        // EVENT x 2 + EOSE = 3
        assert_eq!(messages.len(), 3);

        // 最初の2つはEVENTメッセージ
        for message in messages.iter().take(2) {
            let msg: Value = serde_json::from_str(message).unwrap();
            assert_eq!(msg[0], "EVENT");
            assert_eq!(msg[1], "sub-1");
            assert!(msg[2].is_object());
        }

        // 最後はEOSE
        let eose: Value = serde_json::from_str(&messages[2]).unwrap();
        assert_eq!(eose[0], "EOSE");
    }

    /// フィルターに合致しないイベントは送信されない
    #[tokio::test]
    async fn test_handle_req_filters_events() {
        let (handler, event_repo, _, ws_sender) = create_test_handler();

        // kind=1のイベントを保存
        let event = create_test_event("text note");
        event_repo.save(&event).await.unwrap();

        // kind=0のフィルターでREQ
        let filters = vec![json!({"kinds": [0]})];
        handler.handle_req("sub-1".to_string(), filters, "conn-123").await.unwrap();

        // EOSEのみ送信される
        let messages = ws_sender.get_sent_messages("conn-123");
        assert_eq!(messages.len(), 1);
        let msg: Value = serde_json::from_str(&messages[0]).unwrap();
        assert_eq!(msg[0], "EOSE");
    }

    // ==================== 6.3 EOSE送信テスト ====================

    /// 要件 6.3: 保存済みイベント送信完了後にEOSEを送信
    #[tokio::test]
    async fn test_handle_req_sends_eose_after_events() {
        let (handler, event_repo, _, ws_sender) = create_test_handler();

        // イベントを保存
        let event = create_test_event("test");
        event_repo.save(&event).await.unwrap();

        let filters = vec![json!({"kinds": [1]})];
        handler.handle_req("sub-1".to_string(), filters, "conn-123").await.unwrap();

        let messages = ws_sender.get_sent_messages("conn-123");

        // 最後のメッセージがEOSEであることを確認
        let last_msg: Value = serde_json::from_str(messages.last().unwrap()).unwrap();
        assert_eq!(last_msg[0], "EOSE");
        assert_eq!(last_msg[1], "sub-1");
    }

    // ==================== 6.4 サブスクリプション置換テスト ====================

    /// 要件 6.4: 同じsubscription_idで新しいREQを受信した場合、既存を置換
    #[tokio::test]
    async fn test_handle_req_replaces_existing_subscription() {
        let (handler, _, subscription_repo, _) = create_test_handler();

        // 最初のサブスクリプション（kind=1のフィルター）
        let filters1 = vec![json!({"kinds": [1]})];
        handler.handle_req("sub-1".to_string(), filters1, "conn-123").await.unwrap();

        // 同じIDで2番目のサブスクリプション（kind=0のフィルター）
        let filters2 = vec![json!({"kinds": [0]})];
        handler.handle_req("sub-1".to_string(), filters2, "conn-123").await.unwrap();

        // サブスクリプションは1つのみ
        assert_eq!(subscription_repo.subscription_count(), 1);

        // フィルターが更新されていることを確認
        let sub = subscription_repo.get("conn-123", "sub-1").await.unwrap().unwrap();
        // 新しいフィルターはkind=0を含む
        assert!(sub.filters[0].kinds.is_some());
    }

    // ==================== 6.6, 6.7 subscription_id検証テスト ====================

    /// 要件 6.6: subscription_idが空の場合はCLOSED応答
    #[tokio::test]
    async fn test_handle_req_empty_subscription_id() {
        let (handler, _, _, ws_sender) = create_test_handler();

        let result = handler.handle_req("".to_string(), vec![], "conn-123").await;

        assert!(result.is_err());

        // CLOSED応答が送信されたことを確認
        let messages = ws_sender.get_sent_messages("conn-123");
        assert_eq!(messages.len(), 1);
        let msg: Value = serde_json::from_str(&messages[0]).unwrap();
        assert_eq!(msg[0], "CLOSED");
        assert!(msg[2].as_str().unwrap().contains("invalid:"));
    }

    /// 要件 6.6: subscription_idが64文字を超える場合はCLOSED応答
    #[tokio::test]
    async fn test_handle_req_subscription_id_too_long() {
        let (handler, _, _, ws_sender) = create_test_handler();

        let long_id = "a".repeat(65);
        let result = handler.handle_req(long_id.clone(), vec![], "conn-123").await;

        assert!(result.is_err());

        // CLOSED応答が送信されたことを確認
        let messages = ws_sender.get_sent_messages("conn-123");
        assert_eq!(messages.len(), 1);
        let msg: Value = serde_json::from_str(&messages[0]).unwrap();
        assert_eq!(msg[0], "CLOSED");
        assert_eq!(msg[1], long_id);
    }

    /// 要件 6.6: subscription_idが1文字の場合は有効
    #[tokio::test]
    async fn test_handle_req_subscription_id_min_length() {
        let (handler, _, subscription_repo, _) = create_test_handler();

        let result = handler.handle_req("a".to_string(), vec![], "conn-123").await;

        assert!(result.is_ok());
        assert!(subscription_repo.get("conn-123", "a").await.unwrap().is_some());
    }

    /// 要件 6.6: subscription_idが64文字の場合は有効
    #[tokio::test]
    async fn test_handle_req_subscription_id_max_length() {
        let (handler, _, subscription_repo, _) = create_test_handler();

        let max_id = "a".repeat(64);
        let result = handler.handle_req(max_id.clone(), vec![], "conn-123").await;

        assert!(result.is_ok());
        assert!(subscription_repo.get("conn-123", &max_id).await.unwrap().is_some());
    }

    // ==================== 7.1, 7.2 CLOSEメッセージ処理テスト ====================

    /// 要件 7.1: CLOSEメッセージでサブスクリプションを停止
    #[tokio::test]
    async fn test_handle_close_removes_subscription() {
        let (handler, _, subscription_repo, _) = create_test_handler();

        // サブスクリプションを作成
        let filters = vec![json!({"kinds": [1]})];
        handler.handle_req("sub-1".to_string(), filters, "conn-123").await.unwrap();
        assert!(subscription_repo.get("conn-123", "sub-1").await.unwrap().is_some());

        // CLOSEで削除
        let result = handler.handle_close("sub-1".to_string(), "conn-123").await;

        assert!(result.is_ok());
        assert!(subscription_repo.get("conn-123", "sub-1").await.unwrap().is_none());
    }

    /// 要件 7.1: 存在しないサブスクリプションのCLOSEも成功
    #[tokio::test]
    async fn test_handle_close_non_existent_subscription() {
        let (handler, _, _, _) = create_test_handler();

        let result = handler.handle_close("non-existent".to_string(), "conn-123").await;

        // 存在しないサブスクリプションの削除も成功扱い
        assert!(result.is_ok());
    }

    /// CLOSEでsubscription_idが無効な場合はCLOSED応答
    #[tokio::test]
    async fn test_handle_close_invalid_subscription_id() {
        let (handler, _, _, ws_sender) = create_test_handler();

        let result = handler.handle_close("".to_string(), "conn-123").await;

        assert!(result.is_err());

        // CLOSED応答が送信されたことを確認
        let messages = ws_sender.get_sent_messages("conn-123");
        assert_eq!(messages.len(), 1);
        let msg: Value = serde_json::from_str(&messages[0]).unwrap();
        assert_eq!(msg[0], "CLOSED");
    }

    // ==================== リポジトリエラーテスト (要件 18.8) ====================

    /// 要件 18.8: サブスクリプション保存エラー時にCLOSED応答
    #[tokio::test]
    async fn test_handle_req_subscription_repo_error() {
        let (handler, _, subscription_repo, ws_sender) = create_test_handler();

        // エラーを設定
        subscription_repo.set_next_error(
            crate::infrastructure::SubscriptionRepositoryError::WriteError("DB error".to_string())
        );

        let result = handler.handle_req("sub-1".to_string(), vec![], "conn-123").await;

        assert!(result.is_err());

        // CLOSED応答が送信されたことを確認
        let messages = ws_sender.get_sent_messages("conn-123");
        assert_eq!(messages.len(), 1);
        let msg: Value = serde_json::from_str(&messages[0]).unwrap();
        assert_eq!(msg[0], "CLOSED");
        assert!(msg[2].as_str().unwrap().contains("error:"));
    }

    /// 要件 18.8: イベントクエリエラー時にCLOSED応答
    #[tokio::test]
    async fn test_handle_req_event_repo_error() {
        let (handler, event_repo, _, ws_sender) = create_test_handler();

        // エラーを設定
        event_repo.set_next_error(
            crate::infrastructure::EventRepositoryError::ReadError("DB error".to_string())
        );

        let result = handler.handle_req("sub-1".to_string(), vec![], "conn-123").await;

        assert!(result.is_err());

        // CLOSED応答が送信されたことを確認
        let messages = ws_sender.get_sent_messages("conn-123");
        assert_eq!(messages.len(), 1);
        let msg: Value = serde_json::from_str(&messages[0]).unwrap();
        assert_eq!(msg[0], "CLOSED");
    }

    // ==================== フィルターパーステスト ====================

    /// 不正なフィルターJSONの場合はCLOSED応答
    #[tokio::test]
    async fn test_handle_req_invalid_filter_json() {
        let (handler, _, _, ws_sender) = create_test_handler();

        // 不正なフィルター（配列ではなく文字列）
        let filters = vec![json!("not a filter object")];
        let result = handler.handle_req("sub-1".to_string(), filters, "conn-123").await;

        assert!(result.is_err());

        // CLOSED応答が送信されたことを確認
        let messages = ws_sender.get_sent_messages("conn-123");
        assert_eq!(messages.len(), 1);
        let msg: Value = serde_json::from_str(&messages[0]).unwrap();
        assert_eq!(msg[0], "CLOSED");
    }

    /// 複数フィルターを持つREQメッセージ
    #[tokio::test]
    async fn test_handle_req_multiple_filters() {
        let (handler, _, subscription_repo, _) = create_test_handler();

        let filters = vec![
            json!({"kinds": [1]}),
            json!({"kinds": [0]}),
            json!({"kinds": [3]}),
        ];
        let result = handler.handle_req("sub-1".to_string(), filters, "conn-123").await;

        assert!(result.is_ok());

        let sub = subscription_repo.get("conn-123", "sub-1").await.unwrap().unwrap();
        assert_eq!(sub.filters.len(), 3);
    }

    // ==================== limitテスト (要件 8.7) ====================

    /// 要件 8.7: limitが指定されている場合は結果件数を制限
    #[tokio::test]
    async fn test_handle_req_with_limit() {
        let (handler, event_repo, _, ws_sender) = create_test_handler();

        // 5つのイベントを保存
        for i in 0..5 {
            let event = create_test_event_with_timestamp(&format!("event {}", i), 1700000000 + i * 100);
            event_repo.save(&event).await.unwrap();
        }

        // limit=2のフィルターでREQ
        let filters = vec![json!({"kinds": [1], "limit": 2})];
        handler.handle_req("sub-1".to_string(), filters, "conn-123").await.unwrap();

        // EVENT x 2 + EOSE = 3
        let messages = ws_sender.get_sent_messages("conn-123");
        assert_eq!(messages.len(), 3);

        // 最初の2つはEVENT
        for message in messages.iter().take(2) {
            let msg: Value = serde_json::from_str(message).unwrap();
            assert_eq!(msg[0], "EVENT");
        }
    }

    // ==================== エラー型テスト ====================

    #[test]
    fn test_subscription_handler_error_display() {
        let err = SubscriptionHandlerError::InvalidSubscriptionId("test".to_string());
        assert!(err.to_string().contains("invalid subscription id"));

        let err = SubscriptionHandlerError::InvalidFilter("test".to_string());
        assert!(err.to_string().contains("invalid filter"));

        let err = SubscriptionHandlerError::RepositoryError("test".to_string());
        assert!(err.to_string().contains("repository error"));

        let err = SubscriptionHandlerError::SendError("test".to_string());
        assert!(err.to_string().contains("send error"));
    }

    #[test]
    fn test_subscription_handler_error_from_subscription_repo_error() {
        let err = crate::infrastructure::SubscriptionRepositoryError::WriteError("test".to_string());
        let handler_err: SubscriptionHandlerError = err.into();
        match handler_err {
            SubscriptionHandlerError::RepositoryError(_) => {}
            _ => panic!("Expected RepositoryError"),
        }
    }

    #[test]
    fn test_subscription_handler_error_from_event_repo_error() {
        let err = crate::infrastructure::EventRepositoryError::ReadError("test".to_string());
        let handler_err: SubscriptionHandlerError = err.into();
        match handler_err {
            SubscriptionHandlerError::RepositoryError(_) => {}
            _ => panic!("Expected RepositoryError"),
        }
    }

    #[test]
    fn test_subscription_handler_error_from_send_error() {
        let err = SendError::ConnectionGone;
        let handler_err: SubscriptionHandlerError = err.into();
        match handler_err {
            SubscriptionHandlerError::SendError(_) => {}
            _ => panic!("Expected SendError"),
        }
    }

    // ==================== Unicode subscription_idテスト ====================

    /// マルチバイト文字のsubscription_idが64文字まで許可される
    #[tokio::test]
    async fn test_handle_req_multibyte_subscription_id() {
        let (handler, _, subscription_repo, _) = create_test_handler();

        // 64文字の日本語
        let id = "あ".repeat(64);
        let result = handler.handle_req(id.clone(), vec![], "conn-123").await;

        assert!(result.is_ok());
        assert!(subscription_repo.get("conn-123", &id).await.unwrap().is_some());
    }

    /// マルチバイト文字のsubscription_idが65文字以上は拒否
    #[tokio::test]
    async fn test_handle_req_multibyte_subscription_id_too_long() {
        let (handler, _, _, ws_sender) = create_test_handler();

        // 65文字の日本語
        let id = "あ".repeat(65);
        let result = handler.handle_req(id, vec![], "conn-123").await;

        assert!(result.is_err());

        let messages = ws_sender.get_sent_messages("conn-123");
        assert_eq!(messages.len(), 1);
        let msg: Value = serde_json::from_str(&messages[0]).unwrap();
        assert_eq!(msg[0], "CLOSED");
    }
}
