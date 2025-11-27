/// NIP-01準拠のフィルター評価
///
/// 要件: 8.1-8.11
use nostr::filter::MatchEventOptions;
use nostr::{Event, Filter};
use thiserror::Error;

/// フィルターバリデーションエラー
#[derive(Debug, Clone, PartialEq, Error)]
pub enum FilterValidationError {
    /// ID値が有効な16進数形式でない
    #[error("invalid id format: {0}")]
    InvalidIdFormat(String),
    /// author値が有効な16進数形式でない
    #[error("invalid author format: {0}")]
    InvalidAuthorFormat(String),
    /// #eまたは#pのタグ値が有効な形式でない
    #[error("invalid #{tag} tag value format: {value}")]
    InvalidTagValueFormat { tag: String, value: String },
}

/// NIP-01フィルターに対してイベントをマッチングするためのフィルター評価器
pub struct FilterEvaluator;

impl FilterEvaluator {
    /// イベントが単一のフィルターにマッチするかチェック（要件 8.1-8.8）
    ///
    /// フィルター条件はANDで結合:
    /// - ids: イベントIDプレフィックスがリスト内のいずれかにマッチ (8.1)
    /// - authors: イベントpubkeyプレフィックスがリスト内のいずれかにマッチ (8.2)
    /// - kinds: イベントkindがリスト内のいずれかにマッチ (8.3)
    /// - #<letter>: タグ値がリスト内のいずれかにマッチ (8.4)
    /// - since: created_at >= since (8.5)
    /// - until: created_at <= until (8.6)
    pub fn matches(event: &Event, filter: &Filter) -> bool {
        filter.match_event(event, MatchEventOptions::default())
    }

    /// イベントが複数のフィルターのいずれかにマッチするかチェック（要件 8.9）
    ///
    /// 複数のフィルターはORで結合
    pub fn matches_any(event: &Event, filters: &[Filter]) -> bool {
        if filters.is_empty() {
            // 空のフィルターリストはすべてのイベントにマッチ
            return true;
        }

        filters.iter().any(|filter| Self::matches(event, filter))
    }

    /// フィルター値のバリデーション（要件 8.11）
    ///
    /// バリデーション内容:
    /// - ids値が64文字の小文字16進数文字列
    /// - authors値が64文字の小文字16進数文字列
    /// - #eタグ値が64文字の小文字16進数文字列
    /// - #pタグ値が64文字の小文字16進数文字列
    pub fn validate_filter(filter: &Filter) -> Result<(), FilterValidationError> {
        // idsのバリデーション（完全な64文字16進数またはプレフィックス）
        if let Some(ids) = filter.ids.as_ref() {
            for id in ids.iter() {
                let id_str = id.to_hex();
                if !Self::is_valid_hex(&id_str) {
                    return Err(FilterValidationError::InvalidIdFormat(id_str));
                }
            }
        }

        // authorsのバリデーション（完全な64文字16進数またはプレフィックス）
        if let Some(authors) = filter.authors.as_ref() {
            for author in authors.iter() {
                let author_str = author.to_hex();
                if !Self::is_valid_hex(&author_str) {
                    return Err(FilterValidationError::InvalidAuthorFormat(author_str));
                }
            }
        }

        // #eタグ値のバリデーション
        if let Some(event_ids) = filter.generic_tags.get(&nostr::SingleLetterTag::lowercase(nostr::Alphabet::E)) {
            for event_id in event_ids.iter() {
                let id_str = event_id.to_string();
                if id_str.len() == 64 && !Self::is_valid_hex(&id_str) {
                    return Err(FilterValidationError::InvalidTagValueFormat {
                        tag: "e".to_string(),
                        value: id_str,
                    });
                }
            }
        }

        // #pタグ値のバリデーション
        if let Some(pubkeys) = filter.generic_tags.get(&nostr::SingleLetterTag::lowercase(nostr::Alphabet::P)) {
            for pubkey in pubkeys.iter() {
                let pk_str = pubkey.to_string();
                if pk_str.len() == 64 && !Self::is_valid_hex(&pk_str) {
                    return Err(FilterValidationError::InvalidTagValueFormat {
                        tag: "p".to_string(),
                        value: pk_str,
                    });
                }
            }
        }

        Ok(())
    }

    /// 文字列が有効な小文字16進数かチェック
    fn is_valid_hex(s: &str) -> bool {
        !s.is_empty() && s.chars().all(|c| c.is_ascii_hexdigit() && !c.is_uppercase())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Timestamp};

    // テストイベントを作成するヘルパー
    fn create_test_event(content: &str) -> Event {
        let keys = Keys::generate();
        EventBuilder::text_note(content)
            .sign_with_keys(&keys)
            .expect("Failed to create event")
    }

