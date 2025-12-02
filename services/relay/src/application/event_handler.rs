/// EVENTメッセージハンドラー
///
/// NIP-01準拠のイベント処理を実行する
/// 要件: 5.1, 5.2, 5.3, 5.4, 5.5, 9.1, 10.1, 10.2, 10.3, 11.1, 11.2, 12.1, 12.2, 12.3
/// 要件: 19.2, 19.3, 19.4, 19.5, 19.6
/// NIP-09要件: 1.1, 1.4, 1.5, 4.2, 4.3, 6.2
use nostr::Event;
use serde_json::Value;
use tracing::{debug, info, trace, warn};

use crate::application::DeletionHandler;
use crate::domain::{EventKind, EventValidator, LimitationConfig, RelayMessage, ValidationError};
use crate::infrastructure::{
    EventRepository, EventRepositoryError, SaveResult, SendError, SubscriptionRepository,
    SubscriptionRepositoryError, WebSocketSender,
};

/// イベントハンドラーのエラー型
#[derive(Debug, Clone)]
pub enum EventHandlerError {
    /// イベント検証エラー
    ValidationError(ValidationError),
    /// リポジトリエラー
    RepositoryError(String),
    /// WebSocket送信エラー
    SendError(String),
}

impl From<ValidationError> for EventHandlerError {
    fn from(err: ValidationError) -> Self {
        EventHandlerError::ValidationError(err)
    }
}

impl From<EventRepositoryError> for EventHandlerError {
    fn from(err: EventRepositoryError) -> Self {
        EventHandlerError::RepositoryError(err.to_string())
    }
}

impl From<SubscriptionRepositoryError> for EventHandlerError {
    fn from(err: SubscriptionRepositoryError) -> Self {
        EventHandlerError::RepositoryError(err.to_string())
    }
}

impl From<SendError> for EventHandlerError {
    fn from(err: SendError) -> Self {
        EventHandlerError::SendError(err.to_string())
    }
}

/// EVENTメッセージを処理するハンドラー
///
/// イベントの検証、Kind別処理、保存、購読者への配信を行う
/// NIP-09: kind:5削除リクエストの処理にも対応
pub struct EventHandler<ER, SR, WS>
where
    ER: EventRepository + Clone,
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

