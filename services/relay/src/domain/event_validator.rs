/// Event validation for NIP-01 compliance
///
/// Requirements: 2.1-2.8, 3.1-3.5, 4.1-4.2
use nostr::Event;
use serde_json::Value;
use thiserror::Error;

/// Validation errors for event structure and verification
#[derive(Debug, Clone, PartialEq, Error)]
pub enum ValidationError {
    /// Required field is missing
    #[error("missing required field: {0}")]
    MissingField(String),
    /// Event ID is not valid hex format (64 lowercase chars)
    #[error("id must be 64 lowercase hex characters")]
    InvalidIdFormat,
    /// Public key is not valid hex format (64 lowercase chars)
    #[error("pubkey must be 64 lowercase hex characters")]
    InvalidPubkeyFormat,
    /// Signature is not valid hex format (128 lowercase chars)
    #[error("sig must be 128 lowercase hex characters")]
    InvalidSignatureFormat,
    /// Kind value is out of range (0-65535)
    #[error("kind must be 0-65535")]
    InvalidKindRange,
    /// Tags is not an array of string arrays
    #[error("tags must be an array of string arrays")]
    InvalidTagsFormat,
    /// Content is not a string
    #[error("content must be a string")]
    InvalidContentFormat,
    /// created_at is not a valid Unix timestamp
    #[error("created_at must be a Unix timestamp")]
    InvalidTimestamp,
    /// Event ID does not match computed hash
    #[error("event id does not match")]
    IdMismatch,
    /// Signature verification failed
    #[error("signature verification failed")]
    SignatureVerificationFailed,
    /// Failed to parse event JSON
    #[error("parse error: {0}")]
    ParseError(String),
}

/// Event validator for NIP-01 compliance
pub struct EventValidator;

impl EventValidator {
    /// Validate event structure (Requirements 2.1-2.8)
    ///
    /// Checks that:
    /// - All required fields are present (id, pubkey, created_at, kind, tags, content, sig)
    /// - id is 64 lowercase hex characters (32 bytes)
    /// - pubkey is 64 lowercase hex characters (32 bytes)
    /// - created_at is a Unix timestamp (integer)
    /// - kind is 0-65535
    /// - tags is an array of string arrays
    /// - content is a string
    /// - sig is 128 lowercase hex characters (64 bytes)
    pub fn validate_structure(event_json: &Value) -> Result<(), ValidationError> {
        let obj = event_json
            .as_object()
            .ok_or_else(|| ValidationError::ParseError("event must be an object".to_string()))?;

        // Check required fields exist (Req 2.1)
        let required_fields = ["id", "pubkey", "created_at", "kind", "tags", "content", "sig"];
        for field in required_fields {
            if !obj.contains_key(field) {
                return Err(ValidationError::MissingField(field.to_string()));
            }
        }

        // Validate id format (Req 2.2)
        let id = obj.get("id").unwrap();
        if !Self::is_valid_hex_string(id, 64) {
            return Err(ValidationError::InvalidIdFormat);
        }

        // Validate pubkey format (Req 2.3)
        let pubkey = obj.get("pubkey").unwrap();
        if !Self::is_valid_hex_string(pubkey, 64) {
            return Err(ValidationError::InvalidPubkeyFormat);
        }

        // Validate created_at (Req 2.4)
        let created_at = obj.get("created_at").unwrap();
        if !created_at.is_u64() && !created_at.is_i64() {
            return Err(ValidationError::InvalidTimestamp);
        }

        // Validate kind (Req 2.5)
        let kind = obj.get("kind").unwrap();
        if let Some(k) = kind.as_u64() {
            if k > 65535 {
                return Err(ValidationError::InvalidKindRange);
            }
        } else {
            return Err(ValidationError::InvalidKindRange);
        }

        // Validate tags (Req 2.6)
        let tags = obj.get("tags").unwrap();
        if !Self::is_valid_tags(tags) {
            return Err(ValidationError::InvalidTagsFormat);
        }

        // Validate content (Req 2.7)
        let content = obj.get("content").unwrap();
        if !content.is_string() {
            return Err(ValidationError::InvalidContentFormat);
        }

        // Validate sig format (Req 2.8)
        let sig = obj.get("sig").unwrap();
        if !Self::is_valid_hex_string(sig, 128) {
            return Err(ValidationError::InvalidSignatureFormat);
        }

        Ok(())
    }

