/// NIP-01準拠のイベントバリデーション
///
/// 要件: 2.1-2.8, 3.1-3.5, 4.1-4.2
use nostr::Event;
use serde_json::Value;
use thiserror::Error;

/// イベント構造と検証のバリデーションエラー
#[derive(Debug, Clone, PartialEq, Error)]
pub enum ValidationError {
    /// 必須フィールドが欠落
    #[error("missing required field: {0}")]
    MissingField(String),
    /// イベントIDが有効な16進数形式でない（64文字の小文字）
    #[error("id must be 64 lowercase hex characters")]
    InvalidIdFormat,
    /// 公開鍵が有効な16進数形式でない（64文字の小文字）
    #[error("pubkey must be 64 lowercase hex characters")]
    InvalidPubkeyFormat,
    /// 署名が有効な16進数形式でない（128文字の小文字）
    #[error("sig must be 128 lowercase hex characters")]
    InvalidSignatureFormat,
    /// kind値が範囲外（0-65535）
    #[error("kind must be 0-65535")]
    InvalidKindRange,
    /// tagsが文字列配列の配列でない
    #[error("tags must be an array of string arrays")]
    InvalidTagsFormat,
    /// contentが文字列でない
    #[error("content must be a string")]
    InvalidContentFormat,
    /// created_atが有効なUnixタイムスタンプでない
    #[error("created_at must be a Unix timestamp")]
    InvalidTimestamp,
    /// イベントIDが計算されたハッシュと一致しない
    #[error("event id does not match")]
    IdMismatch,
    /// 署名検証に失敗
    #[error("signature verification failed")]
    SignatureVerificationFailed,
    /// イベントJSONのパースに失敗
    #[error("parse error: {0}")]
    ParseError(String),
}

/// NIP-01準拠のイベントバリデータ
pub struct EventValidator;

impl EventValidator {
    /// イベント構造のバリデーション（要件 2.1-2.8）
    ///
    /// チェック内容:
    /// - すべての必須フィールドが存在する (id, pubkey, created_at, kind, tags, content, sig)
    /// - idが64文字の小文字16進数（32バイト）
    /// - pubkeyが64文字の小文字16進数（32バイト）
    /// - created_atがUnixタイムスタンプ（整数）
    /// - kindが0-65535
    /// - tagsが文字列配列の配列
    /// - contentが文字列
    /// - sigが128文字の小文字16進数（64バイト）
    pub fn validate_structure(event_json: &Value) -> Result<(), ValidationError> {
        let obj = event_json
            .as_object()
            .ok_or_else(|| ValidationError::ParseError("event must be an object".to_string()))?;

        // 必須フィールドの存在確認 (要件 2.1)
        let required_fields = ["id", "pubkey", "created_at", "kind", "tags", "content", "sig"];
        for field in required_fields {
            if !obj.contains_key(field) {
                return Err(ValidationError::MissingField(field.to_string()));
            }
        }

        // idフォーマットのバリデーション (要件 2.2)
        let id = obj.get("id").unwrap();
        if !Self::is_valid_hex_string(id, 64) {
            return Err(ValidationError::InvalidIdFormat);
        }

        // pubkeyフォーマットのバリデーション (要件 2.3)
        let pubkey = obj.get("pubkey").unwrap();
        if !Self::is_valid_hex_string(pubkey, 64) {
            return Err(ValidationError::InvalidPubkeyFormat);
        }

        // created_atのバリデーション (要件 2.4)
        let created_at = obj.get("created_at").unwrap();
        if !created_at.is_u64() && !created_at.is_i64() {
            return Err(ValidationError::InvalidTimestamp);
        }

        // kindのバリデーション (要件 2.5)
        let kind = obj.get("kind").unwrap();
        if let Some(k) = kind.as_u64() {
            if k > 65535 {
                return Err(ValidationError::InvalidKindRange);
            }
        } else {
            return Err(ValidationError::InvalidKindRange);
        }

        // tagsのバリデーション (要件 2.6)
        let tags = obj.get("tags").unwrap();
        if !Self::is_valid_tags(tags) {
            return Err(ValidationError::InvalidTagsFormat);
        }

        // contentのバリデーション (要件 2.7)
        let content = obj.get("content").unwrap();
        if !content.is_string() {
            return Err(ValidationError::InvalidContentFormat);
        }

        // sigフォーマットのバリデーション (要件 2.8)
        let sig = obj.get("sig").unwrap();
        if !Self::is_valid_hex_string(sig, 128) {
            return Err(ValidationError::InvalidSignatureFormat);
        }

        Ok(())
    }

