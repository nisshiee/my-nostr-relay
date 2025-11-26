/// Relay message types for NIP-01 compliance
///
/// Requirements: 14.1-14.4
use nostr::Event;
use serde_json::json;

/// Machine-readable error prefixes for OK and CLOSED messages (Req 14.2)
pub mod error_prefix {
    pub const DUPLICATE: &str = "duplicate:";
    pub const POW: &str = "pow:";
    pub const BLOCKED: &str = "blocked:";
    pub const RATE_LIMITED: &str = "rate-limited:";
    pub const INVALID: &str = "invalid:";
    pub const RESTRICTED: &str = "restricted:";
    pub const ERROR: &str = "error:";
}

/// Relay to Client messages (Req 14.1-14.4)
#[derive(Debug, Clone)]
pub enum RelayMessage {
    /// EVENT response for subscriptions (Req 6.2)
    /// ["EVENT", <subscription_id>, <event JSON>]
    Event {
        subscription_id: String,
        event: Event,
    },

    /// OK response for EVENT messages (Req 14.1)
    /// ["OK", <event_id>, <true|false>, <message>]
    Ok {
        event_id: String,
        accepted: bool,
        message: String,
    },

    /// EOSE (End of Stored Events) response (Req 6.3)
    /// ["EOSE", <subscription_id>]
    Eose { subscription_id: String },

    /// CLOSED response for subscription termination (Req 14.3)
    /// ["CLOSED", <subscription_id>, <message>]
    Closed {
        subscription_id: String,
        message: String,
    },

    /// NOTICE for general notifications (Req 14.4)
    /// ["NOTICE", <message>]
    Notice { message: String },
}

impl RelayMessage {
    /// Convert message to JSON string
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

    // ==================== OK Message Helpers ====================

    /// Create OK success message (Req 5.3)
    pub fn ok_success(event_id: &str) -> Self {
        RelayMessage::Ok {
            event_id: event_id.to_string(),
            accepted: true,
            message: String::new(),
        }
    }

    /// Create OK duplicate message (Req 5.4)
    pub fn ok_duplicate(event_id: &str) -> Self {
        RelayMessage::Ok {
            event_id: event_id.to_string(),
            accepted: true,
            message: format!("{} already have this event", error_prefix::DUPLICATE),
        }
    }

    /// Create OK error message with prefix (Req 5.5, 14.2)
    pub fn ok_error(event_id: &str, prefix: &str, message: &str) -> Self {
        RelayMessage::Ok {
            event_id: event_id.to_string(),
            accepted: false,
            message: format!("{} {}", prefix, message),
        }
    }

    /// Create OK error for invalid event ID (Req 3.5)
    pub fn ok_invalid_id(event_id: &str) -> Self {
        Self::ok_error(event_id, error_prefix::INVALID, "event id does not match")
    }

    /// Create OK error for invalid signature (Req 4.2)
    pub fn ok_invalid_signature(event_id: &str) -> Self {
        Self::ok_error(event_id, error_prefix::INVALID, "signature verification failed")
    }

    /// Create OK error for storage failure (Req 16.8)
    pub fn ok_storage_error(event_id: &str) -> Self {
        Self::ok_error(event_id, error_prefix::ERROR, "failed to store event")
    }

    // ==================== CLOSED Message Helpers ====================

    /// Create CLOSED message for invalid subscription (Req 6.7)
    pub fn closed_invalid(subscription_id: &str, message: &str) -> Self {
        RelayMessage::Closed {
            subscription_id: subscription_id.to_string(),
            message: format!("{} {}", error_prefix::INVALID, message),
        }
    }

    /// Create CLOSED message for invalid subscription ID (Req 6.7)
    pub fn closed_invalid_subscription_id(subscription_id: &str) -> Self {
        Self::closed_invalid(subscription_id, "subscription id must be 1-64 characters")
    }

    /// Create CLOSED message for errors (Req 18.8)
    pub fn closed_error(subscription_id: &str, message: &str) -> Self {
        RelayMessage::Closed {
            subscription_id: subscription_id.to_string(),
            message: format!("{} {}", error_prefix::ERROR, message),
        }
    }

    /// Create CLOSED message for subscription management error (Req 18.8)
    pub fn closed_subscription_error(subscription_id: &str) -> Self {
        Self::closed_error(subscription_id, "failed to manage subscription")
    }

    // ==================== NOTICE Message Helpers ====================

    /// Create NOTICE for invalid message format (Req 15.1)
    pub fn notice_invalid_format() -> Self {
        RelayMessage::Notice {
            message: format!("{} invalid message format", error_prefix::ERROR),
        }
    }

    /// Create NOTICE for unknown message type (Req 15.2)
    pub fn notice_unknown_type() -> Self {
        RelayMessage::Notice {
            message: format!("{} unknown message type", error_prefix::ERROR),
        }
    }

    /// Create NOTICE for JSON parse error (Req 15.3)
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

    // ==================== JSON Conversion Tests ====================

    // Req 14.1: EVENT response format
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

    // Req 14.1: OK response format
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

    // Req 6.3: EOSE response format
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

    // Req 14.3: CLOSED response format
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

    // Req 14.4: NOTICE response format
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

    // ==================== OK Helper Tests ====================

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

    // Req 5.4: OK duplicate format
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

    // Req 14.2: OK error with prefix
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

    // Req 3.5: Invalid ID error
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

    // Req 4.2: Invalid signature error
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

    // Req 16.8: Storage error
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

    // ==================== CLOSED Helper Tests ====================

    // Req 6.7: Invalid subscription ID
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

    // Req 18.8: Subscription management error
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

    // ==================== NOTICE Helper Tests ====================

    // Req 15.1: Invalid format notice
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

    // Req 15.2: Unknown type notice
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

    // Req 15.3: Parse error notice
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

    // ==================== Error Prefix Constants Tests ====================

    #[test]
    fn test_error_prefix_format() {
        // All prefixes should end with colon
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
