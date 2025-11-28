/// NIP-01準拠のリレーメッセージ型
///
/// 要件: 14.1-14.4
use nostr::Event;
use serde_json::json;

/// OKおよびCLOSEDメッセージ用の機械可読エラープレフィックス (要件 14.2)
pub mod error_prefix {
    pub const DUPLICATE: &str = "duplicate:";
    pub const POW: &str = "pow:";
    pub const BLOCKED: &str = "blocked:";
    pub const RATE_LIMITED: &str = "rate-limited:";
    pub const INVALID: &str = "invalid:";
    pub const RESTRICTED: &str = "restricted:";
    pub const ERROR: &str = "error:";
}

/// リレーからクライアントへのメッセージ (要件 14.1-14.4)
#[derive(Debug, Clone)]
pub enum RelayMessage {
    /// サブスクリプション用のEVENTレスポンス (要件 6.2)
    /// ["EVENT", <subscription_id>, <event JSON>]
    Event {
        subscription_id: String,
        event: Event,
    },

    /// EVENTメッセージ用のOKレスポンス (要件 14.1)
    /// ["OK", <event_id>, <true|false>, <message>]
    Ok {
        event_id: String,
        accepted: bool,
        message: String,
    },

    /// EOSE (保存済みイベント終了) レスポンス (要件 6.3)
    /// ["EOSE", <subscription_id>]
    Eose { subscription_id: String },

    /// サブスクリプション終了用のCLOSEDレスポンス (要件 14.3)
    /// ["CLOSED", <subscription_id>, <message>]
    Closed {
        subscription_id: String,
        message: String,
    },

    /// 一般通知用のNOTICE (要件 14.4)
    /// ["NOTICE", <message>]
    Notice { message: String },
}

impl RelayMessage {
    /// メッセージをJSON文字列に変換
    pub fn to_json(&self) -> String {
        match self {
            RelayMessage::Event {
                subscription_id,
                event,
            } => {
                let event_json = serde_json::to_value(event).unwrap_or(json!(null));
                json!(["EVENT", subscription_id, event_json]).to_string()
            }

            RelayMessage::Ok {
                event_id,
                accepted,
                message,
            } => {
                json!(["OK", event_id, accepted, message]).to_string()
            }

            RelayMessage::Eose { subscription_id } => {
                json!(["EOSE", subscription_id]).to_string()
            }

            RelayMessage::Closed {
                subscription_id,
                message,
            } => {
                json!(["CLOSED", subscription_id, message]).to_string()
            }

            RelayMessage::Notice { message } => {
                json!(["NOTICE", message]).to_string()
            }
        }
    }

    // ==================== OKメッセージヘルパー ====================

    /// OK成功メッセージを作成 (要件 5.3)
    pub fn ok_success(event_id: &str) -> Self {
        RelayMessage::Ok {
            event_id: event_id.to_string(),
            accepted: true,
            message: String::new(),
        }
    }

    /// OK重複メッセージを作成 (要件 5.4)
    pub fn ok_duplicate(event_id: &str) -> Self {
        RelayMessage::Ok {
            event_id: event_id.to_string(),
            accepted: true,
            message: format!("{} already have this event", error_prefix::DUPLICATE),
        }
    }

    /// プレフィックス付きOKエラーメッセージを作成 (要件 5.5, 14.2)
    pub fn ok_error(event_id: &str, prefix: &str, message: &str) -> Self {
        RelayMessage::Ok {
            event_id: event_id.to_string(),
            accepted: false,
            message: format!("{} {}", prefix, message),
        }
    }

    /// 無効なイベントID用のOKエラーを作成 (要件 3.5)
    pub fn ok_invalid_id(event_id: &str) -> Self {
        Self::ok_error(event_id, error_prefix::INVALID, "event id does not match")
    }

    /// 無効な署名用のOKエラーを作成 (要件 4.2)
    pub fn ok_invalid_signature(event_id: &str) -> Self {
        Self::ok_error(event_id, error_prefix::INVALID, "signature verification failed")
    }

    /// ストレージ失敗用のOKエラーを作成 (要件 16.8)
    pub fn ok_storage_error(event_id: &str) -> Self {
        Self::ok_error(event_id, error_prefix::ERROR, "failed to store event")
    }

    // ==================== CLOSEDメッセージヘルパー ====================

