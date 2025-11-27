/// WebSocketメッセージパーサー
///
/// NIP-01準拠のクライアントメッセージ（EVENT, REQ, CLOSE）をパースする
/// 要件: 5.1, 6.1, 6.6, 6.7, 7.1, 15.1, 15.2, 15.3
use serde_json::Value;
use thiserror::Error;

/// クライアントからリレーへのメッセージ
#[derive(Debug, Clone, PartialEq)]
pub enum ClientMessage {
    /// EVENTメッセージ: ["EVENT", <event JSON>]
    /// 要件 5.1
    Event(Value),

    /// REQメッセージ: ["REQ", <subscription_id>, <filters>...]
    /// 要件 6.1
    Req {
        subscription_id: String,
        filters: Vec<Value>,
    },

    /// CLOSEメッセージ: ["CLOSE", <subscription_id>]
    /// 要件 7.1
    Close { subscription_id: String },
}

/// メッセージパースエラー
#[derive(Debug, Clone, Error, PartialEq)]
pub enum ParseError {
    /// JSONパースに失敗 (要件 15.3)
    #[error("failed to parse JSON")]
    InvalidJson,

    /// メッセージがJSON配列でない (要件 15.1)
    #[error("invalid message format")]
    NotArray,

    /// メッセージタイプが文字列でない
    #[error("message type must be a string")]
    InvalidMessageType,

    /// 未知のメッセージタイプ (要件 15.2)
    #[error("unknown message type: {0}")]
    UnknownMessageType(String),

    /// 必須フィールドが不足
    #[error("missing required fields")]
    MissingFields,

    /// 無効なsubscription_id (要件 6.6, 6.7)
    #[error("subscription id must be 1-64 characters")]
    InvalidSubscriptionId,
}

/// WebSocketメッセージパーサー
pub struct MessageParser;

impl MessageParser {
    /// WebSocketメッセージをパースしてClientMessageに変換
    ///
    /// # 引数
    /// * `message` - パースするJSON文字列
    ///
    /// # 戻り値
    /// * `Ok(ClientMessage)` - パース成功時
    /// * `Err(ParseError)` - パース失敗時
    ///
    /// # 例
    /// ```
    /// use relay::application::MessageParser;
    ///
    /// let result = MessageParser::parse(r#"["CLOSE", "sub1"]"#);
    /// assert!(result.is_ok());
    /// ```
    pub fn parse(message: &str) -> Result<ClientMessage, ParseError> {
        // JSONとしてパース (要件 15.3)
        let value: Value = serde_json::from_str(message).map_err(|_| ParseError::InvalidJson)?;

        // 配列であることを検証 (要件 15.1)
        let array = value.as_array().ok_or(ParseError::NotArray)?;

        // 最低1要素（メッセージタイプ）が必要
        if array.is_empty() {
            return Err(ParseError::MissingFields);
        }

        // メッセージタイプを取得（文字列でなければエラー）
        let message_type = array[0]
            .as_str()
            .ok_or(ParseError::InvalidMessageType)?;

        match message_type {
            "EVENT" => Self::parse_event(array),
            "REQ" => Self::parse_req(array),
            "CLOSE" => Self::parse_close(array),
            other => Err(ParseError::UnknownMessageType(other.to_string())),
        }
    }

    /// EVENTメッセージをパース
    /// フォーマット: ["EVENT", <event JSON>]
    fn parse_event(array: &[Value]) -> Result<ClientMessage, ParseError> {
        // EVENTメッセージは最低2要素必要
        if array.len() < 2 {
            return Err(ParseError::MissingFields);
        }

        // 第2要素がイベントオブジェクト
        let event_json = array[1].clone();

        Ok(ClientMessage::Event(event_json))
    }

    /// REQメッセージをパース
    /// フォーマット: ["REQ", <subscription_id>, <filters>...]
    fn parse_req(array: &[Value]) -> Result<ClientMessage, ParseError> {
        // REQメッセージは最低2要素必要（subscription_id必須）
        if array.len() < 2 {
            return Err(ParseError::MissingFields);
        }

        // subscription_idを取得・検証
        let subscription_id = array[1]
            .as_str()
            .ok_or(ParseError::InvalidSubscriptionId)?;

        Self::validate_subscription_id(subscription_id)?;

        // フィルター配列を取得（3番目以降の要素）
        let filters: Vec<Value> = array.iter().skip(2).cloned().collect();

        Ok(ClientMessage::Req {
            subscription_id: subscription_id.to_string(),
            filters,
        })
    }