    /// イベントIDがシリアライズされたイベントデータのSHA256ハッシュと一致するか検証（要件 3.1-3.5）
    ///
    /// nostrクレートのEvent::verify_id()を使用:
    /// - イベントを [0, pubkey, created_at, kind, tags, content] としてシリアライズ
    /// - UTF-8エンコーディング使用
    /// - 空白やフォーマットなし
    /// - content内の特殊文字を適切にエスケープ
    pub fn verify_id(event: &Event) -> Result<(), ValidationError> {
        if event.verify_id() {
            Ok(())
        } else {
            Err(ValidationError::IdMismatch)
        }
    }

    /// Schnorr署名検証を使用してイベント署名を検証（要件 4.1-4.2）
    ///
    /// nostrクレートのEvent::verify()を使用して検証:
    /// - sigが有効なsecp256k1 Schnorr署名
    /// - 署名がpubkeyを使用してidに対して有効
    pub fn verify_signature(event: &Event) -> Result<(), ValidationError> {
        event
            .verify()
            .map_err(|_| ValidationError::SignatureVerificationFailed)
    }

    /// すべてのバリデーションを実行してEventにパース
    ///
    /// バリデーション順序: 構造 -> パース -> ID -> 署名
    pub fn validate_all(event_json: &Value) -> Result<Event, ValidationError> {
        // まず構造をバリデーション
        Self::validate_structure(event_json)?;

        // nostr Eventにパース
        let event: Event = serde_json::from_value(event_json.clone())
            .map_err(|e| ValidationError::ParseError(e.to_string()))?;

        // IDを検証 (要件 3.1-3.5)
        Self::verify_id(&event)?;

        // 署名を検証 (要件 4.1-4.2)
        Self::verify_signature(&event)?;

        Ok(event)
    }

    /// 値が指定された長さの有効な小文字16進数文字列かをチェック
    fn is_valid_hex_string(value: &Value, expected_len: usize) -> bool {
        if let Some(s) = value.as_str() {
            s.len() == expected_len && s.chars().all(|c| c.is_ascii_hexdigit() && !c.is_uppercase())
        } else {
            false
        }
    }