impl<ER, SR, WS> EventHandler<ER, SR, WS>
where
    ER: EventRepository + Clone,
    SR: SubscriptionRepository,
    WS: WebSocketSender,
{
    /// 新しいEventHandlerを作成
    pub fn new(event_repo: ER, subscription_repo: SR, ws_sender: WS) -> Self {
        Self {
            event_repo,
            subscription_repo,
            ws_sender,
        }
    }

    /// EVENTメッセージを処理（デフォルト制限値を使用）
    ///
    /// # 処理フロー
    /// 1. イベントJSONの検証（構造、ID、署名）
    /// 2. Kind別処理（Regular, Replaceable, Ephemeral, Addressable）
    /// 3. 非Ephemeralイベントはリポジトリに保存
    /// 4. マッチする購読者にイベントを配信
    /// 5. OK応答を返却
    ///
    /// # 引数
    /// * `event_json` - パースされたイベントJSON
    /// * `connection_id` - 送信元のAPI Gateway接続ID
    ///
    /// # 戻り値
    /// OKメッセージ（成功/失敗）
    pub async fn handle(&self, event_json: Value, connection_id: &str) -> RelayMessage {
        let default_config = LimitationConfig::default();
        self.handle_with_config(event_json, connection_id, &default_config).await
    }

    /// EVENTメッセージを処理（制限値設定を指定）
    ///
    /// # 処理フロー
    /// 1. イベントJSONの検証（構造、ID、署名）
    /// 2. 制限値バリデーション（タグ数、コンテンツ長、created_at範囲）
    /// 3. Kind別処理（Regular, Replaceable, Ephemeral, Addressable）
    /// 4. 非Ephemeralイベントはリポジトリに保存
    /// 5. マッチする購読者にイベントを配信
    /// 6. OK応答を返却
    ///
    /// # 引数
    /// * `event_json` - パースされたイベントJSON
    /// * `connection_id` - 送信元のAPI Gateway接続ID
    /// * `config` - 制限値設定
    ///
    /// # 戻り値
    /// OKメッセージ（成功/失敗）
    ///
    /// 要件: 3.4, 3.5, 3.6, 3.7
    pub async fn handle_with_config(
        &self,
        event_json: Value,
        connection_id: &str,
        config: &LimitationConfig,
    ) -> RelayMessage {
        // イベントIDを取得（検証前でもエラーメッセージに使用）
        let event_id = event_json
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        trace!(
            connection_id = connection_id,
            event_id = %event_id,
            "EVENTメッセージ処理開始"
        );

        // イベント検証（要件 2.1-2.8, 3.1-3.5, 4.1-4.2）
        let event = match EventValidator::validate_all(&event_json) {
            Ok(event) => {
                trace!(
                    event_id = %event_id,
                    "イベント検証成功"
                );
                event
            }
            Err(err) => {
                debug!(
                    connection_id = connection_id,
                    event_id = %event_id,
                    error = %err,
                    "イベント検証失敗"
                );
                return self.create_validation_error_response(&event_id, err);
            }
        };

        // 制限値バリデーション（要件 3.4-3.7）
        if let Err(err) = EventValidator::validate_limitation(&event, config) {
            debug!(
                connection_id = connection_id,
                event_id = %event_id,
                error = %err,
                "制限値バリデーション失敗"
            );
            return self.create_validation_error_response(&event_id, err);
        }

        trace!(
            event_id = %event_id,
            "制限値バリデーション成功"
        );

        // NIP-09: kind:5削除リクエストの処理（要件 1.1, 1.4, 4.2, 4.3, 6.2）
        let kind_value = event.kind.as_u16();
        if kind_value == 5 {
            return self.handle_deletion(&event, connection_id).await;
        }

        // Kind分類（要件 9.1, 10.1, 11.1, 12.1）
        let kind = EventKind::classify(kind_value);

        debug!(
            event_id = %event_id,
            kind = kind_value,
            kind_type = ?kind,
            "Kind分類完了"
        );

        // Kind別処理
        let save_result = match kind {
            EventKind::Ephemeral => {
                // Ephemeralイベントは保存せずに購読者への配信のみ（要件 11.1, 11.2）
                debug!(
                    event_id = %event_id,
                    "Ephemeralイベント: 保存せず配信のみ"
                );
                self.broadcast_to_subscribers(&event).await;
                return RelayMessage::ok_success(&event_id);
            }
            _ => {
                // Regular, Replaceable, Addressableイベントは保存（要件 5.2, 9.1, 10.2, 12.2）
                match self.event_repo.save(&event).await {
                    Ok(result) => {
                        trace!(
                            event_id = %event_id,
                            result = ?result,
                            "イベント保存成功"
                        );
                        result
                    }
                    Err(err) => {
                        // 保存失敗時のエラー応答（要件 16.8, 19.2）
                        warn!(
                            connection_id = connection_id,
                            event_id = %event_id,
                            error = %err,
                            "イベント保存失敗"
                        );
                        return RelayMessage::ok_storage_error(&event_id);
                    }
                }
            }
        };

        // 保存結果に基づく応答生成
        match save_result {
            SaveResult::Saved | SaveResult::Replaced => {
                // 新規/置換保存時は購読者に配信（要件 6.5）
                debug!(
                    event_id = %event_id,
                    result = ?save_result,
                    "イベント保存完了、購読者へ配信"
                );
                self.broadcast_to_subscribers(&event).await;
                RelayMessage::ok_success(&event_id)
            }
            SaveResult::Duplicate => {
                // 重複イベント（要件 5.4）
                debug!(
                    event_id = %event_id,
                    "重複イベント検出"
                );
                RelayMessage::ok_duplicate(&event_id)
            }
        }
    }

    /// 検証エラーに基づくOKエラー応答を生成
    fn create_validation_error_response(&self, event_id: &str, err: ValidationError) -> RelayMessage {
        match err {
            ValidationError::IdMismatch => RelayMessage::ok_invalid_id(event_id),
            ValidationError::SignatureVerificationFailed => RelayMessage::ok_invalid_signature(event_id),
            // 制限値バリデーションエラー（要件 3.4-3.7）
            ValidationError::TooManyTags { .. } => RelayMessage::ok_too_many_tags(event_id),
            ValidationError::ContentTooLong { .. } => RelayMessage::ok_content_too_long(event_id),
            ValidationError::CreatedAtTooOld { .. } | ValidationError::CreatedAtTooFarInFuture { .. } => {
                RelayMessage::ok_created_at_out_of_range(event_id)
            }
            _ => RelayMessage::ok_error(
                event_id,
                crate::domain::relay_message::error_prefix::INVALID,
                &err.to_string(),
            ),
        }
    }

    /// マッチする購読者にイベントを配信
    async fn broadcast_to_subscribers(&self, event: &Event) {
        let event_id = event.id.to_hex();

        // マッチするサブスクリプションを検索（要件 18.6, 19.3）
        let matched = match self.subscription_repo.find_matching(event).await {
            Ok(matched) => {
                trace!(
                    event_id = %event_id,
                    matched_count = matched.len(),
                    "サブスクリプション検索完了"
                );
                matched
            }
            Err(err) => {
                // エラー時はブロードキャストをスキップ（要件 19.3）
                warn!(
                    event_id = %event_id,
                    error = %err,
                    "サブスクリプション検索エラー"
                );
                return;
            }
        };

        if matched.is_empty() {
            trace!(
                event_id = %event_id,
                "マッチする購読者なし"
            );
            return;
        }

        // EVENTメッセージを作成
        for subscription in matched {
            let event_message = RelayMessage::Event {
                subscription_id: subscription.subscription_id.clone(),
                event: event.clone(),
            };
            let message_json = event_message.to_json();

            // 送信（要件 19.4）
            if let Err(err) = self
                .ws_sender
                .send(&subscription.connection_id, &message_json)
                .await
            {
                warn!(
                    event_id = %event_id,
                    connection_id = %subscription.connection_id,
                    subscription_id = %subscription.subscription_id,
                    error = %err,
                    "WebSocket送信エラー"
                );
            } else {
                trace!(
                    event_id = %event_id,
                    connection_id = %subscription.connection_id,
                    subscription_id = %subscription.subscription_id,
                    "イベント配信成功"
                );
            }
        }
    }

    /// NIP-09: 削除リクエストを処理
    ///
    /// kind:5削除リクエストイベントの処理を行う。
    /// 削除対象の抽出・検証・削除をDeletionHandlerに委譲し、
    /// 削除リクエストイベント自体をkind:5にマッチするサブスクリプションへ配信する。
    ///
    /// # Arguments
    /// * `event` - kind:5の削除リクエストイベント
    /// * `connection_id` - 送信元のAPI Gateway接続ID
    ///
    /// # Returns
    /// * `RelayMessage::Ok(true)` - 削除処理成功
    /// * `RelayMessage::Ok(false, error:)` - 削除処理失敗
    ///
    /// 要件: 1.1, 1.4, 4.2, 4.3, 6.2
    async fn handle_deletion(&self, event: &Event, connection_id: &str) -> RelayMessage {
        let event_id = event.id.to_hex();

        info!(
            connection_id = connection_id,
            event_id = %event_id,
            "NIP-09削除リクエスト処理開始"
        );

        // DeletionHandlerに処理を委譲
        let deletion_handler = DeletionHandler::new(self.event_repo.clone());
        match deletion_handler.process_deletion(event).await {
            Ok(result) => {
                info!(
                    event_id = %event_id,
                    deleted_count = result.deleted_count,
                    skipped_count = result.skipped_count,
                    "削除リクエスト処理完了"
                );

                // 削除リクエストイベントをkind:5にマッチするサブスクリプションへ配信（要件 6.2）
                self.broadcast_to_subscribers(event).await;

                RelayMessage::ok_success(&event_id)
            }
            Err(err) => {
                warn!(
                    connection_id = connection_id,
                    event_id = %event_id,
                    error = %err,
                    "削除リクエスト処理失敗"
                );
                RelayMessage::ok_storage_error(&event_id)
            }
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

    /// テスト用のEventHandlerを作成
    fn create_test_handler() -> (
        EventHandler<MockEventRepository, MockSubscriptionRepository, MockWebSocketSender>,
        MockEventRepository,
        MockSubscriptionRepository,
        MockWebSocketSender,
    ) {
        let event_repo = MockEventRepository::new();
        let subscription_repo = MockSubscriptionRepository::new();
        let ws_sender = MockWebSocketSender::new();

        let handler = EventHandler::new(
            event_repo.clone(),
            subscription_repo.clone(),
            ws_sender.clone(),
        );

        (handler, event_repo, subscription_repo, ws_sender)
    }

    /// 有効なテストイベントを作成
    fn create_valid_event() -> (Event, Value) {
        let keys = Keys::generate();
        let event = EventBuilder::text_note("test content")
            .sign_with_keys(&keys)
            .expect("Failed to create event");
        let event_json = serde_json::to_value(&event).expect("Failed to serialize event");
        (event, event_json)
    }

    /// 特定のKindでテストイベントを作成
    fn create_event_with_kind(kind: u16) -> (Event, Value) {
        let keys = Keys::generate();
        let event = EventBuilder::new(Kind::from(kind), "test content")
            .sign_with_keys(&keys)
            .expect("Failed to create event");
        let event_json = serde_json::to_value(&event).expect("Failed to serialize event");
        (event, event_json)
    }

    /// Addressableイベントを作成
    fn create_addressable_event(d_tag: &str) -> (Event, Value) {
        let keys = Keys::generate();
        let tag = nostr::Tag::parse(["d", d_tag]).expect("Failed to parse tag");
        let event = EventBuilder::new(Kind::from(30000), "test content")
            .tags(vec![tag])
            .sign_with_keys(&keys)
            .expect("Failed to create event");
        let event_json = serde_json::to_value(&event).expect("Failed to serialize event");
        (event, event_json)
    }

    // ==================== 5.1 EVENTメッセージ処理テスト ====================

    /// 要件 5.1: 有効なイベントの検証と保存
    #[tokio::test]
    async fn test_handle_valid_event() {
        let (handler, event_repo, _, _) = create_test_handler();
        let (event, event_json) = create_valid_event();
        let event_id = event.id.to_hex();

        let response = handler.handle(event_json, "conn-123").await;

        // OK成功応答を確認
        match response {
            RelayMessage::Ok {
                event_id: resp_id,
                accepted,
                message,
            } => {
                assert_eq!(resp_id, event_id);
                assert!(accepted);
                assert!(message.is_empty());
            }
            _ => panic!("Expected Ok message"),
        }

        // イベントが保存されたことを確認
        assert_eq!(event_repo.event_count(), 1);
    }

    /// 要件 5.2: すべての検証に成功した場合にイベントを保存
    #[tokio::test]
    async fn test_handle_saves_event_after_validation() {
        let (handler, event_repo, _, _) = create_test_handler();
        let (event, event_json) = create_valid_event();
        let event_id = event.id.to_hex();

        handler.handle(event_json, "conn-123").await;

        // イベントがリポジトリに保存されたことを確認
        let saved = event_repo.get_event_sync(&event_id);
        assert!(saved.is_some());
        assert_eq!(saved.unwrap().id.to_hex(), event_id);
    }

    /// 要件 5.3: 保存成功時のOK成功応答
    #[tokio::test]
    async fn test_handle_returns_ok_success_on_save() {
        let (handler, _, _, _) = create_test_handler();
        let (event, event_json) = create_valid_event();
        let event_id = event.id.to_hex();

        let response = handler.handle(event_json, "conn-123").await;

        match response {
            RelayMessage::Ok {
                event_id: resp_id,
                accepted,
                message,
            } => {
                assert_eq!(resp_id, event_id);
                assert!(accepted);
                assert!(message.is_empty());
            }
            _ => panic!("Expected Ok success message"),
        }
    }

    /// 要件 5.4: 重複イベント時のOK重複応答
    #[tokio::test]
    async fn test_handle_returns_ok_duplicate_on_existing_event() {
        let (handler, _, _, _) = create_test_handler();
        let (event, event_json) = create_valid_event();
        let event_id = event.id.to_hex();

        // 最初の保存
        handler.handle(event_json.clone(), "conn-123").await;

        // 同じイベントを再度保存
        let response = handler.handle(event_json, "conn-123").await;

        match response {
            RelayMessage::Ok {
                event_id: resp_id,
                accepted,
                message,
            } => {
                assert_eq!(resp_id, event_id);
                assert!(accepted); // 重複でもacceptedはtrue
                assert!(message.contains("duplicate:"));
            }
            _ => panic!("Expected Ok duplicate message"),
        }
    }

    /// 要件 5.5: 検証失敗時のOKエラー応答
    #[tokio::test]
    async fn test_handle_returns_ok_error_on_validation_failure() {
        let (handler, _, _, _) = create_test_handler();

        // 無効なイベントJSON（idが短い）
        let invalid_event = json!({
            "id": "invalid",
            "pubkey": "a".repeat(64),
            "created_at": 1234567890,
            "kind": 1,
            "tags": [],
            "content": "hello",
            "sig": "b".repeat(128)
        });

        let response = handler.handle(invalid_event, "conn-123").await;

        match response {
            RelayMessage::Ok {
                accepted, message, ..
            } => {
                assert!(!accepted);
                assert!(message.contains("invalid:"));
            }
            _ => panic!("Expected Ok error message"),
        }
    }

    // ==================== 構造検証エラーテスト (要件 2.1-2.8) ====================

    /// 必須フィールド欠落時のエラー応答
    #[tokio::test]
    async fn test_handle_missing_required_field() {
        let (handler, _, _, _) = create_test_handler();

        let invalid_event = json!({
            "pubkey": "a".repeat(64),
            "created_at": 1234567890,
            "kind": 1,
            "tags": [],
            "content": "hello",
            "sig": "b".repeat(128)
            // "id" is missing
        });

        let response = handler.handle(invalid_event, "conn-123").await;

        match response {
            RelayMessage::Ok {
                accepted, message, ..
            } => {
                assert!(!accepted);
                assert!(message.contains("invalid:"));
            }
            _ => panic!("Expected Ok error message"),
        }
    }

    // ==================== ID検証エラーテスト (要件 3.5) ====================

    /// 要件 3.5: イベントIDの検証失敗時の応答
    #[tokio::test]
    async fn test_handle_id_mismatch_error() {
        let (handler, _, _, _) = create_test_handler();

        // 有効なイベントを作成してIDを改ざん
        let keys = Keys::generate();
        let event = EventBuilder::text_note("test content")
            .sign_with_keys(&keys)
            .expect("Failed to create event");
        let mut event_json = serde_json::to_value(&event).expect("Failed to serialize event");

        // IDを改ざん（有効な16進数形式だがハッシュ不一致）
        let tampered_id = "0".repeat(64);
        event_json["id"] = json!(tampered_id);

        let response = handler.handle(event_json, "conn-123").await;

        match response {
            RelayMessage::Ok {
                event_id: resp_id,
                accepted,
                message,
            } => {
                assert_eq!(resp_id, tampered_id);
                assert!(!accepted);
                assert!(message.contains("invalid:"));
                assert!(message.contains("event id does not match"));
            }
            _ => panic!("Expected Ok error message with id mismatch"),
        }
    }

    // ==================== 署名検証エラーテスト (要件 4.2) ====================

    /// 要件 4.2: 署名検証失敗時の応答
    #[tokio::test]
    async fn test_handle_signature_verification_failed() {
        let (handler, _, _, _) = create_test_handler();

        // 有効なイベントを作成して署名を改ざん
        let keys = Keys::generate();
        let event = EventBuilder::text_note("test content")
            .sign_with_keys(&keys)
            .expect("Failed to create event");
        let mut event_json = serde_json::to_value(&event).expect("Failed to serialize event");

        let event_id = event.id.to_hex();
        // 署名を改ざん（有効な16進数形式だが検証不一致）
        let tampered_sig = "a".repeat(128);
        event_json["sig"] = json!(tampered_sig);

        let response = handler.handle(event_json, "conn-123").await;

        match response {
            RelayMessage::Ok {
                event_id: resp_id,
                accepted,
                message,
            } => {
                assert_eq!(resp_id, event_id);
                assert!(!accepted);
                assert!(message.contains("invalid:"));
                assert!(message.contains("signature verification failed"));
            }
            _ => panic!("Expected Ok error message with signature verification failed"),
        }
    }

    // ==================== Kind別処理テスト ====================

    /// 要件 9.1: Regularイベント（kind=1）の保存
    #[tokio::test]
    async fn test_handle_regular_event_kind_1() {
        let (handler, event_repo, _, _) = create_test_handler();
        let (_, event_json) = create_event_with_kind(1);

        let response = handler.handle(event_json, "conn-123").await;

        // 成功応答を確認
        match response {
            RelayMessage::Ok { accepted, .. } => assert!(accepted),
            _ => panic!("Expected Ok message"),
        }

        // イベントが保存されたことを確認
        assert_eq!(event_repo.event_count(), 1);
    }

    /// 要件 10.1: Replaceableイベント（kind=0）の処理
    #[tokio::test]
    async fn test_handle_replaceable_event_kind_0() {
        let (handler, event_repo, _, _) = create_test_handler();
        let (_, event_json) = create_event_with_kind(0);

        let response = handler.handle(event_json, "conn-123").await;

        match response {
            RelayMessage::Ok { accepted, .. } => assert!(accepted),
            _ => panic!("Expected Ok message"),
        }

        assert_eq!(event_repo.event_count(), 1);
    }

    /// 要件 11.1, 11.2: Ephemeralイベント（kind=20000）は保存しない
    #[tokio::test]
    async fn test_handle_ephemeral_event_not_stored() {
        let (handler, event_repo, _, _) = create_test_handler();
        let (_, event_json) = create_event_with_kind(20000);

        let response = handler.handle(event_json, "conn-123").await;

        // 成功応答を確認
        match response {
            RelayMessage::Ok { accepted, .. } => assert!(accepted),
            _ => panic!("Expected Ok message"),
        }

        // イベントは保存されない
        assert_eq!(event_repo.event_count(), 0);
    }

    /// 要件 12.1: Addressableイベント（kind=30000）の処理
    #[tokio::test]
    async fn test_handle_addressable_event_kind_30000() {
        let (handler, event_repo, _, _) = create_test_handler();
        let (_, event_json) = create_addressable_event("test-identifier");

        let response = handler.handle(event_json, "conn-123").await;

        match response {
            RelayMessage::Ok { accepted, .. } => assert!(accepted),
            _ => panic!("Expected Ok message"),
        }

        assert_eq!(event_repo.event_count(), 1);
    }

    // ==================== 購読者への配信テスト ====================

    /// 要件 6.5: 新しいイベント受信時に購読者へ配信
    #[tokio::test]
    async fn test_handle_broadcasts_to_matching_subscribers() {
        let (handler, _, subscription_repo, ws_sender) = create_test_handler();

        // kind=1のフィルターを持つサブスクリプションを作成
        let filter = nostr::Filter::new().kind(Kind::TextNote);
        subscription_repo
            .upsert("conn-subscriber", "sub-1", &[filter])
            .await
            .unwrap();

        // kind=1のイベントを処理
        let (_, event_json) = create_valid_event();
        handler.handle(event_json, "conn-sender").await;

        // 購読者にメッセージが送信されたことを確認
        let messages = ws_sender.get_sent_messages("conn-subscriber");
        assert_eq!(messages.len(), 1);

        // EVENTメッセージ形式を確認
        let sent: Value = serde_json::from_str(&messages[0]).unwrap();
        assert_eq!(sent[0], "EVENT");
        assert_eq!(sent[1], "sub-1");
    }

    /// Ephemeralイベントも購読者に配信される
    #[tokio::test]
    async fn test_handle_broadcasts_ephemeral_event() {
        let (handler, event_repo, subscription_repo, ws_sender) = create_test_handler();

        // kind=20000のフィルターを持つサブスクリプションを作成
        let filter = nostr::Filter::new().kind(Kind::from(20000));
        subscription_repo
            .upsert("conn-subscriber", "sub-1", &[filter])
            .await
            .unwrap();

        // Ephemeralイベントを処理
        let (_, event_json) = create_event_with_kind(20000);
        handler.handle(event_json, "conn-sender").await;

        // 購読者にメッセージが送信されたことを確認
        let messages = ws_sender.get_sent_messages("conn-subscriber");
        assert_eq!(messages.len(), 1);

        // イベントは保存されない
        assert_eq!(event_repo.event_count(), 0);
    }

    /// マッチする購読者がいない場合は配信しない
    #[tokio::test]
    async fn test_handle_no_broadcast_without_matching_subscribers() {
        let (handler, _, subscription_repo, ws_sender) = create_test_handler();

        // kind=0のフィルターを持つサブスクリプションを作成
        let filter = nostr::Filter::new().kind(Kind::Metadata);
        subscription_repo
            .upsert("conn-subscriber", "sub-1", &[filter])
            .await
            .unwrap();

        // kind=1のイベントを処理（マッチしない）
        let (_, event_json) = create_valid_event();
        handler.handle(event_json, "conn-sender").await;

        // 購読者にメッセージは送信されない
        let messages = ws_sender.get_sent_messages("conn-subscriber");
        assert!(messages.is_empty());
    }

    /// 複数の購読者に配信
    #[tokio::test]
    async fn test_handle_broadcasts_to_multiple_subscribers() {
        let (handler, _, subscription_repo, ws_sender) = create_test_handler();

        // 複数のサブスクリプションを作成
        let filter1 = nostr::Filter::new().kind(Kind::TextNote);
        let filter2 = nostr::Filter::new().kind(Kind::TextNote);
        subscription_repo
            .upsert("conn-1", "sub-1", &[filter1])
            .await
            .unwrap();
        subscription_repo
            .upsert("conn-2", "sub-2", &[filter2])
            .await
            .unwrap();

        // kind=1のイベントを処理
        let (_, event_json) = create_valid_event();
        handler.handle(event_json, "conn-sender").await;

        // 両方の購読者にメッセージが送信されたことを確認
        assert_eq!(ws_sender.get_sent_messages("conn-1").len(), 1);
        assert_eq!(ws_sender.get_sent_messages("conn-2").len(), 1);
    }

    // ==================== ストレージエラーテスト (要件 16.8) ====================

    /// 要件 16.8: DynamoDB書き込み失敗時のエラー応答
    #[tokio::test]
    async fn test_handle_storage_error() {
        let (handler, event_repo, _, _) = create_test_handler();

        // リポジトリにエラーを設定
        event_repo.set_next_error(EventRepositoryError::WriteError(
            "DynamoDB unavailable".to_string(),
        ));

        let (event, event_json) = create_valid_event();
        let event_id = event.id.to_hex();

        let response = handler.handle(event_json, "conn-123").await;

        match response {
            RelayMessage::Ok {
                event_id: resp_id,
                accepted,
                message,
            } => {
                assert_eq!(resp_id, event_id);
                assert!(!accepted);
                assert!(message.contains("error:"));
                assert!(message.contains("failed to store event"));
            }
            _ => panic!("Expected Ok error message with storage error"),
        }
    }

    // ==================== エラー型テスト ====================

    #[test]
    fn test_event_handler_error_from_validation_error() {
        let err = ValidationError::InvalidIdFormat;
        let handler_err: EventHandlerError = err.clone().into();
        match handler_err {
            EventHandlerError::ValidationError(e) => assert_eq!(e, err),
            _ => panic!("Expected ValidationError"),
        }
    }

    #[test]
    fn test_event_handler_error_from_repository_error() {
        let err = EventRepositoryError::WriteError("test".to_string());
        let handler_err: EventHandlerError = err.into();
        match handler_err {
            EventHandlerError::RepositoryError(msg) => assert!(msg.contains("Write error")),
            _ => panic!("Expected RepositoryError"),
        }
    }

    #[test]
    fn test_event_handler_error_from_send_error() {
        let err = SendError::ConnectionGone;
        let handler_err: EventHandlerError = err.into();
        match handler_err {
            EventHandlerError::SendError(msg) => assert!(msg.contains("Connection is gone")),
            _ => panic!("Expected SendError"),
        }
    }

    // ==================== 制限値バリデーション統合テスト (要件 3.4-3.7) ====================

    use crate::domain::LimitationConfig;

    /// 制限値設定を指定してテスト用EventHandlerでイベントを処理
    async fn handle_event_with_config(
        event_json: Value,
        config: &LimitationConfig,
    ) -> RelayMessage {
        let (handler, _, _, _) = create_test_handler();
        handler.handle_with_config(event_json, "conn-123", config).await
    }

    /// 多数のタグを持つイベントを作成するヘルパー
    fn create_event_with_tags(tag_count: usize) -> Value {
        let keys = Keys::generate();
        let tags: Vec<nostr::Tag> = (0..tag_count)
            .map(|i| {
                nostr::Tag::custom(
                    nostr::TagKind::Custom(format!("t{}", i).into()),
                    vec![format!("value{}", i)],
                )
            })
            .collect();

        let event = nostr::EventBuilder::text_note("test content")
            .tags(tags)
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        serde_json::to_value(&event).expect("Failed to serialize event")
    }

    /// 長いコンテンツを持つイベントを作成するヘルパー
    fn create_event_with_long_content(content: &str) -> Value {
        let keys = Keys::generate();
        let event = nostr::EventBuilder::text_note(content)
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        serde_json::to_value(&event).expect("Failed to serialize event")
    }

    /// 指定されたcreated_atを持つイベントを作成するヘルパー
    fn create_event_with_created_at(timestamp: u64) -> Value {
        let keys = Keys::generate();
        let event = nostr::EventBuilder::text_note("test content")
            .custom_created_at(nostr::Timestamp::from(timestamp))
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        serde_json::to_value(&event).expect("Failed to serialize event")
    }

    /// 要件 3.4: タグ数が制限を超える場合は「invalid: too many tags」で拒否
    #[tokio::test]
    async fn test_handle_with_config_rejects_too_many_tags() {
        let config = LimitationConfig {
            max_event_tags: 10,
            ..LimitationConfig::default()
        };

        let event_json = create_event_with_tags(11); // 制限を1つ超過

        let response = handle_event_with_config(event_json, &config).await;

        match response {
            RelayMessage::Ok {
                accepted,
                message,
                ..
            } => {
                assert!(!accepted);
                assert!(message.contains("invalid:"));
                assert!(message.contains("too many tags"));
            }
            _ => panic!("Expected Ok message"),
        }
    }

    /// 要件 3.4: タグ数が制限内の場合は正常に処理
    #[tokio::test]
    async fn test_handle_with_config_accepts_tags_at_limit() {
        let config = LimitationConfig {
            max_event_tags: 10,
            ..LimitationConfig::default()
        };

        let event_json = create_event_with_tags(10); // ちょうど制限値

        let response = handle_event_with_config(event_json, &config).await;

        match response {
            RelayMessage::Ok { accepted, .. } => {
                assert!(accepted);
            }
            _ => panic!("Expected Ok message"),
        }
    }

    /// 要件 3.5: コンテンツ長が制限を超える場合は「invalid: content too long」で拒否
    #[tokio::test]
    async fn test_handle_with_config_rejects_content_too_long() {
        let config = LimitationConfig {
            max_content_length: 10,
            ..LimitationConfig::default()
        };

        let event_json = create_event_with_long_content("01234567890"); // 11文字、制限を1つ超過

        let response = handle_event_with_config(event_json, &config).await;

        match response {
            RelayMessage::Ok {
                accepted,
                message,
                ..
            } => {
                assert!(!accepted);
                assert!(message.contains("invalid:"));
                assert!(message.contains("content too long"));
            }
            _ => panic!("Expected Ok message"),
        }
    }

    /// 要件 3.5: コンテンツ長が制限内の場合は正常に処理
    #[tokio::test]
    async fn test_handle_with_config_accepts_content_at_limit() {
        let config = LimitationConfig {
            max_content_length: 10,
            ..LimitationConfig::default()
        };

        let event_json = create_event_with_long_content("0123456789"); // ちょうど10文字

        let response = handle_event_with_config(event_json, &config).await;

        match response {
            RelayMessage::Ok { accepted, .. } => {
                assert!(accepted);
            }
            _ => panic!("Expected Ok message"),
        }
    }

    /// 要件 3.5: Unicode文字数でカウント（バイト数ではない）
    #[tokio::test]
    async fn test_handle_with_config_content_length_counts_unicode_chars() {
        let config = LimitationConfig {
            max_content_length: 5,
            ..LimitationConfig::default()
        };

        // "あいうえお" は5文字（15バイト）
        let event_json = create_event_with_long_content("あいうえお");

        let response = handle_event_with_config(event_json, &config).await;

        match response {
            RelayMessage::Ok { accepted, .. } => {
                assert!(accepted); // 5文字なのでOK
            }
            _ => panic!("Expected Ok message"),
        }
    }

    /// 要件 3.6: created_atが過去すぎる場合は「invalid: created_at out of range」で拒否
    #[tokio::test]
    async fn test_handle_with_config_rejects_created_at_too_old() {
        let config = LimitationConfig {
            created_at_lower_limit: 3600, // 1時間
            ..LimitationConfig::default()
        };

        // 現在時刻から2時間前
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let event_json = create_event_with_created_at(now - 7200);

        let response = handle_event_with_config(event_json, &config).await;

        match response {
            RelayMessage::Ok {
                accepted,
                message,
                ..
            } => {
                assert!(!accepted);
                assert!(message.contains("invalid:"));
                assert!(message.contains("created_at out of range"));
            }
            _ => panic!("Expected Ok message"),
        }
    }

    /// 要件 3.6: created_atが制限内の過去の場合は正常に処理
    #[tokio::test]
    async fn test_handle_with_config_accepts_created_at_within_lower_limit() {
        let config = LimitationConfig {
            created_at_lower_limit: 3600, // 1時間
            ..LimitationConfig::default()
        };

        // 現在時刻から30分前
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let event_json = create_event_with_created_at(now - 1800);

        let response = handle_event_with_config(event_json, &config).await;

        match response {
            RelayMessage::Ok { accepted, .. } => {
                assert!(accepted);
            }
            _ => panic!("Expected Ok message"),
        }
    }

    /// 要件 3.7: created_atが未来すぎる場合は「invalid: created_at out of range」で拒否
    #[tokio::test]
    async fn test_handle_with_config_rejects_created_at_too_far_in_future() {
        let config = LimitationConfig {
            created_at_upper_limit: 900, // 15分
            ..LimitationConfig::default()
        };

        // 現在時刻から30分後
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let event_json = create_event_with_created_at(now + 1800);

        let response = handle_event_with_config(event_json, &config).await;

        match response {
            RelayMessage::Ok {
                accepted,
                message,
                ..
            } => {
                assert!(!accepted);
                assert!(message.contains("invalid:"));
                assert!(message.contains("created_at out of range"));
            }
            _ => panic!("Expected Ok message"),
        }
    }

    /// 要件 3.7: created_atが制限内の未来の場合は正常に処理
    #[tokio::test]
    async fn test_handle_with_config_accepts_created_at_within_upper_limit() {
        let config = LimitationConfig {
            created_at_upper_limit: 900, // 15分
            ..LimitationConfig::default()
        };

        // 現在時刻から5分後
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let event_json = create_event_with_created_at(now + 300);

        let response = handle_event_with_config(event_json, &config).await;

        match response {
            RelayMessage::Ok { accepted, .. } => {
                assert!(accepted);
            }
            _ => panic!("Expected Ok message"),
        }
    }

    /// すべての制限を満たすイベントは正常に処理される
    #[tokio::test]
    async fn test_handle_with_config_accepts_valid_event() {
        let config = LimitationConfig::default();
        let (_, event_json) = create_valid_event();

        let response = handle_event_with_config(event_json, &config).await;

        match response {
            RelayMessage::Ok { accepted, .. } => {
                assert!(accepted);
            }
            _ => panic!("Expected Ok message"),
        }
    }

    // ==================== NIP-09 kind:5削除リクエスト処理テスト ====================

    use nostr::Tag;

    /// kind:5削除リクエストを作成するヘルパー
    fn create_deletion_event_for_handler(keys: &Keys, tags: Vec<Tag>) -> Value {
        let event = EventBuilder::new(Kind::from(5), "deletion request")
            .tags(tags)
            .sign_with_keys(keys)
            .expect("Failed to create deletion event");
        serde_json::to_value(&event).expect("Failed to serialize event")
    }

    /// 通常のテストイベントを指定キーで作成するヘルパー
    fn create_text_note_for_handler(keys: &Keys) -> (Event, Value) {
        let event = EventBuilder::text_note("target content")
            .sign_with_keys(keys)
            .expect("Failed to create text note");
        let event_json = serde_json::to_value(&event).expect("Failed to serialize event");
        (event, event_json)
    }

    /// 要件 1.1, 1.4: kind:5削除リクエストが正常に処理されOK(true)を返す
    #[tokio::test]
    async fn test_handle_kind5_deletion_request_returns_ok_success() {
        let (handler, _, _, _) = create_test_handler();
        let keys = Keys::generate();

        // 空のタグで削除リクエスト
        let deletion_json = create_deletion_event_for_handler(&keys, vec![]);

        let response = handler.handle(deletion_json, "conn-123").await;

        match response {
            RelayMessage::Ok {
                accepted,
                message,
                ..
            } => {
                assert!(accepted);
                assert!(message.is_empty());
            }
            _ => panic!("Expected Ok message"),
        }
    }

    /// 要件 4.1: 削除リクエストイベント自体が保存される
    #[tokio::test]
    async fn test_handle_kind5_saves_deletion_event_itself() {
        let (handler, event_repo, _, _) = create_test_handler();
        let keys = Keys::generate();

        let deletion_json = create_deletion_event_for_handler(&keys, vec![]);

        // 削除リクエストを処理
        handler.handle(deletion_json.clone(), "conn-123").await;

        // 削除リクエストイベント自体が保存されていることを確認
        let event_id = deletion_json.get("id").unwrap().as_str().unwrap();
        let saved = event_repo.get_by_id(event_id).await.unwrap();
        assert!(saved.is_some());
        assert_eq!(saved.unwrap().kind.as_u16(), 5);
    }

    /// 要件 2.1: eタグで指定したイベントが削除される
    #[tokio::test]
    async fn test_handle_kind5_deletes_target_event() {
        let (handler, event_repo, _, _) = create_test_handler();
        let keys = Keys::generate();

        // 削除対象イベントを保存
        let (target_event, target_json) = create_text_note_for_handler(&keys);
        let target_event_id = target_event.id.to_hex();
        handler.handle(target_json, "conn-123").await;
        assert_eq!(event_repo.event_count(), 1);

        // 削除リクエストを処理
        let e_tag = Tag::parse(["e", &target_event_id]).unwrap();
        let deletion_json = create_deletion_event_for_handler(&keys, vec![e_tag]);
        handler.handle(deletion_json, "conn-123").await;

        // 対象イベントが削除されていることを確認
        let deleted = event_repo.get_by_id(&target_event_id).await.unwrap();
        assert!(deleted.is_none());

        // 削除リクエストイベント自体は保存されている
        assert_eq!(event_repo.event_count(), 1);
    }

    /// 要件 2.2: pubkey不一致の場合は対象イベントが削除されない
    #[tokio::test]
    async fn test_handle_kind5_does_not_delete_other_users_event() {
        let (handler, event_repo, _, _) = create_test_handler();
        let owner_keys = Keys::generate();
        let attacker_keys = Keys::generate();

        // 所有者のイベントを保存
        let (target_event, target_json) = create_text_note_for_handler(&owner_keys);
        let target_event_id = target_event.id.to_hex();
        handler.handle(target_json, "conn-123").await;
        assert_eq!(event_repo.event_count(), 1);

        // 攻撃者が削除リクエストを送信
        let e_tag = Tag::parse(["e", &target_event_id]).unwrap();
        let deletion_json = create_deletion_event_for_handler(&attacker_keys, vec![e_tag]);
        handler.handle(deletion_json, "conn-456").await;

        // 対象イベントは削除されていない
        let still_exists = event_repo.get_by_id(&target_event_id).await.unwrap();
        assert!(still_exists.is_some());

        // 削除リクエストイベント自体は保存されている
        assert_eq!(event_repo.event_count(), 2);
    }

    /// 要件 5.1: kind:5イベントを削除しようとしても削除されない
    #[tokio::test]
    async fn test_handle_kind5_does_not_delete_other_kind5_event() {
        let (handler, event_repo, _, _) = create_test_handler();
        let keys = Keys::generate();

        // 最初のkind:5イベントを保存
        let first_deletion_json = create_deletion_event_for_handler(&keys, vec![]);
        let first_event_id = first_deletion_json.get("id").unwrap().as_str().unwrap().to_string();
        handler.handle(first_deletion_json, "conn-123").await;
        assert_eq!(event_repo.event_count(), 1);

        // 2番目の削除リクエストで最初のkind:5を削除しようとする
        let e_tag = Tag::parse(["e", &first_event_id]).unwrap();
        let second_deletion_json = create_deletion_event_for_handler(&keys, vec![e_tag]);
        handler.handle(second_deletion_json, "conn-123").await;

        // 最初のkind:5は削除されていない
        let still_exists = event_repo.get_by_id(&first_event_id).await.unwrap();
        assert!(still_exists.is_some());

        // 両方のkind:5イベントが保存されている
        assert_eq!(event_repo.event_count(), 2);
    }

    /// 要件 6.2: 削除リクエストがkind:5にマッチするサブスクリプションに配信される
    #[tokio::test]
    async fn test_handle_kind5_broadcasts_to_kind5_subscribers() {
        let (handler, _, subscription_repo, ws_sender) = create_test_handler();
        let keys = Keys::generate();

        // kind:5のフィルターを持つサブスクリプションを作成
        let filter = nostr::Filter::new().kind(Kind::from(5));
        subscription_repo
            .upsert("conn-subscriber", "sub-1", &[filter])
            .await
            .unwrap();

        // 削除リクエストを処理
        let deletion_json = create_deletion_event_for_handler(&keys, vec![]);
        handler.handle(deletion_json.clone(), "conn-sender").await;

        // 購読者にメッセージが送信されたことを確認
        let messages = ws_sender.get_sent_messages("conn-subscriber");
        assert_eq!(messages.len(), 1);

        // EVENTメッセージ形式を確認
        let sent: Value = serde_json::from_str(&messages[0]).unwrap();
        assert_eq!(sent[0], "EVENT");
        assert_eq!(sent[1], "sub-1");
        // kindが5であることを確認
        assert_eq!(sent[2]["kind"], 5);
    }

    /// 要件 1.5: 署名無効なkind:5はOK(false, invalid:)を返す（既存の検証ロジックでカバー）
    #[tokio::test]
    async fn test_handle_kind5_invalid_signature_returns_error() {
        let (handler, _, _, _) = create_test_handler();
        let keys = Keys::generate();

        // 有効な削除リクエストを作成
        let deletion_json = create_deletion_event_for_handler(&keys, vec![]);
        let event_id = deletion_json.get("id").unwrap().as_str().unwrap().to_string();

        // 署名を改ざん
        let mut tampered_json = deletion_json;
        tampered_json["sig"] = serde_json::json!("a".repeat(128));

        let response = handler.handle(tampered_json, "conn-123").await;

        match response {
            RelayMessage::Ok {
                event_id: resp_id,
                accepted,
                message,
            } => {
                assert_eq!(resp_id, event_id);
                assert!(!accepted);
                assert!(message.contains("invalid:"));
                assert!(message.contains("signature verification failed"));
            }
            _ => panic!("Expected Ok error message"),
        }
    }

    /// 複数のeタグを含む削除リクエストが正常に処理される
    #[tokio::test]
    async fn test_handle_kind5_multiple_e_tags() {
        let (handler, event_repo, _, _) = create_test_handler();
        let keys = Keys::generate();

        // 3つのイベントを保存（異なるコンテンツで異なるIDを持つイベント）
        let event1 = EventBuilder::text_note("content 1")
            .sign_with_keys(&keys)
            .expect("Failed to create event 1");
        let event2 = EventBuilder::text_note("content 2")
            .sign_with_keys(&keys)
            .expect("Failed to create event 2");
        let event3 = EventBuilder::text_note("content 3")
            .sign_with_keys(&keys)
            .expect("Failed to create event 3");
        handler
            .handle(serde_json::to_value(&event1).unwrap(), "conn-123")
            .await;
        handler
            .handle(serde_json::to_value(&event2).unwrap(), "conn-123")
            .await;
        handler
            .handle(serde_json::to_value(&event3).unwrap(), "conn-123")
            .await;
        assert_eq!(event_repo.event_count(), 3);

        // 3つ全てを削除する削除リクエスト
        let e_tag1 = Tag::parse(["e", &event1.id.to_hex()]).unwrap();
        let e_tag2 = Tag::parse(["e", &event2.id.to_hex()]).unwrap();
        let e_tag3 = Tag::parse(["e", &event3.id.to_hex()]).unwrap();
        let deletion_json = create_deletion_event_for_handler(&keys, vec![e_tag1, e_tag2, e_tag3]);

        let response = handler.handle(deletion_json, "conn-123").await;

        // OK(true)が返される
        match response {
            RelayMessage::Ok { accepted, .. } => {
                assert!(accepted);
            }
            _ => panic!("Expected Ok message"),
        }

        // 削除リクエストイベント自体のみが残る
        assert_eq!(event_repo.event_count(), 1);
    }

    /// 既存のKind分類ロジックが維持されている（kind:1は通常通り保存される）
    #[tokio::test]
    async fn test_handle_preserves_existing_kind_classification() {
        let (handler, event_repo, _, _) = create_test_handler();

        // kind:1のイベント
        let (_, event_json) = create_valid_event();
        handler.handle(event_json, "conn-123").await;
        assert_eq!(event_repo.event_count(), 1);

        // kind:0のイベント（Replaceable）
        let keys = Keys::generate();
        let metadata_event = EventBuilder::new(Kind::Metadata, "metadata")
            .sign_with_keys(&keys)
            .expect("Failed to create metadata event");
        let metadata_json = serde_json::to_value(&metadata_event).unwrap();
        handler.handle(metadata_json, "conn-123").await;
        assert_eq!(event_repo.event_count(), 2);

        // kind:20000のイベント（Ephemeral）は保存されない
        let ephemeral_event = EventBuilder::new(Kind::from(20000), "ephemeral")
            .sign_with_keys(&keys)
            .expect("Failed to create ephemeral event");
        let ephemeral_json = serde_json::to_value(&ephemeral_event).unwrap();
        handler.handle(ephemeral_json, "conn-123").await;
        assert_eq!(event_repo.event_count(), 2); // 増えない
    }
}
