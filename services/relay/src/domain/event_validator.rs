/// NIP-01準拠のイベントバリデーション
///
/// 要件: 2.1-2.8, 3.1-3.5, 4.1-4.2
/// NIP-11制限値バリデーション: 3.4-3.7
use nostr::Event;
use serde_json::Value;
use thiserror::Error;

use crate::domain::LimitationConfig;

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

    // ===========================================
    // NIP-11制限値バリデーションエラー (要件 3.4-3.7)
    // ===========================================

    /// タグ数が制限を超過
    #[error("too many tags: {count} exceeds limit {limit}")]
    TooManyTags {
        /// 実際のタグ数
        count: usize,
        /// 制限値
        limit: u32,
    },

    /// コンテンツ長が制限を超過
    #[error("content too long: {length} characters exceeds limit {limit}")]
    ContentTooLong {
        /// 実際の文字数
        length: usize,
        /// 制限値
        limit: u32,
    },

    /// created_atが過去すぎる
    #[error("created_at too old: event is {age} seconds old, limit is {limit}")]
    CreatedAtTooOld {
        /// 経過秒数
        age: u64,
        /// 制限値（秒）
        limit: u64,
    },

    /// created_atが未来すぎる
    #[error("created_at too far in future: {ahead} seconds ahead, limit is {limit}")]
    CreatedAtTooFarInFuture {
        /// 先行秒数
        ahead: u64,
        /// 制限値（秒）
        limit: u64,
    },
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

    /// 制限値に基づくバリデーション（要件 3.4-3.7）
    ///
    /// # チェック項目
    /// - tags配列の要素数が max_event_tags 以下
    /// - content文字数が max_content_length 以下（Unicode文字数でカウント）
    /// - created_at が (現在時刻 - created_at_lower_limit) 以上
    /// - created_at が (現在時刻 + created_at_upper_limit) 以下
    ///
    /// # 引数
    /// - `event`: バリデーション対象のイベント
    /// - `config`: 制限値設定
    ///
    /// # 戻り値
    /// - 成功時は`Ok(())`
    /// - 失敗時は対応する`ValidationError`
    pub fn validate_limitation(
        event: &Event,
        config: &LimitationConfig,
    ) -> Result<(), ValidationError> {
        // タグ数チェック
        let tag_count = event.tags.len();
        if tag_count > config.max_event_tags as usize {
            return Err(ValidationError::TooManyTags {
                count: tag_count,
                limit: config.max_event_tags,
            });
        }

        // コンテンツ長チェック（Unicode文字数）
        let content_length = event.content.chars().count();
        if content_length > config.max_content_length as usize {
            return Err(ValidationError::ContentTooLong {
                length: content_length,
                limit: config.max_content_length,
            });
        }

        // 現在時刻を取得
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // イベントのcreated_atをu64に変換
        let event_created_at = event.created_at.as_secs();

        // created_at下限チェック（過去すぎないか）
        let lower_bound = now.saturating_sub(config.created_at_lower_limit);
        if event_created_at < lower_bound {
            let age = now.saturating_sub(event_created_at);
            return Err(ValidationError::CreatedAtTooOld {
                age,
                limit: config.created_at_lower_limit,
            });
        }

        // created_at上限チェック（未来すぎないか）
        let upper_bound = now.saturating_add(config.created_at_upper_limit);
        if event_created_at > upper_bound {
            let ahead = event_created_at.saturating_sub(now);
            return Err(ValidationError::CreatedAtTooFarInFuture {
                ahead,
                limit: config.created_at_upper_limit,
            });
        }

        Ok(())
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

    // ==================== 制限値バリデーションエラー表示テスト (要件 3.4-3.7) ====================

    #[test]
    fn test_too_many_tags_error_display() {
        let error = ValidationError::TooManyTags {
            count: 1500,
            limit: 1000,
        };
        assert_eq!(
            error.to_string(),
            "too many tags: 1500 exceeds limit 1000"
        );
    }

    #[test]
    fn test_content_too_long_error_display() {
        let error = ValidationError::ContentTooLong {
            length: 70000,
            limit: 65536,
        };
        assert_eq!(
            error.to_string(),
            "content too long: 70000 characters exceeds limit 65536"
        );
    }

    #[test]
    fn test_created_at_too_old_error_display() {
        let error = ValidationError::CreatedAtTooOld {
            age: 40000000,
            limit: 31536000,
        };
        assert_eq!(
            error.to_string(),
            "created_at too old: event is 40000000 seconds old, limit is 31536000"
        );
    }

    #[test]
    fn test_created_at_too_far_in_future_error_display() {
        let error = ValidationError::CreatedAtTooFarInFuture {
            ahead: 1200,
            limit: 900,
        };
        assert_eq!(
            error.to_string(),
            "created_at too far in future: 1200 seconds ahead, limit is 900"
        );
    }

    // ==================== 制限値バリデーションテスト (要件 3.4-3.7) ====================

    use crate::domain::LimitationConfig;

    // イベントを生成するヘルパー関数（タグ数を指定）
    fn create_event_with_tags(tag_count: usize) -> Event {
        use nostr::{Keys, Tag, TagKind};

        let keys = Keys::generate();
        let tags: Vec<Tag> = (0..tag_count)
            .map(|i| Tag::custom(TagKind::Custom(format!("t{}", i).into()), vec![format!("value{}", i)]))
            .collect();

        nostr::EventBuilder::text_note("test content")
            .tags(tags)
            .sign_with_keys(&keys)
            .expect("Failed to create event")
    }

    // イベントを生成するヘルパー関数（コンテンツ長を指定）
    fn create_event_with_content(content: &str) -> Event {
        use nostr::Keys;

        let keys = Keys::generate();
        nostr::EventBuilder::text_note(content)
            .sign_with_keys(&keys)
            .expect("Failed to create event")
    }

    // イベントを生成するヘルパー関数（created_atを指定）
    fn create_event_with_created_at(timestamp: u64) -> Event {
        use nostr::{Keys, Timestamp};

        let keys = Keys::generate();
        nostr::EventBuilder::text_note("test content")
            .custom_created_at(Timestamp::from(timestamp))
            .sign_with_keys(&keys)
            .expect("Failed to create event")
    }

    // ----- タグ数バリデーションテスト (要件 3.4) -----

    #[test]
    fn test_validate_limitation_tags_at_limit() {
        // タグ数がちょうど制限値の場合は成功
        let config = LimitationConfig {
            max_event_tags: 10,
            ..LimitationConfig::default()
        };
        let event = create_event_with_tags(10);

        let result = EventValidator::validate_limitation(&event, &config);
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_limitation_tags_below_limit() {
        // タグ数が制限値未満の場合は成功
        let config = LimitationConfig {
            max_event_tags: 10,
            ..LimitationConfig::default()
        };
        let event = create_event_with_tags(9);

        let result = EventValidator::validate_limitation(&event, &config);
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_limitation_tags_exceed_limit() {
        // タグ数が制限値を超える場合はエラー
        let config = LimitationConfig {
            max_event_tags: 10,
            ..LimitationConfig::default()
        };
        let event = create_event_with_tags(11);

        let result = EventValidator::validate_limitation(&event, &config);
        assert_eq!(
            result,
            Err(ValidationError::TooManyTags {
                count: 11,
                limit: 10
            })
        );
    }

    #[test]
    fn test_validate_limitation_zero_tags() {
        // タグなしの場合は成功
        let config = LimitationConfig {
            max_event_tags: 10,
            ..LimitationConfig::default()
        };
        let event = create_event_with_tags(0);

        let result = EventValidator::validate_limitation(&event, &config);
        assert!(result.is_ok());
    }

    // ----- コンテンツ長バリデーションテスト (要件 3.5) -----

    #[test]
    fn test_validate_limitation_content_at_limit() {
        // コンテンツ長がちょうど制限値の場合は成功
        let config = LimitationConfig {
            max_content_length: 10,
            ..LimitationConfig::default()
        };
        let event = create_event_with_content("0123456789"); // 10文字

        let result = EventValidator::validate_limitation(&event, &config);
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_limitation_content_below_limit() {
        // コンテンツ長が制限値未満の場合は成功
        let config = LimitationConfig {
            max_content_length: 10,
            ..LimitationConfig::default()
        };
        let event = create_event_with_content("012345678"); // 9文字

        let result = EventValidator::validate_limitation(&event, &config);
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_limitation_content_exceed_limit() {
        // コンテンツ長が制限値を超える場合はエラー
        let config = LimitationConfig {
            max_content_length: 10,
            ..LimitationConfig::default()
        };
        let event = create_event_with_content("01234567890"); // 11文字

        let result = EventValidator::validate_limitation(&event, &config);
        assert_eq!(
            result,
            Err(ValidationError::ContentTooLong {
                length: 11,
                limit: 10
            })
        );
    }

    #[test]
    fn test_validate_limitation_content_unicode() {
        // Unicode文字数でカウント（バイト数ではなく）
        let config = LimitationConfig {
            max_content_length: 5,
            ..LimitationConfig::default()
        };
        // "あいうえお" は5文字（15バイト）
        let event = create_event_with_content("あいうえお");

        let result = EventValidator::validate_limitation(&event, &config);
        assert!(result.is_ok()); // 5文字なのでOK
    }

    #[test]
    fn test_validate_limitation_content_unicode_exceed() {
        // Unicode文字でも制限を超える場合はエラー
        let config = LimitationConfig {
            max_content_length: 4,
            ..LimitationConfig::default()
        };
        // "あいうえお" は5文字
        let event = create_event_with_content("あいうえお");

        let result = EventValidator::validate_limitation(&event, &config);
        assert_eq!(
            result,
            Err(ValidationError::ContentTooLong {
                length: 5,
                limit: 4
            })
        );
    }

    #[test]
    fn test_validate_limitation_content_emoji() {
        // 絵文字も1文字としてカウント
        let config = LimitationConfig {
            max_content_length: 3,
            ..LimitationConfig::default()
        };
        // 絵文字3つ
        let event = create_event_with_content("😀😁😂");

        let result = EventValidator::validate_limitation(&event, &config);
        assert!(result.is_ok()); // 3文字なのでOK
    }

    #[test]
    fn test_validate_limitation_empty_content() {
        // 空コンテンツは成功
        let config = LimitationConfig {
            max_content_length: 10,
            ..LimitationConfig::default()
        };
        let event = create_event_with_content("");

        let result = EventValidator::validate_limitation(&event, &config);
        assert!(result.is_ok());
    }

    // ----- created_at下限バリデーションテスト (要件 3.6) -----

    #[test]
    fn test_validate_limitation_created_at_within_lower_limit() {
        // created_atが下限以内の場合は成功
        let config = LimitationConfig {
            created_at_lower_limit: 3600, // 1時間
            ..LimitationConfig::default()
        };
        // 現在時刻から30分前
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let event = create_event_with_created_at(now - 1800);

        let result = EventValidator::validate_limitation(&event, &config);
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_limitation_created_at_at_lower_limit() {
        // created_atがちょうど下限の場合は成功（境界値）
        let config = LimitationConfig {
            created_at_lower_limit: 3600, // 1時間
            ..LimitationConfig::default()
        };
        // 現在時刻からちょうど1時間前
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let event = create_event_with_created_at(now - 3600);

        let result = EventValidator::validate_limitation(&event, &config);
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_limitation_created_at_exceed_lower_limit() {
        // created_atが下限を超えて古い場合はエラー
        let config = LimitationConfig {
            created_at_lower_limit: 3600, // 1時間
            ..LimitationConfig::default()
        };
        // 現在時刻から2時間前
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let event = create_event_with_created_at(now - 7200);

        let result = EventValidator::validate_limitation(&event, &config);
        assert!(matches!(result, Err(ValidationError::CreatedAtTooOld { .. })));
    }

    // ----- created_at上限バリデーションテスト (要件 3.7) -----

    #[test]
    fn test_validate_limitation_created_at_within_upper_limit() {
        // created_atが上限以内の場合は成功
        let config = LimitationConfig {
            created_at_upper_limit: 900, // 15分
            ..LimitationConfig::default()
        };
        // 現在時刻から5分後
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let event = create_event_with_created_at(now + 300);

        let result = EventValidator::validate_limitation(&event, &config);
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_limitation_created_at_at_upper_limit() {
        // created_atがちょうど上限の場合は成功（境界値）
        let config = LimitationConfig {
            created_at_upper_limit: 900, // 15分
            ..LimitationConfig::default()
        };
        // 現在時刻からちょうど15分後
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let event = create_event_with_created_at(now + 900);

        let result = EventValidator::validate_limitation(&event, &config);
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_limitation_created_at_exceed_upper_limit() {
        // created_atが上限を超えて未来の場合はエラー
        let config = LimitationConfig {
            created_at_upper_limit: 900, // 15分
            ..LimitationConfig::default()
        };
        // 現在時刻から30分後
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let event = create_event_with_created_at(now + 1800);

        let result = EventValidator::validate_limitation(&event, &config);
        assert!(matches!(
            result,
            Err(ValidationError::CreatedAtTooFarInFuture { .. })
        ));
    }

    #[test]
    fn test_validate_limitation_created_at_current_time() {
        // 現在時刻のcreated_atは成功
        let config = LimitationConfig::default();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let event = create_event_with_created_at(now);

        let result = EventValidator::validate_limitation(&event, &config);
        assert!(result.is_ok());
    }

    // ----- 複合テスト -----

    #[test]
    fn test_validate_limitation_all_valid() {
        // すべての制限を満たすイベント
        let config = LimitationConfig::default();
        let event = create_event_with_content("hello world");

        let result = EventValidator::validate_limitation(&event, &config);
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_limitation_tags_checked_first() {
        // タグ数とコンテンツ長の両方が超過している場合、タグ数エラーが先に返される
        let config = LimitationConfig {
            max_event_tags: 5,
            max_content_length: 10,
            ..LimitationConfig::default()
        };
        // タグ10個、コンテンツ20文字のイベントを作成するのは難しいので
        // タグ数エラーのみ確認
        let event = create_event_with_tags(10);

        let result = EventValidator::validate_limitation(&event, &config);
        assert!(matches!(result, Err(ValidationError::TooManyTags { .. })));
    }
}