    /// 無効なサブスクリプション用のCLOSEDメッセージを作成 (要件 6.7)
    pub fn closed_invalid(subscription_id: &str, message: &str) -> Self {
        RelayMessage::Closed {
            subscription_id: subscription_id.to_string(),
            message: format!("{} {}", error_prefix::INVALID, message),
        }
    }

    /// 無効なサブスクリプションID用のCLOSEDメッセージを作成 (要件 6.7)
    pub fn closed_invalid_subscription_id(subscription_id: &str) -> Self {
        Self::closed_invalid(subscription_id, "subscription id must be 1-64 characters")
    }

    /// エラー用のCLOSEDメッセージを作成 (要件 18.8)
    pub fn closed_error(subscription_id: &str, message: &str) -> Self {
        RelayMessage::Closed {
            subscription_id: subscription_id.to_string(),
            message: format!("{} {}", error_prefix::ERROR, message),
        }
    }

    /// サブスクリプション管理エラー用のCLOSEDメッセージを作成 (要件 18.8)
    pub fn closed_subscription_error(subscription_id: &str) -> Self {
        Self::closed_error(subscription_id, "failed to manage subscription")
    }

    /// サブスクリプションID長超過用のCLOSEDメッセージを作成 (要件 4.1, 4.2, 4.3)
    pub fn closed_subscription_id_too_long(subscription_id: &str) -> Self {
        Self::closed_invalid(subscription_id, "subscription id too long")
    }

    /// サブスクリプション数上限超過用のCLOSEDメッセージを作成 (要件 3.2)
    pub fn closed_too_many_subscriptions(subscription_id: &str) -> Self {
        Self::closed_error(subscription_id, "too many subscriptions")
    }

    // ==================== NOTICEメッセージヘルパー ====================

    /// 無効なメッセージフォーマット用のNOTICEを作成 (要件 15.1)
    pub fn notice_invalid_format() -> Self {
        RelayMessage::Notice {
            message: format!("{} invalid message format", error_prefix::ERROR),
        }
    }

    /// 未知のメッセージタイプ用のNOTICEを作成 (要件 15.2)
    pub fn notice_unknown_type() -> Self {
        RelayMessage::Notice {
            message: format!("{} unknown message type", error_prefix::ERROR),
        }
    }