    /// CLOSEメッセージをパース
    /// フォーマット: ["CLOSE", <subscription_id>]
    fn parse_close(array: &[Value]) -> Result<ClientMessage, ParseError> {
        // CLOSEメッセージは2要素必要
        if array.len() < 2 {
            return Err(ParseError::MissingFields);
        }

        // subscription_idを取得・検証
        let subscription_id = array[1]
            .as_str()
            .ok_or(ParseError::InvalidSubscriptionId)?;

        Self::validate_subscription_id(subscription_id)?;

        Ok(ClientMessage::Close {
            subscription_id: subscription_id.to_string(),
        })
    }

    /// subscription_idの検証 (要件 6.6, 6.7)
    /// 1-64文字の非空文字列であることを確認
    /// NIP-01の「max length 64 chars」はUnicode文字数を意味するため、
    /// バイト長ではなく文字数でカウントする
    fn validate_subscription_id(subscription_id: &str) -> Result<(), ParseError> {
        let char_count = subscription_id.chars().count();
        if char_count == 0 || char_count > 64 {
            return Err(ParseError::InvalidSubscriptionId);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ==================== EVENTメッセージのパーステスト ====================

    /// 要件 5.1: 有効なEVENTメッセージのパース
    #[test]
    fn test_parse_event_valid() {
        let event_json = json!({
            "id": "abc123",
            "pubkey": "def456",
            "created_at": 1234567890,
            "kind": 1,
            "tags": [],
            "content": "hello",
            "sig": "sig789"
        });
        let message = json!(["EVENT", event_json]).to_string();

        let result = MessageParser::parse(&message);
        assert!(result.is_ok());

        match result.unwrap() {
            ClientMessage::Event(parsed_event) => {
                assert_eq!(parsed_event["id"], "abc123");
                assert_eq!(parsed_event["content"], "hello");
            }
            _ => panic!("Expected Event message"),
        }
    }

    /// EVENTメッセージのイベントJSONがオブジェクトでなくても受け入れる（検証は後段で行う）
    #[test]
    fn test_parse_event_with_non_object_event() {
        let message = r#"["EVENT", "not an object"]"#;

        let result = MessageParser::parse(message);
        assert!(result.is_ok());

        match result.unwrap() {
            ClientMessage::Event(value) => {
                assert_eq!(value, "not an object");
            }
            _ => panic!("Expected Event message"),
        }
    }

    /// EVENTメッセージでイベントJSONが欠落している場合
    #[test]
    fn test_parse_event_missing_event() {
        let message = r#"["EVENT"]"#;

        let result = MessageParser::parse(message);
        assert_eq!(result, Err(ParseError::MissingFields));
    }

    // ==================== REQメッセージのパーステスト ====================

    /// 要件 6.1: 有効なREQメッセージのパース（フィルターあり）
    #[test]
    fn test_parse_req_valid_with_filters() {
        let filter1 = json!({"kinds": [1], "limit": 10});
        let filter2 = json!({"authors": ["abc123"]});
        let message = json!(["REQ", "sub1", filter1, filter2]).to_string();

        let result = MessageParser::parse(&message);
        assert!(result.is_ok());

        match result.unwrap() {
            ClientMessage::Req {
                subscription_id,
                filters,
            } => {
                assert_eq!(subscription_id, "sub1");
                assert_eq!(filters.len(), 2);
                assert_eq!(filters[0]["kinds"][0], 1);
                assert_eq!(filters[1]["authors"][0], "abc123");
            }
            _ => panic!("Expected Req message"),
        }
    }

    /// 要件 6.1: フィルターなしのREQメッセージ
    #[test]
    fn test_parse_req_valid_no_filters() {
        let message = r#"["REQ", "sub1"]"#;

        let result = MessageParser::parse(message);
        assert!(result.is_ok());

        match result.unwrap() {
            ClientMessage::Req {
                subscription_id,
                filters,
            } => {
                assert_eq!(subscription_id, "sub1");
                assert!(filters.is_empty());
            }
            _ => panic!("Expected Req message"),
        }
    }

    /// 要件 6.6: subscription_idが空の場合
    #[test]
    fn test_parse_req_empty_subscription_id() {
        let message = r#"["REQ", ""]"#;

        let result = MessageParser::parse(message);
        assert_eq!(result, Err(ParseError::InvalidSubscriptionId));
    }

    /// 要件 6.6: subscription_idが64文字を超える場合
    #[test]
    fn test_parse_req_subscription_id_too_long() {
        let long_id = "a".repeat(65);
        let message = json!(["REQ", long_id]).to_string();

        let result = MessageParser::parse(&message);
        assert_eq!(result, Err(ParseError::InvalidSubscriptionId));
    }

    /// 要件 6.6: subscription_idが64文字ちょうどの場合（有効）
    #[test]
    fn test_parse_req_subscription_id_max_length() {
        let max_id = "a".repeat(64);
        let message = json!(["REQ", max_id]).to_string();

        let result = MessageParser::parse(&message);
        assert!(result.is_ok());

        match result.unwrap() {
            ClientMessage::Req { subscription_id, .. } => {
                assert_eq!(subscription_id.len(), 64);
            }
            _ => panic!("Expected Req message"),
        }
    }

    /// 要件 6.6: subscription_idが1文字の場合（有効）
    #[test]
    fn test_parse_req_subscription_id_min_length() {
        let message = r#"["REQ", "a"]"#;

        let result = MessageParser::parse(message);
        assert!(result.is_ok());

        match result.unwrap() {
            ClientMessage::Req { subscription_id, .. } => {
                assert_eq!(subscription_id, "a");
            }
            _ => panic!("Expected Req message"),
        }
    }

    /// REQメッセージでsubscription_idが欠落している場合
    #[test]
    fn test_parse_req_missing_subscription_id() {
        let message = r#"["REQ"]"#;

        let result = MessageParser::parse(message);
        assert_eq!(result, Err(ParseError::MissingFields));
    }

    /// REQメッセージでsubscription_idが文字列でない場合
    #[test]
    fn test_parse_req_subscription_id_not_string() {
        let message = r#"["REQ", 123]"#;

        let result = MessageParser::parse(message);
        assert_eq!(result, Err(ParseError::InvalidSubscriptionId));
    }

    // ==================== CLOSEメッセージのパーステスト ====================

    /// 要件 7.1: 有効なCLOSEメッセージのパース
    #[test]
    fn test_parse_close_valid() {
        let message = r#"["CLOSE", "sub1"]"#;

        let result = MessageParser::parse(message);
        assert!(result.is_ok());

        match result.unwrap() {
            ClientMessage::Close { subscription_id } => {
                assert_eq!(subscription_id, "sub1");
            }
            _ => panic!("Expected Close message"),
        }
    }

    /// 要件 6.7: CLOSEメッセージでsubscription_idが空の場合
    #[test]
    fn test_parse_close_empty_subscription_id() {
        let message = r#"["CLOSE", ""]"#;

        let result = MessageParser::parse(message);
        assert_eq!(result, Err(ParseError::InvalidSubscriptionId));
    }

    /// 要件 6.7: CLOSEメッセージでsubscription_idが64文字を超える場合
    #[test]
    fn test_parse_close_subscription_id_too_long() {
        let long_id = "a".repeat(65);
        let message = json!(["CLOSE", long_id]).to_string();

        let result = MessageParser::parse(&message);
        assert_eq!(result, Err(ParseError::InvalidSubscriptionId));
    }

    /// CLOSEメッセージでsubscription_idが欠落している場合
    #[test]
    fn test_parse_close_missing_subscription_id() {
        let message = r#"["CLOSE"]"#;

        let result = MessageParser::parse(message);
        assert_eq!(result, Err(ParseError::MissingFields));
    }

    // ==================== エラーハンドリングテスト ====================

    /// 要件 15.3: 無効なJSONの場合
    #[test]
    fn test_parse_invalid_json() {
        let message = "not valid json";

        let result = MessageParser::parse(message);
        assert_eq!(result, Err(ParseError::InvalidJson));
    }

    /// 要件 15.3: 不完全なJSONの場合
    #[test]
    fn test_parse_incomplete_json() {
        let message = r#"["EVENT""#;

        let result = MessageParser::parse(message);
        assert_eq!(result, Err(ParseError::InvalidJson));
    }

    /// 要件 15.1: メッセージがJSON配列でない場合（オブジェクト）
    #[test]
    fn test_parse_not_array_object() {
        let message = r#"{"type": "EVENT"}"#;

        let result = MessageParser::parse(message);
        assert_eq!(result, Err(ParseError::NotArray));
    }

    /// 要件 15.1: メッセージがJSON配列でない場合（文字列）
    #[test]
    fn test_parse_not_array_string() {
        let message = r#""EVENT""#;

        let result = MessageParser::parse(message);
        assert_eq!(result, Err(ParseError::NotArray));
    }

    /// 要件 15.1: メッセージがJSON配列でない場合（数値）
    #[test]
    fn test_parse_not_array_number() {
        let message = "123";

        let result = MessageParser::parse(message);
        assert_eq!(result, Err(ParseError::NotArray));
    }

    /// 空の配列の場合
    #[test]
    fn test_parse_empty_array() {
        let message = "[]";

        let result = MessageParser::parse(message);
        assert_eq!(result, Err(ParseError::MissingFields));
    }

    /// 要件 15.2: 未知のメッセージタイプの場合
    #[test]
    fn test_parse_unknown_message_type() {
        let message = r#"["UNKNOWN", "data"]"#;

        let result = MessageParser::parse(message);
        assert_eq!(result, Err(ParseError::UnknownMessageType("UNKNOWN".to_string())));
    }

    /// メッセージタイプが文字列でない場合
    #[test]
    fn test_parse_message_type_not_string() {
        let message = r#"[123, "data"]"#;

        let result = MessageParser::parse(message);
        assert_eq!(result, Err(ParseError::InvalidMessageType));
    }

    /// 要件 15.2: 小文字のメッセージタイプ（大文字小文字を区別）
    #[test]
    fn test_parse_lowercase_message_type() {
        let message = r#"["event", {}]"#;

        let result = MessageParser::parse(message);
        assert_eq!(result, Err(ParseError::UnknownMessageType("event".to_string())));
    }

    // ==================== 境界値テスト ====================

    /// subscription_idに特殊文字を含む場合（有効）
    #[test]
    fn test_parse_subscription_id_with_special_chars() {
        let message = r#"["REQ", "sub-1_test:abc"]"#;

        let result = MessageParser::parse(message);
        assert!(result.is_ok());

        match result.unwrap() {
            ClientMessage::Req { subscription_id, .. } => {
                assert_eq!(subscription_id, "sub-1_test:abc");
            }
            _ => panic!("Expected Req message"),
        }
    }

    /// subscription_idにUnicodeを含む場合（有効）
    #[test]
    fn test_parse_subscription_id_with_unicode() {
        let message = r#"["REQ", "sub-"]"#;

        let result = MessageParser::parse(message);
        assert!(result.is_ok());
    }

    /// 複数のフィルターを持つREQメッセージ
    #[test]
    fn test_parse_req_multiple_filters() {
        let message = json!([
            "REQ",
            "sub1",
            {"kinds": [1]},
            {"kinds": [2]},
            {"kinds": [3]},
            {"kinds": [4]},
            {"kinds": [5]}
        ]).to_string();

        let result = MessageParser::parse(&message);
        assert!(result.is_ok());

        match result.unwrap() {
            ClientMessage::Req { filters, .. } => {
                assert_eq!(filters.len(), 5);
            }
            _ => panic!("Expected Req message"),
        }
    }

    // ==================== ParseErrorのDisplayトレイト確認 ====================

    #[test]
    fn test_parse_error_display() {
        assert_eq!(
            ParseError::InvalidJson.to_string(),
            "failed to parse JSON"
        );
        assert_eq!(
            ParseError::NotArray.to_string(),
            "invalid message format"
        );
        assert_eq!(
            ParseError::InvalidMessageType.to_string(),
            "message type must be a string"
        );
        assert_eq!(
            ParseError::UnknownMessageType("FOO".to_string()).to_string(),
            "unknown message type: FOO"
        );
        assert_eq!(
            ParseError::MissingFields.to_string(),
            "missing required fields"
        );
        assert_eq!(
            ParseError::InvalidSubscriptionId.to_string(),
            "subscription id must be 1-64 characters"
        );
    }

    /// マルチバイト文字のsubscription_idが64文字まで許可されることを確認
    /// NIP-01の「max length 64 chars」はUnicode文字数を意味する
    #[test]
    fn test_parse_subscription_id_multibyte_64_chars() {
        // 64文字の日本語（192バイト）- 有効
        let id_64_chars = "あ".repeat(64);
        assert_eq!(id_64_chars.chars().count(), 64);
        assert_eq!(id_64_chars.len(), 192); // バイト長は192

        let message = json!(["REQ", id_64_chars]).to_string();
        let result = MessageParser::parse(&message);
        assert!(result.is_ok());
    }

    /// マルチバイト文字のsubscription_idが65文字以上で拒否されることを確認
    #[test]
    fn test_parse_subscription_id_multibyte_too_long() {
        // 65文字の日本語（195バイト）- 無効
        let id_65_chars = "あ".repeat(65);
        assert_eq!(id_65_chars.chars().count(), 65);

        let message = json!(["REQ", id_65_chars]).to_string();
        let result = MessageParser::parse(&message);
        assert_eq!(result, Err(ParseError::InvalidSubscriptionId));
    }
}