    fn create_test_event_with_kind(kind: u16) -> Event {
        let keys = Keys::generate();
        EventBuilder::new(Kind::from(kind), "test content")
            .sign_with_keys(&keys)
            .expect("Failed to create event")
    }

    fn create_test_event_with_tags(tags: Vec<nostr::Tag>) -> Event {
        let keys = Keys::generate();
        EventBuilder::new(Kind::TextNote, "test content")
            .tags(tags)
            .sign_with_keys(&keys)
            .expect("Failed to create event")
    }

    // ==================== 単一フィルターマッチングテスト (要件 8.1-8.6, 8.8) ====================

    // 要件 8.1: idsフィルター
    #[test]
    fn test_matches_ids_filter() {
        let event = create_test_event("hello");
        let event_id = event.id;

        // マッチするidを持つフィルター
        let filter = Filter::new().id(event_id);
        assert!(FilterEvaluator::matches(&event, &filter));

        // マッチしないidを持つフィルター
        let other_event = create_test_event("other");
        let filter_other = Filter::new().id(other_event.id);
        assert!(!FilterEvaluator::matches(&event, &filter_other));
    }

    // 要件 8.2: authorsフィルター
    #[test]
    fn test_matches_authors_filter() {
        let keys = Keys::generate();
        let event = EventBuilder::text_note("hello")
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        // マッチするauthorを持つフィルター
        let filter = Filter::new().author(keys.public_key());
        assert!(FilterEvaluator::matches(&event, &filter));

        // マッチしないauthorを持つフィルター
        let other_keys = Keys::generate();
        let filter_other = Filter::new().author(other_keys.public_key());
        assert!(!FilterEvaluator::matches(&event, &filter_other));
    }

    // 要件 8.3: kindsフィルター
    #[test]
    fn test_matches_kinds_filter() {
        let event = create_test_event_with_kind(1);

        // マッチするkindを持つフィルター
        let filter = Filter::new().kind(Kind::TextNote);
        assert!(FilterEvaluator::matches(&event, &filter));

        // マッチしないkindを持つフィルター
        let filter_other = Filter::new().kind(Kind::Metadata);
        assert!(!FilterEvaluator::matches(&event, &filter_other));
    }

    #[test]
    fn test_matches_multiple_kinds() {
        let event = create_test_event_with_kind(1);

        let filter = Filter::new().kinds([Kind::TextNote, Kind::Metadata]);
        assert!(FilterEvaluator::matches(&event, &filter));
    }

    // 要件 8.4: #<letter>タグフィルター
    #[test]
    fn test_matches_e_tag_filter() {
        let event_id_hex = "a".repeat(64);
        let tag = nostr::Tag::parse(["e", &event_id_hex]).expect("Failed to parse tag");
        let event = create_test_event_with_tags(vec![tag]);

        let filter = Filter::new().custom_tag(
            nostr::SingleLetterTag::lowercase(nostr::Alphabet::E),
            event_id_hex.clone(),
        );
        assert!(FilterEvaluator::matches(&event, &filter));
    }

    #[test]
    fn test_matches_p_tag_filter() {
        let pubkey_hex = "b".repeat(64);
        let tag = nostr::Tag::parse(["p", &pubkey_hex]).expect("Failed to parse tag");
        let event = create_test_event_with_tags(vec![tag]);

        let filter = Filter::new().custom_tag(
            nostr::SingleLetterTag::lowercase(nostr::Alphabet::P),
            pubkey_hex.clone(),
        );
        assert!(FilterEvaluator::matches(&event, &filter));
    }

    // 要件 8.5: sinceフィルター
    #[test]
    fn test_matches_since_filter() {
        let event = create_test_event("hello");
        let event_time = event.created_at;

        // イベント時刻より前のsinceを持つフィルター
        let filter = Filter::new().since(Timestamp::from_secs(event_time.as_secs() - 100));
        assert!(FilterEvaluator::matches(&event, &filter));

        // イベント時刻より後のsinceを持つフィルター
        let filter_future = Filter::new().since(Timestamp::from_secs(event_time.as_secs() + 100));
        assert!(!FilterEvaluator::matches(&event, &filter_future));
    }

    #[test]
    fn test_matches_since_equal() {
        let event = create_test_event("hello");
        let event_time = event.created_at;

        // since <= created_at はマッチするべき
        let filter = Filter::new().since(event_time);
        assert!(FilterEvaluator::matches(&event, &filter));
    }

    // 要件 8.6: untilフィルター
    #[test]
    fn test_matches_until_filter() {
        let event = create_test_event("hello");
        let event_time = event.created_at;

        // イベント時刻より後のuntilを持つフィルター
        let filter = Filter::new().until(Timestamp::from_secs(event_time.as_secs() + 100));
        assert!(FilterEvaluator::matches(&event, &filter));

        // イベント時刻より前のuntilを持つフィルター
        let filter_past = Filter::new().until(Timestamp::from_secs(event_time.as_secs() - 100));
        assert!(!FilterEvaluator::matches(&event, &filter_past));
    }