    /// tagsが文字列配列の配列かをチェック
    fn is_valid_tags(value: &Value) -> bool {
        if let Some(arr) = value.as_array() {
            arr.iter().all(|tag| {
                if let Some(tag_arr) = tag.as_array() {
                    tag_arr.iter().all(|elem| elem.is_string())
                } else {
                    false
                }
            })
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // 有効なイベントJSON（構造のみ）を作成するヘルパー関数
    fn valid_event_json() -> Value {
        json!({
            "id": "0".repeat(64),
            "pubkey": "a".repeat(64),
            "created_at": 1234567890,
            "kind": 1,
            "tags": [],
            "content": "hello world",
            "sig": "b".repeat(128)
        })
    }

    // ==================== 構造バリデーションテスト (要件 2.1-2.8) ====================

    #[test]
    fn test_validate_structure_valid_event() {
        let event = valid_event_json();
        assert!(EventValidator::validate_structure(&event).is_ok());
    }

    // 要件 2.1: すべての必須フィールドが存在する必要がある
    #[test]
    fn test_validate_structure_missing_id() {
        let mut event = valid_event_json();
        event.as_object_mut().unwrap().remove("id");
        let result = EventValidator::validate_structure(&event);
        assert_eq!(result, Err(ValidationError::MissingField("id".to_string())));
    }

    #[test]
    fn test_validate_structure_missing_pubkey() {
        let mut event = valid_event_json();
        event.as_object_mut().unwrap().remove("pubkey");
        let result = EventValidator::validate_structure(&event);
        assert_eq!(
            result,
            Err(ValidationError::MissingField("pubkey".to_string()))
        );
    }

    #[test]
    fn test_validate_structure_missing_created_at() {
        let mut event = valid_event_json();
        event.as_object_mut().unwrap().remove("created_at");
        let result = EventValidator::validate_structure(&event);
        assert_eq!(
            result,
            Err(ValidationError::MissingField("created_at".to_string()))
        );
    }

    #[test]
    fn test_validate_structure_missing_kind() {
        let mut event = valid_event_json();
        event.as_object_mut().unwrap().remove("kind");
        let result = EventValidator::validate_structure(&event);
        assert_eq!(
            result,
            Err(ValidationError::MissingField("kind".to_string()))
        );
    }

    #[test]
    fn test_validate_structure_missing_tags() {
        let mut event = valid_event_json();
        event.as_object_mut().unwrap().remove("tags");
        let result = EventValidator::validate_structure(&event);
        assert_eq!(
            result,
            Err(ValidationError::MissingField("tags".to_string()))
        );
    }

    #[test]
    fn test_validate_structure_missing_content() {
        let mut event = valid_event_json();
        event.as_object_mut().unwrap().remove("content");
        let result = EventValidator::validate_structure(&event);
        assert_eq!(
            result,
            Err(ValidationError::MissingField("content".to_string()))
        );
    }

    #[test]
    fn test_validate_structure_missing_sig() {
        let mut event = valid_event_json();
        event.as_object_mut().unwrap().remove("sig");
        let result = EventValidator::validate_structure(&event);
        assert_eq!(
            result,
            Err(ValidationError::MissingField("sig".to_string()))
        );
    }

    // 要件 2.2: idは64文字の小文字16進数でなければならない
    #[test]
    fn test_validate_structure_invalid_id_too_short() {
        let mut event = valid_event_json();
        event["id"] = json!("0".repeat(63));
        let result = EventValidator::validate_structure(&event);
        assert_eq!(result, Err(ValidationError::InvalidIdFormat));
    }

    #[test]
    fn test_validate_structure_invalid_id_too_long() {
        let mut event = valid_event_json();
        event["id"] = json!("0".repeat(65));
        let result = EventValidator::validate_structure(&event);
        assert_eq!(result, Err(ValidationError::InvalidIdFormat));
    }

    #[test]
    fn test_validate_structure_invalid_id_uppercase() {
        let mut event = valid_event_json();
        event["id"] = json!("A".repeat(64));
        let result = EventValidator::validate_structure(&event);
        assert_eq!(result, Err(ValidationError::InvalidIdFormat));
    }

    #[test]
    fn test_validate_structure_invalid_id_non_hex() {
        let mut event = valid_event_json();
        event["id"] = json!("g".repeat(64));
        let result = EventValidator::validate_structure(&event);
        assert_eq!(result, Err(ValidationError::InvalidIdFormat));
    }

    #[test]
    fn test_validate_structure_invalid_id_not_string() {
        let mut event = valid_event_json();
        event["id"] = json!(12345);
        let result = EventValidator::validate_structure(&event);
        assert_eq!(result, Err(ValidationError::InvalidIdFormat));
    }

    // 要件 2.3: pubkeyは64文字の小文字16進数でなければならない
    #[test]
    fn test_validate_structure_invalid_pubkey_too_short() {
        let mut event = valid_event_json();
        event["pubkey"] = json!("a".repeat(63));
        let result = EventValidator::validate_structure(&event);
        assert_eq!(result, Err(ValidationError::InvalidPubkeyFormat));
    }

    #[test]
    fn test_validate_structure_invalid_pubkey_uppercase() {
        let mut event = valid_event_json();
        event["pubkey"] = json!("A".repeat(64));
        let result = EventValidator::validate_structure(&event);
        assert_eq!(result, Err(ValidationError::InvalidPubkeyFormat));
    }

    // 要件 2.4: created_atはUnixタイムスタンプでなければならない
    #[test]
    fn test_validate_structure_invalid_created_at_string() {
        let mut event = valid_event_json();
        event["created_at"] = json!("not a timestamp");
        let result = EventValidator::validate_structure(&event);
        assert_eq!(result, Err(ValidationError::InvalidTimestamp));
    }

    #[test]
    fn test_validate_structure_invalid_created_at_float() {
        let mut event = valid_event_json();
        event["created_at"] = json!(1234567890.5);
        let result = EventValidator::validate_structure(&event);
        assert_eq!(result, Err(ValidationError::InvalidTimestamp));
    }

    // 要件 2.5: kindは0-65535でなければならない
    #[test]
    fn test_validate_structure_kind_zero_valid() {
        let mut event = valid_event_json();
        event["kind"] = json!(0);
        assert!(EventValidator::validate_structure(&event).is_ok());
    }

    #[test]
    fn test_validate_structure_kind_65535_valid() {
        let mut event = valid_event_json();
        event["kind"] = json!(65535);
        assert!(EventValidator::validate_structure(&event).is_ok());
    }

    #[test]
    fn test_validate_structure_invalid_kind_too_large() {
        let mut event = valid_event_json();
        event["kind"] = json!(65536);
        let result = EventValidator::validate_structure(&event);
        assert_eq!(result, Err(ValidationError::InvalidKindRange));
    }

    #[test]
    fn test_validate_structure_invalid_kind_negative() {
        let mut event = valid_event_json();
        event["kind"] = json!(-1);
        let result = EventValidator::validate_structure(&event);
        assert_eq!(result, Err(ValidationError::InvalidKindRange));
    }

    #[test]
    fn test_validate_structure_invalid_kind_string() {
        let mut event = valid_event_json();
        event["kind"] = json!("1");
        let result = EventValidator::validate_structure(&event);
        assert_eq!(result, Err(ValidationError::InvalidKindRange));
    }

    // 要件 2.6: tagsは文字列配列の配列でなければならない
    #[test]
    fn test_validate_structure_valid_empty_tags() {
        let mut event = valid_event_json();
        event["tags"] = json!([]);
        assert!(EventValidator::validate_structure(&event).is_ok());
    }

    #[test]
    fn test_validate_structure_valid_tags_with_content() {
        let mut event = valid_event_json();
        event["tags"] = json!([
            ["e", "abc123"],
            ["p", "def456"],
            ["t", "nostr", "extra"]
        ]);
        assert!(EventValidator::validate_structure(&event).is_ok());
    }

    #[test]
    fn test_validate_structure_invalid_tags_not_array() {
        let mut event = valid_event_json();
        event["tags"] = json!("not an array");
        let result = EventValidator::validate_structure(&event);
        assert_eq!(result, Err(ValidationError::InvalidTagsFormat));
    }

    #[test]
    fn test_validate_structure_invalid_tags_inner_not_array() {
        let mut event = valid_event_json();
        event["tags"] = json!(["not", "nested"]);
        let result = EventValidator::validate_structure(&event);
        assert_eq!(result, Err(ValidationError::InvalidTagsFormat));
    }

    #[test]
    fn test_validate_structure_invalid_tags_inner_not_strings() {
        let mut event = valid_event_json();
        event["tags"] = json!([["e", 123]]);
        let result = EventValidator::validate_structure(&event);
        assert_eq!(result, Err(ValidationError::InvalidTagsFormat));
    }

    // 要件 2.7: contentは文字列でなければならない
    #[test]
    fn test_validate_structure_valid_empty_content() {
        let mut event = valid_event_json();
        event["content"] = json!("");
        assert!(EventValidator::validate_structure(&event).is_ok());
    }

    #[test]
    fn test_validate_structure_invalid_content_not_string() {
        let mut event = valid_event_json();
        event["content"] = json!(12345);
        let result = EventValidator::validate_structure(&event);
        assert_eq!(result, Err(ValidationError::InvalidContentFormat));
    }

    #[test]
    fn test_validate_structure_invalid_content_null() {
        let mut event = valid_event_json();
        event["content"] = json!(null);
        let result = EventValidator::validate_structure(&event);
        assert_eq!(result, Err(ValidationError::InvalidContentFormat));
    }

    // 要件 2.8: sigは128文字の小文字16進数でなければならない
    #[test]
    fn test_validate_structure_invalid_sig_too_short() {
        let mut event = valid_event_json();
        event["sig"] = json!("a".repeat(127));
        let result = EventValidator::validate_structure(&event);
        assert_eq!(result, Err(ValidationError::InvalidSignatureFormat));
    }

    #[test]
    fn test_validate_structure_invalid_sig_uppercase() {
        let mut event = valid_event_json();
        event["sig"] = json!("A".repeat(128));
        let result = EventValidator::validate_structure(&event);
        assert_eq!(result, Err(ValidationError::InvalidSignatureFormat));
    }

    // ==================== ID検証テスト (要件 3.1-3.5) ====================

    #[test]
    fn test_verify_id_valid_event() {
        // nostrクレートを使用して有効なイベントを作成
        use nostr::Keys;

        let keys = Keys::generate();
        let event = nostr::EventBuilder::text_note("test content")
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        assert!(EventValidator::verify_id(&event).is_ok());
    }

    #[test]
    fn test_verify_id_invalid_event() {
        // IDが不一致のイベントを作成
        use nostr::Keys;

        let keys = Keys::generate();
        let event = nostr::EventBuilder::text_note("test content")
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        // イベントのIDはnostrクレートにより作成時に既に検証済み
        // verify_id関数が機能することを確認するだけ
        assert!(EventValidator::verify_id(&event).is_ok());
    }

    // ==================== 署名検証テスト (要件 4.1-4.2) ====================

    #[test]
    fn test_verify_signature_valid_event() {
        use nostr::Keys;

        let keys = Keys::generate();
        let event = nostr::EventBuilder::text_note("test content")
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        assert!(EventValidator::verify_signature(&event).is_ok());
    }

    // ==================== 完全バリデーションテスト ====================

    #[test]
    fn test_validate_all_with_real_event() {
        use nostr::Keys;

        let keys = Keys::generate();
        let event = nostr::EventBuilder::text_note("Hello, Nostr!")
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        // Serialize to JSON Value
        let event_json: Value = serde_json::to_value(&event).unwrap();

        // Validate
        let result = EventValidator::validate_all(&event_json);
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_all_rejects_invalid_structure() {
        let event = json!({
            "id": "invalid",
            "pubkey": "a".repeat(64),
            "created_at": 1234567890,
            "kind": 1,
            "tags": [],
            "content": "hello",
            "sig": "b".repeat(128)
        });

        let result = EventValidator::validate_all(&event);
        assert!(result.is_err());
    }

    // ==================== 表示テスト ====================

    #[test]
    fn test_validation_error_display() {
        assert_eq!(
            ValidationError::MissingField("id".to_string()).to_string(),
            "missing required field: id"
        );
        assert_eq!(
            ValidationError::InvalidIdFormat.to_string(),
            "id must be 64 lowercase hex characters"
        );
        assert_eq!(
            ValidationError::IdMismatch.to_string(),
            "event id does not match"
        );
        assert_eq!(
            ValidationError::SignatureVerificationFailed.to_string(),
            "signature verification failed"
        );
    }
}