    /// JSONパースエラー用のNOTICEを作成 (要件 15.3)
    pub fn notice_parse_error() -> Self {
        RelayMessage::Notice {
            message: format!("{} failed to parse JSON", error_prefix::ERROR),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys};
    use serde_json::Value;

    fn create_test_event() -> Event {
        let keys = Keys::generate();
        EventBuilder::text_note("test content")
            .sign_with_keys(&keys)
            .expect("Failed to create event")
    }

    // ==================== JSON変換テスト ====================

    // 要件 14.1: EVENTレスポンスフォーマット
    #[test]
    fn test_event_message_json() {
        let event = create_test_event();
        let subscription_id = "test-sub".to_string();

        let msg = RelayMessage::Event {
            subscription_id: subscription_id.clone(),
            event: event.clone(),
        };

        let json_str = msg.to_json();
        let parsed: Value = serde_json::from_str(&json_str).unwrap();

        assert_eq!(parsed[0], "EVENT");
        assert_eq!(parsed[1], subscription_id);
        assert!(parsed[2].is_object());
        assert_eq!(parsed[2]["id"].as_str().unwrap(), event.id.to_hex());
    }

    // 要件 14.1: OKレスポンスフォーマット
    #[test]
    fn test_ok_message_json_accepted() {
        let msg = RelayMessage::Ok {
            event_id: "abc123".to_string(),
            accepted: true,
            message: "".to_string(),
        };

        let json_str = msg.to_json();
        let parsed: Value = serde_json::from_str(&json_str).unwrap();

        assert_eq!(parsed[0], "OK");
        assert_eq!(parsed[1], "abc123");
        assert_eq!(parsed[2], true);
        assert_eq!(parsed[3], "");
    }

    #[test]
    fn test_ok_message_json_rejected() {
        let msg = RelayMessage::Ok {
            event_id: "abc123".to_string(),
            accepted: false,
            message: "invalid: bad signature".to_string(),
        };

        let json_str = msg.to_json();
        let parsed: Value = serde_json::from_str(&json_str).unwrap();

        assert_eq!(parsed[0], "OK");
        assert_eq!(parsed[1], "abc123");
        assert_eq!(parsed[2], false);
        assert_eq!(parsed[3], "invalid: bad signature");
    }

    // 要件 6.3: EOSEレスポンスフォーマット
    #[test]
    fn test_eose_message_json() {
        let msg = RelayMessage::Eose {
            subscription_id: "sub123".to_string(),
        };

        let json_str = msg.to_json();
        let parsed: Value = serde_json::from_str(&json_str).unwrap();

        assert_eq!(parsed[0], "EOSE");
        assert_eq!(parsed[1], "sub123");
    }

    // 要件 14.3: CLOSEDレスポンスフォーマット
    #[test]
    fn test_closed_message_json() {
        let msg = RelayMessage::Closed {
            subscription_id: "sub123".to_string(),
            message: "error: something went wrong".to_string(),
        };

        let json_str = msg.to_json();
        let parsed: Value = serde_json::from_str(&json_str).unwrap();

        assert_eq!(parsed[0], "CLOSED");
        assert_eq!(parsed[1], "sub123");
        assert_eq!(parsed[2], "error: something went wrong");
    }

    // 要件 14.4: NOTICEレスポンスフォーマット
    #[test]
    fn test_notice_message_json() {
        let msg = RelayMessage::Notice {
            message: "hello from relay".to_string(),
        };

        let json_str = msg.to_json();
        let parsed: Value = serde_json::from_str(&json_str).unwrap();

        assert_eq!(parsed[0], "NOTICE");
        assert_eq!(parsed[1], "hello from relay");
    }

    // ==================== OKヘルパーテスト ====================

    #[test]
    fn test_ok_success() {
        let msg = RelayMessage::ok_success("event123");

        match msg {
            RelayMessage::Ok {
                event_id,
                accepted,
                message,
            } => {
                assert_eq!(event_id, "event123");
                assert!(accepted);
                assert!(message.is_empty());
            }
            _ => panic!("Expected Ok message"),
        }
    }

    // 要件 5.4: OK重複フォーマット
    #[test]
    fn test_ok_duplicate() {
        let msg = RelayMessage::ok_duplicate("event123");

        match msg {
            RelayMessage::Ok {
                event_id,
                accepted,
                message,
            } => {
                assert_eq!(event_id, "event123");
                assert!(accepted); // Duplicate is still accepted
                assert!(message.starts_with("duplicate:"));
                assert!(message.contains("already have this event"));
            }
            _ => panic!("Expected Ok message"),
        }
    }

    // 要件 14.2: プレフィックス付きOKエラー
    #[test]
    fn test_ok_error() {
        let msg = RelayMessage::ok_error("event123", error_prefix::INVALID, "bad format");

        match msg {
            RelayMessage::Ok {
                event_id,
                accepted,
                message,
            } => {
                assert_eq!(event_id, "event123");
                assert!(!accepted);
                assert!(message.starts_with("invalid:"));
                assert!(message.contains("bad format"));
            }
            _ => panic!("Expected Ok message"),
        }
    }

    // 要件 3.5: 無効なIDエラー
    #[test]
    fn test_ok_invalid_id() {
        let msg = RelayMessage::ok_invalid_id("event123");

        match msg {
            RelayMessage::Ok { message, .. } => {
                assert!(message.starts_with("invalid:"));
                assert!(message.contains("event id does not match"));
            }
            _ => panic!("Expected Ok message"),
        }
    }

    // 要件 4.2: 無効な署名エラー
    #[test]
    fn test_ok_invalid_signature() {
        let msg = RelayMessage::ok_invalid_signature("event123");

        match msg {
            RelayMessage::Ok { message, .. } => {
                assert!(message.starts_with("invalid:"));
                assert!(message.contains("signature verification failed"));
            }
            _ => panic!("Expected Ok message"),
        }
    }

    // 要件 16.8: ストレージエラー
    #[test]
    fn test_ok_storage_error() {
        let msg = RelayMessage::ok_storage_error("event123");

        match msg {
            RelayMessage::Ok { message, .. } => {
                assert!(message.starts_with("error:"));
                assert!(message.contains("failed to store event"));
            }
            _ => panic!("Expected Ok message"),
        }
    }

    // ==================== CLOSEDヘルパーテスト ====================

    // 要件 6.7: 無効なサブスクリプションID
    #[test]
    fn test_closed_invalid_subscription_id() {
        let msg = RelayMessage::closed_invalid_subscription_id("bad-sub");

        match msg {
            RelayMessage::Closed {
                subscription_id,
                message,
            } => {
                assert_eq!(subscription_id, "bad-sub");
                assert!(message.starts_with("invalid:"));
                assert!(message.contains("subscription id must be 1-64 characters"));
            }
            _ => panic!("Expected Closed message"),
        }
    }

    // 要件 18.8: サブスクリプション管理エラー
    #[test]
    fn test_closed_subscription_error() {
        let msg = RelayMessage::closed_subscription_error("sub123");

        match msg {
            RelayMessage::Closed {
                subscription_id,
                message,
            } => {
                assert_eq!(subscription_id, "sub123");
                assert!(message.starts_with("error:"));
                assert!(message.contains("failed to manage subscription"));
            }
            _ => panic!("Expected Closed message"),
        }
    }

    // 要件 4.1, 4.2, 4.3: サブスクリプションID長超過
    #[test]
    fn test_closed_subscription_id_too_long() {
        let msg = RelayMessage::closed_subscription_id_too_long("long-sub-id");

        match msg {
            RelayMessage::Closed {
                subscription_id,
                message,
            } => {
                assert_eq!(subscription_id, "long-sub-id");
                assert!(message.starts_with("invalid:"));
                assert!(message.contains("subscription id too long"));
            }
            _ => panic!("Expected Closed message"),
        }
    }

    // 要件 3.2: サブスクリプション数上限超過
    #[test]
    fn test_closed_too_many_subscriptions() {
        let msg = RelayMessage::closed_too_many_subscriptions("sub123");

        match msg {
            RelayMessage::Closed {
                subscription_id,
                message,
            } => {
                assert_eq!(subscription_id, "sub123");
                assert!(message.starts_with("error:"));
                assert!(message.contains("too many subscriptions"));
            }
            _ => panic!("Expected Closed message"),
        }
    }

    // ==================== NOTICEヘルパーテスト ====================

    // 要件 15.1: 無効なフォーマット通知
    #[test]
    fn test_notice_invalid_format() {
        let msg = RelayMessage::notice_invalid_format();

        match msg {
            RelayMessage::Notice { message } => {
                assert!(message.starts_with("error:"));
                assert!(message.contains("invalid message format"));
            }
            _ => panic!("Expected Notice message"),
        }
    }

    // 要件 15.2: 未知のタイプ通知
    #[test]
    fn test_notice_unknown_type() {
        let msg = RelayMessage::notice_unknown_type();

        match msg {
            RelayMessage::Notice { message } => {
                assert!(message.starts_with("error:"));
                assert!(message.contains("unknown message type"));
            }
            _ => panic!("Expected Notice message"),
        }
    }

    // 要件 15.3: パースエラー通知
    #[test]
    fn test_notice_parse_error() {
        let msg = RelayMessage::notice_parse_error();

        match msg {
            RelayMessage::Notice { message } => {
                assert!(message.starts_with("error:"));
                assert!(message.contains("failed to parse JSON"));
            }
            _ => panic!("Expected Notice message"),
        }
    }

    // ==================== エラープレフィックス定数テスト ====================

    #[test]
    fn test_error_prefix_format() {
        // すべてのプレフィックスはコロンで終わる必要がある
        assert!(error_prefix::DUPLICATE.ends_with(':'));
        assert!(error_prefix::POW.ends_with(':'));
        assert!(error_prefix::BLOCKED.ends_with(':'));
        assert!(error_prefix::RATE_LIMITED.ends_with(':'));
        assert!(error_prefix::INVALID.ends_with(':'));
        assert!(error_prefix::RESTRICTED.ends_with(':'));
        assert!(error_prefix::ERROR.ends_with(':'));
    }

    #[test]
    fn test_error_prefix_values() {
        assert_eq!(error_prefix::DUPLICATE, "duplicate:");
        assert_eq!(error_prefix::POW, "pow:");
        assert_eq!(error_prefix::BLOCKED, "blocked:");
        assert_eq!(error_prefix::RATE_LIMITED, "rate-limited:");
        assert_eq!(error_prefix::INVALID, "invalid:");
        assert_eq!(error_prefix::RESTRICTED, "restricted:");
        assert_eq!(error_prefix::ERROR, "error:");
    }
}
