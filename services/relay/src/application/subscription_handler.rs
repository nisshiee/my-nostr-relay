/// サブスクリプションハンドラー
///
/// NIP-01準拠のREQ/CLOSEメッセージ処理を実行する
/// 要件: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 7.1, 7.2
/// 要件: 19.2, 19.5, 19.6
use nostr::Filter;
use serde_json::Value;
use thiserror::Error;
use tracing::{debug, trace, warn};

use crate::domain::{FilterEvaluator, FilterValidationError, LimitationConfig, RelayMessage};
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

    /// サブスクリプションIDが長すぎる (要件 4.1, 4.2, 4.3)
    #[error("subscription id too long: {length} characters, max {max_length}")]
    SubscriptionIdTooLong { length: usize, max_length: u32 },

    /// サブスクリプション数上限超過 (要件 3.2)
    #[error("too many subscriptions: {current} active, limit is {limit}")]
    TooManySubscriptions { current: usize, limit: u32 },

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
    /// 1. subscription_idの長さ検証
    /// 2. サブスクリプション数制限チェック（新規の場合のみ）
    /// 3. フィルター条件のパースと検証
    /// 4. フィルターのlimit値をクランプ/デフォルト適用
    /// 5. サブスクリプションを作成/更新
    /// 6. フィルターに合致する保存済みイベントをクエリ
    /// 7. 取得したイベントをEVENT応答として送信
    /// 8. EOSE応答を送信
    ///
    /// # 引数
    /// * `subscription_id` - サブスクリプションID
    /// * `filter_values` - フィルター条件のJSON配列
    /// * `connection_id` - API Gateway接続ID
    /// * `config` - 制限値設定
    ///
    /// # 戻り値
    /// 成功時はOk(()), エラー時はErr(SubscriptionHandlerError)
    /// エラー発生時はCLOSED応答をクライアントに送信済み
    pub async fn handle_req(
        &self,
        subscription_id: String,
        filter_values: Vec<Value>,
        connection_id: &str,
        config: &LimitationConfig,
    ) -> Result<(), SubscriptionHandlerError> {
        debug!(
            connection_id = connection_id,
            subscription_id = %subscription_id,
            filter_count = filter_values.len(),
            "REQメッセージ処理開始"
        );

        // subscription_idの長さ検証 (要件 4.1, 4.2, 4.3, 6.6, 6.7)
        if let Err(e) = Self::validate_subscription_id(&subscription_id, config.max_subid_length) {
            warn!(
                connection_id = connection_id,
                subscription_id = %subscription_id,
                error = %e,
                "subscription_id検証失敗"
            );
            // CLOSED応答を送信（長すぎる場合と空の場合で異なるメッセージ）
            let closed_msg = match &e {
                SubscriptionHandlerError::SubscriptionIdTooLong { .. } => {
                    RelayMessage::closed_subscription_id_too_long(&subscription_id)
                }
                _ => RelayMessage::closed_invalid_subscription_id(&subscription_id),
            };
            let _ = self.ws_sender.send(connection_id, &closed_msg.to_json()).await;
            return Err(e);
        }

        // サブスクリプション数制限チェック (要件 3.2, 3.2a)
        // 既存サブスクリプションへの更新（同一subscription_id）はチェックをスキップ
        let subscription_exists = self
            .subscription_repo
            .exists(connection_id, &subscription_id)
            .await
            .map_err(|e| {
                warn!(
                    connection_id = connection_id,
                    subscription_id = %subscription_id,
                    error = %e,
                    "サブスクリプション存在確認失敗"
                );
                SubscriptionHandlerError::RepositoryError(e.to_string())
            })?;

        if !subscription_exists {
            // 新規サブスクリプションの場合、接続のサブスクリプション数をチェック
            let current_count = self
                .subscription_repo
                .count_by_connection(connection_id)
                .await
                .map_err(|e| {
                    warn!(
                        connection_id = connection_id,
                        subscription_id = %subscription_id,
                        error = %e,
                        "サブスクリプション数カウント失敗"
                    );
                    SubscriptionHandlerError::RepositoryError(e.to_string())
                })?;

            if current_count >= config.max_subscriptions as usize {
                warn!(
                    connection_id = connection_id,
                    subscription_id = %subscription_id,
                    current_count = current_count,
                    max_subscriptions = config.max_subscriptions,
                    "サブスクリプション数上限超過"
                );
                let closed_msg = RelayMessage::closed_too_many_subscriptions(&subscription_id);
                let _ = self.ws_sender.send(connection_id, &closed_msg.to_json()).await;
                return Err(SubscriptionHandlerError::TooManySubscriptions {
                    current: current_count,
                    limit: config.max_subscriptions,
                });
            }
        }

        // フィルター条件をパース (要件 6.1)
        let mut filters = match self.parse_filters(&filter_values) {
            Ok(filters) => {
                trace!(
                    connection_id = connection_id,
                    subscription_id = %subscription_id,
                    filter_count = filters.len(),
                    "フィルターパース成功"
                );
                filters
            }
            Err(e) => {
                warn!(
                    connection_id = connection_id,
                    subscription_id = %subscription_id,
                    error = %e,
                    "フィルターパース失敗"
                );
                // CLOSED応答を送信
                let closed_msg = RelayMessage::closed_invalid(&subscription_id, &e.to_string());
                let _ = self.ws_sender.send(connection_id, &closed_msg.to_json()).await;
                return Err(e);
            }
        };

        // フィルター検証 (要件 8.11)
        for filter in &filters {
            if let Err(e) = FilterEvaluator::validate_filter(filter) {
                warn!(
                    connection_id = connection_id,
                    subscription_id = %subscription_id,
                    error = %e,
                    "フィルター検証失敗"
                );
                let closed_msg = RelayMessage::closed_invalid(&subscription_id, &e.to_string());
                let _ = self.ws_sender.send(connection_id, &closed_msg.to_json()).await;
                return Err(e.into());
            }
        }

        // フィルターのlimit値をクランプ/デフォルト適用 (要件 3.3, 1.10)
        self.apply_limit_constraints(&mut filters, config);

        // サブスクリプションを作成/更新 (要件 6.4, 18.1, 18.4)
        if let Err(e) = self.subscription_repo.upsert(connection_id, &subscription_id, &filters).await {
            // CLOSED応答を送信 (要件 18.8)
            warn!(
                connection_id = connection_id,
                subscription_id = %subscription_id,
                error = %e,
                "サブスクリプション保存失敗"
            );
            let closed_msg = RelayMessage::closed_subscription_error(&subscription_id);
            let _ = self.ws_sender.send(connection_id, &closed_msg.to_json()).await;
            return Err(e.into());
        }

        trace!(
            connection_id = connection_id,
            subscription_id = %subscription_id,
            "サブスクリプション作成/更新完了"
        );

        // フィルターに合致する保存済みイベントをクエリ (要件 6.2)
        // limitはフィルターから取得（複数フィルターの場合は最小値を使用）
        let limit = self.extract_limit(&filters);
        let events = match self.event_repo.query(&filters, limit).await {
            Ok(events) => {
                debug!(
                    connection_id = connection_id,
                    subscription_id = %subscription_id,
                    event_count = events.len(),
                    limit = ?limit,
                    "イベントクエリ成功"
                );
                events
            }
            Err(e) => {
                // クエリエラー時もCLOSED応答を送信
                warn!(
                    connection_id = connection_id,
                    subscription_id = %subscription_id,
                    error = %e,
                    "イベントクエリ失敗"
                );
                let closed_msg = RelayMessage::closed_subscription_error(&subscription_id);
                let _ = self.ws_sender.send(connection_id, &closed_msg.to_json()).await;
                return Err(e.into());
            }
        };

        // 取得したイベントを順次EVENT応答として送信 (要件 6.2)
        for event in &events {
            let event_msg = RelayMessage::Event {
                subscription_id: subscription_id.clone(),
                event: event.clone(),
            };
            // 送信エラーは無視（接続切れ等は後続処理で対応）
            if let Err(err) = self.ws_sender.send(connection_id, &event_msg.to_json()).await {
                warn!(
                    connection_id = connection_id,
                    subscription_id = %subscription_id,
                    event_id = %event.id,
                    error = %err,
                    "EVENT応答送信失敗"
                );
            }
        }

        // EOSE応答を送信 (要件 6.3)
        let eose_msg = RelayMessage::Eose {
            subscription_id: subscription_id.clone(),
        };
        if let Err(err) = self.ws_sender.send(connection_id, &eose_msg.to_json()).await {
            warn!(
                connection_id = connection_id,
                subscription_id = %subscription_id,
                error = %err,
                "EOSE応答送信失敗"
            );
        }

        debug!(
            connection_id = connection_id,
            subscription_id = %subscription_id,
            sent_events = events.len(),
            "REQメッセージ処理完了"
        );

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
    /// * `config` - 制限値設定
    ///
    /// # 戻り値
    /// 成功時はOk(()), エラー時はErr(SubscriptionHandlerError)
    pub async fn handle_close(
        &self,
        subscription_id: String,
        connection_id: &str,
        config: &LimitationConfig,
    ) -> Result<(), SubscriptionHandlerError> {
        debug!(
            connection_id = connection_id,
            subscription_id = %subscription_id,
            "CLOSEメッセージ処理開始"
        );

        // subscription_idの検証 (要件 6.6, 6.7, 4.1, 4.2, 4.3 - CLOSEにも適用)
        if let Err(e) = Self::validate_subscription_id(&subscription_id, config.max_subid_length) {
            warn!(
                connection_id = connection_id,
                subscription_id = %subscription_id,
                error = %e,
                "CLOSE: subscription_id検証失敗"
            );
            // CLOSED応答を送信（長すぎる場合と空の場合で異なるメッセージ）
            let closed_msg = match &e {
                SubscriptionHandlerError::SubscriptionIdTooLong { .. } => {
                    RelayMessage::closed_subscription_id_too_long(&subscription_id)
                }
                _ => RelayMessage::closed_invalid_subscription_id(&subscription_id),
            };
            let _ = self.ws_sender.send(connection_id, &closed_msg.to_json()).await;
            return Err(e);
        }

        // サブスクリプションを削除 (要件 7.1, 18.3)
        if let Err(e) = self.subscription_repo.delete(connection_id, &subscription_id).await {
            // エラー時はCLOSED応答を送信
            warn!(
                connection_id = connection_id,
                subscription_id = %subscription_id,
                error = %e,
                "サブスクリプション削除失敗"
            );
            let closed_msg = RelayMessage::closed_subscription_error(&subscription_id);
            let _ = self.ws_sender.send(connection_id, &closed_msg.to_json()).await;
            return Err(e.into());
        }

        debug!(
            connection_id = connection_id,
            subscription_id = %subscription_id,
            "CLOSEメッセージ処理完了"
        );

        // 成功時は応答なし（NIP-01仕様）
        Ok(())
    }

    /// subscription_idの検証 (要件 4.1, 4.2, 4.3, 6.6, 6.7)
    ///
    /// 1文字以上かつmax_subid_length以下の非空文字列であることを確認。
    /// 空の場合は`InvalidSubscriptionId`、長すぎる場合は`SubscriptionIdTooLong`を返す。
    fn validate_subscription_id(
        subscription_id: &str,
        max_subid_length: u32,
    ) -> Result<(), SubscriptionHandlerError> {
        let char_count = subscription_id.chars().count();

        if char_count == 0 {
            return Err(SubscriptionHandlerError::InvalidSubscriptionId(
                "subscription id must not be empty".to_string(),
            ));
        }

        if char_count > max_subid_length as usize {
            return Err(SubscriptionHandlerError::SubscriptionIdTooLong {
                length: char_count,
                max_length: max_subid_length,
            });
        }

        Ok(())
    }

    /// フィルターのlimit値にmax_limitクランプとdefault_limit適用を行う (要件 3.3, 1.10)
    ///
    /// - limitがmax_limitを超える場合はmax_limitにクランプ
    /// - limitが指定されていない場合はdefault_limitを適用
    fn apply_limit_constraints(&self, filters: &mut [Filter], config: &LimitationConfig) {
        for filter in filters.iter_mut() {
            match filter.limit {
                Some(limit) => {
                    // limitがmax_limitを超える場合はクランプ
                    if limit as u32 > config.max_limit {
                        filter.limit = Some(config.max_limit as usize);
                    }
                }
                None => {
                    // limitが指定されていない場合はdefault_limitを適用
                    filter.limit = Some(config.default_limit as usize);
                }
            }
        }
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

    /// テスト用のデフォルトLimitationConfigを作成
    fn default_config() -> crate::domain::LimitationConfig {
        crate::domain::LimitationConfig::default()
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
        let config = default_config();

        let filters = vec![json!({"kinds": [1]})];
        let result = handler.handle_req("sub-1".to_string(), filters, "conn-123", &config).await;

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
        let config = default_config();

        let filters: Vec<Value> = vec![];
        let result = handler.handle_req("sub-1".to_string(), filters, "conn-123", &config).await;

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
        let config = default_config();

        // イベントを保存
        let event1 = create_test_event("event 1");
        let event2 = create_test_event("event 2");
        event_repo.save(&event1).await.unwrap();
        event_repo.save(&event2).await.unwrap();

        // kind=1のフィルターでREQ
        let filters = vec![json!({"kinds": [1]})];
        handler.handle_req("sub-1".to_string(), filters, "conn-123", &config).await.unwrap();

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
        let config = default_config();

        // kind=1のイベントを保存
        let event = create_test_event("text note");
        event_repo.save(&event).await.unwrap();

        // kind=0のフィルターでREQ
        let filters = vec![json!({"kinds": [0]})];
        handler.handle_req("sub-1".to_string(), filters, "conn-123", &config).await.unwrap();

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
        let config = default_config();

        // イベントを保存
        let event = create_test_event("test");
        event_repo.save(&event).await.unwrap();

        let filters = vec![json!({"kinds": [1]})];
        handler.handle_req("sub-1".to_string(), filters, "conn-123", &config).await.unwrap();

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
        let config = default_config();

        // 最初のサブスクリプション（kind=1のフィルター）
        let filters1 = vec![json!({"kinds": [1]})];
        handler.handle_req("sub-1".to_string(), filters1, "conn-123", &config).await.unwrap();

        // 同じIDで2番目のサブスクリプション（kind=0のフィルター）
        let filters2 = vec![json!({"kinds": [0]})];
        handler.handle_req("sub-1".to_string(), filters2, "conn-123", &config).await.unwrap();

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
        let config = default_config();

        let result = handler.handle_req("".to_string(), vec![], "conn-123", &config).await;

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
        let config = default_config();

        let long_id = "a".repeat(65);
        let result = handler.handle_req(long_id.clone(), vec![], "conn-123", &config).await;

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
        let config = default_config();

        let result = handler.handle_req("a".to_string(), vec![], "conn-123", &config).await;

        assert!(result.is_ok());
        assert!(subscription_repo.get("conn-123", "a").await.unwrap().is_some());
    }

    /// 要件 6.6: subscription_idが64文字の場合は有効
    #[tokio::test]
    async fn test_handle_req_subscription_id_max_length() {
        let (handler, _, subscription_repo, _) = create_test_handler();
        let config = default_config();

        let max_id = "a".repeat(64);
        let result = handler.handle_req(max_id.clone(), vec![], "conn-123", &config).await;

        assert!(result.is_ok());
        assert!(subscription_repo.get("conn-123", &max_id).await.unwrap().is_some());
    }

    // ==================== 7.1, 7.2 CLOSEメッセージ処理テスト ====================

    /// 要件 7.1: CLOSEメッセージでサブスクリプションを停止
    #[tokio::test]
    async fn test_handle_close_removes_subscription() {
        let (handler, _, subscription_repo, _) = create_test_handler();
        let config = default_config();

        // サブスクリプションを作成
        let filters = vec![json!({"kinds": [1]})];
        handler.handle_req("sub-1".to_string(), filters, "conn-123", &config).await.unwrap();
        assert!(subscription_repo.get("conn-123", "sub-1").await.unwrap().is_some());

        // CLOSEで削除
        let result = handler.handle_close("sub-1".to_string(), "conn-123", &config).await;

        assert!(result.is_ok());
        assert!(subscription_repo.get("conn-123", "sub-1").await.unwrap().is_none());
    }

    /// 要件 7.1: 存在しないサブスクリプションのCLOSEも成功
    #[tokio::test]
    async fn test_handle_close_non_existent_subscription() {
        let (handler, _, _, _) = create_test_handler();
        let config = default_config();

        let result = handler.handle_close("non-existent".to_string(), "conn-123", &config).await;

        // 存在しないサブスクリプションの削除も成功扱い
        assert!(result.is_ok());
    }

    /// CLOSEでsubscription_idが無効な場合はCLOSED応答
    #[tokio::test]
    async fn test_handle_close_invalid_subscription_id() {
        let (handler, _, _, ws_sender) = create_test_handler();
        let config = default_config();

        let result = handler.handle_close("".to_string(), "conn-123", &config).await;

        assert!(result.is_err());

        // CLOSED応答が送信されたことを確認
        let messages = ws_sender.get_sent_messages("conn-123");
        assert_eq!(messages.len(), 1);
        let msg: Value = serde_json::from_str(&messages[0]).unwrap();
        assert_eq!(msg[0], "CLOSED");
    }

    // ==================== リポジトリエラーテスト (要件 18.8) ====================

    /// 要件 18.8: サブスクリプションリポジトリエラー時にCLOSED応答（exists確認エラー）
    #[tokio::test]
    async fn test_handle_req_subscription_repo_error() {
        let (handler, _, subscription_repo, _ws_sender) = create_test_handler();
        let config = default_config();

        // exists確認でエラーを発生させる
        subscription_repo.set_next_error(
            crate::infrastructure::SubscriptionRepositoryError::ReadError("DB error".to_string())
        );

        let result = handler.handle_req("sub-1".to_string(), vec![], "conn-123", &config).await;

        // リポジトリエラーとして処理される
        assert!(result.is_err());
        match result.unwrap_err() {
            SubscriptionHandlerError::RepositoryError(_) => {}
            e => panic!("Expected RepositoryError, got {:?}", e),
        }
    }

    /// 要件 18.8: イベントクエリエラー時にCLOSED応答
    #[tokio::test]
    async fn test_handle_req_event_repo_error() {
        let (handler, event_repo, _, ws_sender) = create_test_handler();
        let config = default_config();

        // エラーを設定
        event_repo.set_next_error(
            crate::infrastructure::EventRepositoryError::ReadError("DB error".to_string())
        );

        let result = handler.handle_req("sub-1".to_string(), vec![], "conn-123", &config).await;

        assert!(result.is_err());

        // CLOSED応答が送信されたことを確認
        let messages = ws_sender.get_sent_messages("conn-123");
        assert_eq!(messages.len(), 1);
        let msg: Value = serde_json::from_str(&messages[0]).unwrap();
        assert_eq!(msg[0], "CLOSED");
    }

    /// 要件 18.8: サブスクリプションupsertエラー時にCLOSED応答
    ///
    /// このテストでは、set_upsert_errorを使用してupsert操作専用のエラーを設定する。
    /// これにより、existsやcount_by_connectionでエラーが消費されることなく、
    /// upsertでのみエラーが発生する。
    #[tokio::test]
    async fn test_handle_req_subscription_upsert_error() {
        let (handler, _, subscription_repo, ws_sender) = create_test_handler();
        let config = default_config();

        // upsert操作専用のエラーを設定
        // existsやcount_by_connectionでは消費されず、upsertでのみ発生する
        subscription_repo.set_upsert_error(
            crate::infrastructure::SubscriptionRepositoryError::WriteError("DynamoDB error".to_string())
        );

        // 新規サブスクリプションを作成しようとする
        let filters = vec![json!({"kinds": [1]})];
        let result = handler.handle_req("sub-1".to_string(), filters, "conn-123", &config).await;

        // upsertエラーとして処理される
        assert!(result.is_err());
        match result.unwrap_err() {
            SubscriptionHandlerError::RepositoryError(msg) => {
                assert!(msg.contains("DynamoDB error"));
            }
            e => panic!("Expected RepositoryError, got {:?}", e),
        }

        // CLOSED応答が送信されたことを確認
        let messages = ws_sender.get_sent_messages("conn-123");
        assert_eq!(messages.len(), 1);
        let msg: Value = serde_json::from_str(&messages[0]).unwrap();
        assert_eq!(msg[0], "CLOSED");
        assert_eq!(msg[1], "sub-1");
    }

    // ==================== フィルターパーステスト ====================

    /// 不正なフィルターJSONの場合はCLOSED応答
    #[tokio::test]
    async fn test_handle_req_invalid_filter_json() {
        let (handler, _, _, ws_sender) = create_test_handler();
        let config = default_config();

        // 不正なフィルター（配列ではなく文字列）
        let filters = vec![json!("not a filter object")];
        let result = handler.handle_req("sub-1".to_string(), filters, "conn-123", &config).await;

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
        let config = default_config();

        let filters = vec![
            json!({"kinds": [1]}),
            json!({"kinds": [0]}),
            json!({"kinds": [3]}),
        ];
        let result = handler.handle_req("sub-1".to_string(), filters, "conn-123", &config).await;

        assert!(result.is_ok());

        let sub = subscription_repo.get("conn-123", "sub-1").await.unwrap().unwrap();
        assert_eq!(sub.filters.len(), 3);
    }

    // ==================== limitテスト (要件 8.7) ====================

    /// 要件 8.7: limitが指定されている場合は結果件数を制限
    #[tokio::test]
    async fn test_handle_req_with_limit() {
        let (handler, event_repo, _, ws_sender) = create_test_handler();
        let config = default_config();

        // 5つのイベントを保存
        for i in 0..5 {
            let event = create_test_event_with_timestamp(&format!("event {}", i), 1700000000 + i * 100);
            event_repo.save(&event).await.unwrap();
        }

        // limit=2のフィルターでREQ
        let filters = vec![json!({"kinds": [1], "limit": 2})];
        handler.handle_req("sub-1".to_string(), filters, "conn-123", &config).await.unwrap();

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

    // ==================== Task 6.1: サブスクリプション数制限テスト ====================

    /// 要件 3.2: 新規サブスクリプションがmax_subscriptionsを超える場合はCLOSED応答
    #[tokio::test]
    async fn test_handle_req_max_subscriptions_exceeded() {
        let (handler, _, _subscription_repo, ws_sender) = create_test_handler();
        let config = crate::domain::LimitationConfig {
            max_subscriptions: 2,
            ..Default::default()
        };

        // max_subscriptions分のサブスクリプションを作成
        let filters = vec![json!({"kinds": [1]})];
        handler.handle_req("sub-1".to_string(), filters.clone(), "conn-123", &config).await.unwrap();
        handler.handle_req("sub-2".to_string(), filters.clone(), "conn-123", &config).await.unwrap();

        // 3つ目のサブスクリプションは拒否される
        let result = handler.handle_req("sub-3".to_string(), filters, "conn-123", &config).await;

        assert!(result.is_err());

        // CLOSED応答に「too many subscriptions」が含まれることを確認
        let messages = ws_sender.get_sent_messages("conn-123");
        // sub-1: EOSE, sub-2: EOSE, sub-3: CLOSED
        let last_msg: Value = serde_json::from_str(messages.last().unwrap()).unwrap();
        assert_eq!(last_msg[0], "CLOSED");
        assert_eq!(last_msg[1], "sub-3");
        assert!(last_msg[2].as_str().unwrap().contains("too many subscriptions"));
    }

    /// 要件 3.2a: 既存サブスクリプションIDへのREQ（フィルター更新）はカウントチェックをスキップ
    #[tokio::test]
    async fn test_handle_req_update_existing_subscription_skips_count_check() {
        let (handler, _, subscription_repo, _) = create_test_handler();
        let config = crate::domain::LimitationConfig {
            max_subscriptions: 2,
            ..Default::default()
        };

        // max_subscriptions分のサブスクリプションを作成
        let filters1 = vec![json!({"kinds": [1]})];
        handler.handle_req("sub-1".to_string(), filters1.clone(), "conn-123", &config).await.unwrap();
        handler.handle_req("sub-2".to_string(), filters1.clone(), "conn-123", &config).await.unwrap();

        // 既存のsubscription_id（sub-1）でフィルター更新は成功する
        let filters2 = vec![json!({"kinds": [0]})];
        let result = handler.handle_req("sub-1".to_string(), filters2, "conn-123", &config).await;

        assert!(result.is_ok());

        // フィルターが更新されていることを確認
        let sub = subscription_repo.get("conn-123", "sub-1").await.unwrap().unwrap();
        assert!(sub.filters[0].kinds.is_some());
    }

    /// サブスクリプション数制限が0の場合、新規サブスクリプションは全て拒否
    #[tokio::test]
    async fn test_handle_req_max_subscriptions_zero() {
        let (handler, _, _, ws_sender) = create_test_handler();
        let config = crate::domain::LimitationConfig {
            max_subscriptions: 0,
            ..Default::default()
        };

        let filters = vec![json!({"kinds": [1]})];
        let result = handler.handle_req("sub-1".to_string(), filters, "conn-123", &config).await;

        assert!(result.is_err());

        let messages = ws_sender.get_sent_messages("conn-123");
        let msg: Value = serde_json::from_str(&messages[0]).unwrap();
        assert_eq!(msg[0], "CLOSED");
        assert!(msg[2].as_str().unwrap().contains("too many subscriptions"));
    }

    // ==================== Task 6.2: サブスクリプションID長検証テスト ====================

    /// 要件 4.1, 4.2, 4.3: サブスクリプションIDがmax_subid_lengthを超える場合はCLOSED応答
    #[tokio::test]
    async fn test_handle_req_subscription_id_too_long_closed_message() {
        let (handler, _, _, ws_sender) = create_test_handler();
        let config = crate::domain::LimitationConfig::default();

        // 65文字のサブスクリプションID（max_subid_length=64を超える）
        let long_id = "a".repeat(65);
        let filters = vec![json!({"kinds": [1]})];
        let result = handler.handle_req(long_id.clone(), filters, "conn-123", &config).await;

        assert!(result.is_err());

        // CLOSED応答に「subscription id too long」が含まれることを確認
        let messages = ws_sender.get_sent_messages("conn-123");
        assert_eq!(messages.len(), 1);
        let msg: Value = serde_json::from_str(&messages[0]).unwrap();
        assert_eq!(msg[0], "CLOSED");
        assert_eq!(msg[1], long_id);
        assert!(msg[2].as_str().unwrap().contains("subscription id too long"));
    }

    /// 空のサブスクリプションIDはinvalid扱い（too longとは別）
    #[tokio::test]
    async fn test_handle_req_empty_subscription_id_with_config() {
        let (handler, _, _, ws_sender) = create_test_handler();
        let config = crate::domain::LimitationConfig::default();

        let result = handler.handle_req("".to_string(), vec![], "conn-123", &config).await;

        assert!(result.is_err());

        // CLOSED応答がinvalid:で始まることを確認
        let messages = ws_sender.get_sent_messages("conn-123");
        let msg: Value = serde_json::from_str(&messages[0]).unwrap();
        assert_eq!(msg[0], "CLOSED");
        assert!(msg[2].as_str().unwrap().starts_with("invalid:"));
    }

    // ==================== Task 6.3: フィルターlimit値制限テスト ====================

    /// 要件 3.3: limit値がmax_limitを超える場合はmax_limitにクランプ
    #[tokio::test]
    async fn test_handle_req_limit_clamped_to_max_limit() {
        let (handler, event_repo, _, ws_sender) = create_test_handler();
        let config = crate::domain::LimitationConfig {
            max_limit: 10,
            default_limit: 5,
            ..Default::default()
        };

        // 15個のイベントを保存
        for i in 0..15 {
            let event = create_test_event_with_timestamp(&format!("event {}", i), 1700000000 + i * 100);
            event_repo.save(&event).await.unwrap();
        }

        // limit=100のフィルターでREQ（max_limit=10にクランプされるはず）
        let filters = vec![json!({"kinds": [1], "limit": 100})];
        handler.handle_req("sub-1".to_string(), filters, "conn-123", &config).await.unwrap();

        // EVENT x max_limit(10) + EOSE = 11
        let messages = ws_sender.get_sent_messages("conn-123");
        let event_count = messages.iter()
            .filter(|m| {
                let v: Value = serde_json::from_str(m).unwrap();
                v[0] == "EVENT"
            })
            .count();
        assert_eq!(event_count, 10);
    }

    /// 要件 1.10: limit未指定の場合はdefault_limitを適用
    #[tokio::test]
    async fn test_handle_req_default_limit_applied_when_no_limit() {
        let (handler, event_repo, _, ws_sender) = create_test_handler();
        let config = crate::domain::LimitationConfig {
            max_limit: 100,
            default_limit: 3,
            ..Default::default()
        };

        // 10個のイベントを保存
        for i in 0..10 {
            let event = create_test_event_with_timestamp(&format!("event {}", i), 1700000000 + i * 100);
            event_repo.save(&event).await.unwrap();
        }

        // limitなしのフィルターでREQ（default_limit=3が適用されるはず）
        let filters = vec![json!({"kinds": [1]})];
        handler.handle_req("sub-1".to_string(), filters, "conn-123", &config).await.unwrap();

        // EVENT x default_limit(3) + EOSE = 4
        let messages = ws_sender.get_sent_messages("conn-123");
        let event_count = messages.iter()
            .filter(|m| {
                let v: Value = serde_json::from_str(m).unwrap();
                v[0] == "EVENT"
            })
            .count();
        assert_eq!(event_count, 3);
    }

    /// limit値がmax_limit以下の場合はそのまま使用
    #[tokio::test]
    async fn test_handle_req_limit_within_range_unchanged() {
        let (handler, event_repo, _, ws_sender) = create_test_handler();
        let config = crate::domain::LimitationConfig {
            max_limit: 100,
            default_limit: 50,
            ..Default::default()
        };

        // 20個のイベントを保存
        for i in 0..20 {
            let event = create_test_event_with_timestamp(&format!("event {}", i), 1700000000 + i * 100);
            event_repo.save(&event).await.unwrap();
        }

        // limit=5のフィルターでREQ（max_limit=100以下なのでそのまま5）
        let filters = vec![json!({"kinds": [1], "limit": 5})];
        handler.handle_req("sub-1".to_string(), filters, "conn-123", &config).await.unwrap();

        // EVENT x 5 + EOSE = 6
        let messages = ws_sender.get_sent_messages("conn-123");
        let event_count = messages.iter()
            .filter(|m| {
                let v: Value = serde_json::from_str(m).unwrap();
                v[0] == "EVENT"
            })
            .count();
        assert_eq!(event_count, 5);
    }

    /// 複数フィルターの場合、全てのフィルターにlimit処理が適用される
    #[tokio::test]
    async fn test_handle_req_limit_applied_to_multiple_filters() {
        let (handler, event_repo, _, ws_sender) = create_test_handler();
        let config = crate::domain::LimitationConfig {
            max_limit: 5,
            default_limit: 2,
            ..Default::default()
        };

        // 10個のイベントを保存
        for i in 0..10 {
            let event = create_test_event_with_timestamp(&format!("event {}", i), 1700000000 + i * 100);
            event_repo.save(&event).await.unwrap();
        }

        // 1つ目: limit=100（max_limit=5にクランプ）、2つ目: limitなし（default_limit=2）
        // 結果は最小値=2が適用される
        let filters = vec![
            json!({"kinds": [1], "limit": 100}),
            json!({"kinds": [1]}),
        ];
        handler.handle_req("sub-1".to_string(), filters, "conn-123", &config).await.unwrap();

        // EVENT x min(5, 2)=2 + EOSE = 3
        let messages = ws_sender.get_sent_messages("conn-123");
        let event_count = messages.iter()
            .filter(|m| {
                let v: Value = serde_json::from_str(m).unwrap();
                v[0] == "EVENT"
            })
            .count();
        assert_eq!(event_count, 2);
    }

    // ==================== TooManySubscriptionsエラー型テスト ====================

    #[test]
    fn test_subscription_handler_error_too_many_subscriptions_display() {
        let err = SubscriptionHandlerError::TooManySubscriptions { current: 20, limit: 20 };
        assert!(err.to_string().contains("too many subscriptions"));
        assert!(err.to_string().contains("20"));
    }

    // ==================== Unicode subscription_idテスト ====================

    /// マルチバイト文字のsubscription_idが64文字まで許可される
    #[tokio::test]
    async fn test_handle_req_multibyte_subscription_id() {
        let (handler, _, subscription_repo, _) = create_test_handler();
        let config = default_config();

        // 64文字の日本語
        let id = "あ".repeat(64);
        let result = handler.handle_req(id.clone(), vec![], "conn-123", &config).await;

        assert!(result.is_ok());
        assert!(subscription_repo.get("conn-123", &id).await.unwrap().is_some());
    }

    /// マルチバイト文字のsubscription_idが65文字以上は拒否
    #[tokio::test]
    async fn test_handle_req_multibyte_subscription_id_too_long() {
        let (handler, _, _, ws_sender) = create_test_handler();
        let config = default_config();

        // 65文字の日本語
        let id = "あ".repeat(65);
        let result = handler.handle_req(id, vec![], "conn-123", &config).await;

        assert!(result.is_err());

        let messages = ws_sender.get_sent_messages("conn-123");
        assert_eq!(messages.len(), 1);
        let msg: Value = serde_json::from_str(&messages[0]).unwrap();
        assert_eq!(msg[0], "CLOSED");
    }
}