    #[test]
    fn test_matches_until_equal() {
        let event = create_test_event("hello");
        let event_time = event.created_at;

        // created_at <= until はマッチするべき
        let filter = Filter::new().until(event_time);
        assert!(FilterEvaluator::matches(&event, &filter));
    }

    // 要件 8.8: 複数条件のAND
    #[test]
    fn test_matches_multiple_conditions_and() {
        let keys = Keys::generate();
        let event = EventBuilder::new(Kind::TextNote, "test")
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        // 複数条件を持つフィルター
        let filter = Filter::new()
            .author(keys.public_key())
            .kind(Kind::TextNote);

        assert!(FilterEvaluator::matches(&event, &filter));
    }

    #[test]
    fn test_matches_multiple_conditions_one_fails() {
        let keys = Keys::generate();
        let event = EventBuilder::new(Kind::TextNote, "test")
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        // authorはマッチするがkindはマッチしないフィルター
        let filter = Filter::new()
            .author(keys.public_key())
            .kind(Kind::Metadata); // 間違ったkind

        assert!(!FilterEvaluator::matches(&event, &filter));
    }

    // ==================== 複数フィルターORテスト (要件 8.9) ====================

    #[test]
    fn test_matches_any_empty_filters() {
        let event = create_test_event("hello");
        let filters: Vec<Filter> = vec![];

        // 空のフィルターはすべてにマッチするべき
        assert!(FilterEvaluator::matches_any(&event, &filters));
    }

    #[test]
    fn test_matches_any_first_filter_matches() {
        let event = create_test_event_with_kind(1);

        let filters = vec![
            Filter::new().kind(Kind::TextNote),     // マッチ
            Filter::new().kind(Kind::Metadata),     // マッチしない
        ];

        assert!(FilterEvaluator::matches_any(&event, &filters));
    }

    #[test]
    fn test_matches_any_second_filter_matches() {
        let event = create_test_event_with_kind(1);

        let filters = vec![
            Filter::new().kind(Kind::Metadata),     // マッチしない
            Filter::new().kind(Kind::TextNote),     // マッチ
        ];

        assert!(FilterEvaluator::matches_any(&event, &filters));
    }

    #[test]
    fn test_matches_any_no_filter_matches() {
        let event = create_test_event_with_kind(1);

        let filters = vec![
            Filter::new().kind(Kind::Metadata),
            Filter::new().kind(Kind::ContactList),
        ];

        assert!(!FilterEvaluator::matches_any(&event, &filters));
    }

    // ==================== フィルターバリデーションテスト (要件 8.11) ====================

    #[test]
    fn test_validate_filter_empty_filter() {
        let filter = Filter::new();
        assert!(FilterEvaluator::validate_filter(&filter).is_ok());
    }

    #[test]
    fn test_validate_filter_valid_id() {
        let valid_id = nostr::EventId::from_hex(&"a".repeat(64)).unwrap();
        let filter = Filter::new().id(valid_id);
        assert!(FilterEvaluator::validate_filter(&filter).is_ok());
    }

    #[test]
    fn test_validate_filter_valid_author() {
        let valid_pubkey = nostr::PublicKey::from_hex(&"a".repeat(64)).unwrap();
        let filter = Filter::new().author(valid_pubkey);
        assert!(FilterEvaluator::validate_filter(&filter).is_ok());
    }

    #[test]
    fn test_validate_filter_valid_e_tag() {
        let valid_id = "a".repeat(64);
        let filter = Filter::new().custom_tag(
            nostr::SingleLetterTag::lowercase(nostr::Alphabet::E),
            valid_id,
        );
        assert!(FilterEvaluator::validate_filter(&filter).is_ok());
    }

    #[test]
    fn test_validate_filter_valid_p_tag() {
        let valid_pubkey = "b".repeat(64);
        let filter = Filter::new().custom_tag(
            nostr::SingleLetterTag::lowercase(nostr::Alphabet::P),
            valid_pubkey,
        );
        assert!(FilterEvaluator::validate_filter(&filter).is_ok());
    }

    // ==================== エラー表示テスト ====================

    #[test]
    fn test_filter_validation_error_display() {
        let err = FilterValidationError::InvalidIdFormat("invalid".to_string());
        assert_eq!(err.to_string(), "invalid id format: invalid");

        let err = FilterValidationError::InvalidAuthorFormat("invalid".to_string());
        assert_eq!(err.to_string(), "invalid author format: invalid");

        let err = FilterValidationError::InvalidTagValueFormat {
            tag: "e".to_string(),
            value: "invalid".to_string(),
        };
        assert_eq!(err.to_string(), "invalid #e tag value format: invalid");
    }
}