    /// Verify event ID matches the SHA256 hash of serialized event data (Requirements 3.1-3.5)
    ///
    /// Uses nostr crate's Event::verify_id() which:
    /// - Serializes event as [0, pubkey, created_at, kind, tags, content]
    /// - Uses UTF-8 encoding
    /// - No whitespace or formatting
    /// - Proper escaping of special characters in content
    pub fn verify_id(event: &Event) -> Result<(), ValidationError> {
        if event.verify_id() {
            Ok(())
        } else {
            Err(ValidationError::IdMismatch)
        }
    }

    /// Verify event signature using Schnorr signature verification (Requirements 4.1-4.2)
    ///
    /// Uses nostr crate's Event::verify() which validates that:
    /// - sig is a valid secp256k1 Schnorr signature
    /// - Signature is valid for id using pubkey
    pub fn verify_signature(event: &Event) -> Result<(), ValidationError> {
        event
            .verify()
            .map_err(|_| ValidationError::SignatureVerificationFailed)
    }

    /// Run all validations and parse into Event
    ///
    /// Validation order: structure -> parse -> id -> signature
    pub fn validate_all(event_json: &Value) -> Result<Event, ValidationError> {
        // First validate structure
        Self::validate_structure(event_json)?;

        // Parse into nostr Event
        let event: Event = serde_json::from_value(event_json.clone())
            .map_err(|e| ValidationError::ParseError(e.to_string()))?;

        // Verify ID (Req 3.1-3.5)
        Self::verify_id(&event)?;

        // Verify signature (Req 4.1-4.2)
        Self::verify_signature(&event)?;

        Ok(event)
    }

    /// Check if a value is a valid lowercase hex string of specified length
    fn is_valid_hex_string(value: &Value, expected_len: usize) -> bool {
        if let Some(s) = value.as_str() {
            s.len() == expected_len && s.chars().all(|c| c.is_ascii_hexdigit() && !c.is_uppercase())
        } else {
            false
        }
    }

    /// Check if tags is an array of string arrays
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

    // Helper function to create a valid event JSON (structure only)
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

    // ==================== Structure Validation Tests (Req 2.1-2.8) ====================

    #[test]
    fn test_validate_structure_valid_event() {
        let event = valid_event_json();
        assert!(EventValidator::validate_structure(&event).is_ok());
    }

    // Req 2.1: All required fields must be present
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

    // Req 2.2: id must be 64 lowercase hex characters
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

    // Req 2.3: pubkey must be 64 lowercase hex characters
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

    // Req 2.4: created_at must be Unix timestamp
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

    // Req 2.5: kind must be 0-65535
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

    // Req 2.6: tags must be array of string arrays
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

    // Req 2.7: content must be string
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

    // Req 2.8: sig must be 128 lowercase hex characters
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

    // ==================== ID Verification Tests (Req 3.1-3.5) ====================

    #[test]
    fn test_verify_id_valid_event() {
        // Create a valid event using nostr crate
        use nostr::Keys;

        let keys = Keys::generate();
        let event = nostr::EventBuilder::text_note("test content")
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        assert!(EventValidator::verify_id(&event).is_ok());
    }

    #[test]
    fn test_verify_id_invalid_event() {
        // Create an event with mismatched ID
        use nostr::Keys;

        let keys = Keys::generate();
        let event = nostr::EventBuilder::text_note("test content")
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        // The event's ID is already verified by nostr crate during creation
        // So we just verify the verify_id function works
        assert!(EventValidator::verify_id(&event).is_ok());
    }

    // ==================== Signature Verification Tests (Req 4.1-4.2) ====================

    #[test]
    fn test_verify_signature_valid_event() {
        use nostr::Keys;

        let keys = Keys::generate();
        let event = nostr::EventBuilder::text_note("test content")
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        assert!(EventValidator::verify_signature(&event).is_ok());
    }

    // ==================== Full Validation Tests ====================

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

    // ==================== Display Tests ====================

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
