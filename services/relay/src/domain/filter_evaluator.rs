/// Filter evaluation for NIP-01 compliance
///
/// Requirements: 8.1-8.11
use nostr::filter::MatchEventOptions;
use nostr::{Event, Filter};
use thiserror::Error;

/// Filter validation errors
#[derive(Debug, Clone, PartialEq, Error)]
pub enum FilterValidationError {
    /// ID value is not valid hex format
    #[error("invalid id format: {0}")]
    InvalidIdFormat(String),
    /// Author value is not valid hex format
    #[error("invalid author format: {0}")]
    InvalidAuthorFormat(String),
    /// Tag value is not valid format for #e or #p
    #[error("invalid #{tag} tag value format: {value}")]
    InvalidTagValueFormat { tag: String, value: String },
}

/// Filter evaluator for matching events against NIP-01 filters
pub struct FilterEvaluator;

impl FilterEvaluator {
    /// Check if an event matches a single filter (Requirements 8.1-8.8)
    ///
    /// Filter conditions are ANDed together:
    /// - ids: event id prefix matches any in list (8.1)
    /// - authors: event pubkey prefix matches any in list (8.2)
    /// - kinds: event kind matches any in list (8.3)
    /// - #<letter>: tag value matches any in list (8.4)
    /// - since: created_at >= since (8.5)
    /// - until: created_at <= until (8.6)
    pub fn matches(event: &Event, filter: &Filter) -> bool {
        filter.match_event(event, MatchEventOptions::default())
    }

    /// Check if an event matches any of multiple filters (Requirement 8.9)
    ///
    /// Multiple filters are ORed together
    pub fn matches_any(event: &Event, filters: &[Filter]) -> bool {
        if filters.is_empty() {
            // Empty filter list matches all events
            return true;
        }

        filters.iter().any(|filter| Self::matches(event, filter))
    }

    /// Validate filter values (Requirement 8.11)
    ///
    /// Validates that:
    /// - ids values are 64-character lowercase hex strings
    /// - authors values are 64-character lowercase hex strings
    /// - #e tag values are 64-character lowercase hex strings
    /// - #p tag values are 64-character lowercase hex strings
    pub fn validate_filter(filter: &Filter) -> Result<(), FilterValidationError> {
        // Validate ids (full 64-char hex or prefix)
        if let Some(ids) = filter.ids.as_ref() {
            for id in ids.iter() {
                let id_str = id.to_hex();
                if !Self::is_valid_hex(&id_str) {
                    return Err(FilterValidationError::InvalidIdFormat(id_str));
                }
            }
        }

        // Validate authors (full 64-char hex or prefix)
        if let Some(authors) = filter.authors.as_ref() {
            for author in authors.iter() {
                let author_str = author.to_hex();
                if !Self::is_valid_hex(&author_str) {
                    return Err(FilterValidationError::InvalidAuthorFormat(author_str));
                }
            }
        }

        // Validate #e tag values
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

        // Validate #p tag values
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

    /// Check if a string is valid lowercase hex
    fn is_valid_hex(s: &str) -> bool {
        !s.is_empty() && s.chars().all(|c| c.is_ascii_hexdigit() && !c.is_uppercase())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Timestamp};

    // Helper to create a test event
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

    // ==================== Single Filter Matching Tests (Req 8.1-8.6, 8.8) ====================

    // Req 8.1: ids filter
    #[test]
    fn test_matches_ids_filter() {
        let event = create_test_event("hello");
        let event_id = event.id;

        // Filter with matching id
        let filter = Filter::new().id(event_id);
        assert!(FilterEvaluator::matches(&event, &filter));

        // Filter with non-matching id
        let other_event = create_test_event("other");
        let filter_other = Filter::new().id(other_event.id);
        assert!(!FilterEvaluator::matches(&event, &filter_other));
    }

    // Req 8.2: authors filter
    #[test]
    fn test_matches_authors_filter() {
        let keys = Keys::generate();
        let event = EventBuilder::text_note("hello")
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        // Filter with matching author
        let filter = Filter::new().author(keys.public_key());
        assert!(FilterEvaluator::matches(&event, &filter));

        // Filter with non-matching author
        let other_keys = Keys::generate();
        let filter_other = Filter::new().author(other_keys.public_key());
        assert!(!FilterEvaluator::matches(&event, &filter_other));
    }

    // Req 8.3: kinds filter
    #[test]
    fn test_matches_kinds_filter() {
        let event = create_test_event_with_kind(1);

        // Filter with matching kind
        let filter = Filter::new().kind(Kind::TextNote);
        assert!(FilterEvaluator::matches(&event, &filter));

        // Filter with non-matching kind
        let filter_other = Filter::new().kind(Kind::Metadata);
        assert!(!FilterEvaluator::matches(&event, &filter_other));
    }

    #[test]
    fn test_matches_multiple_kinds() {
        let event = create_test_event_with_kind(1);

        let filter = Filter::new().kinds([Kind::TextNote, Kind::Metadata]);
        assert!(FilterEvaluator::matches(&event, &filter));
    }

    // Req 8.4: #<letter> tag filter
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

    // Req 8.5: since filter
    #[test]
    fn test_matches_since_filter() {
        let event = create_test_event("hello");
        let event_time = event.created_at;

        // Filter with since before event time
        let filter = Filter::new().since(Timestamp::from_secs(event_time.as_secs() - 100));
        assert!(FilterEvaluator::matches(&event, &filter));

        // Filter with since after event time
        let filter_future = Filter::new().since(Timestamp::from_secs(event_time.as_secs() + 100));
        assert!(!FilterEvaluator::matches(&event, &filter_future));
    }

    #[test]
    fn test_matches_since_equal() {
        let event = create_test_event("hello");
        let event_time = event.created_at;

        // since <= created_at should match
        let filter = Filter::new().since(event_time);
        assert!(FilterEvaluator::matches(&event, &filter));
    }

    // Req 8.6: until filter
    #[test]
    fn test_matches_until_filter() {
        let event = create_test_event("hello");
        let event_time = event.created_at;

        // Filter with until after event time
        let filter = Filter::new().until(Timestamp::from_secs(event_time.as_secs() + 100));
        assert!(FilterEvaluator::matches(&event, &filter));

        // Filter with until before event time
        let filter_past = Filter::new().until(Timestamp::from_secs(event_time.as_secs() - 100));
        assert!(!FilterEvaluator::matches(&event, &filter_past));
    }

    #[test]
    fn test_matches_until_equal() {
        let event = create_test_event("hello");
        let event_time = event.created_at;

        // created_at <= until should match
        let filter = Filter::new().until(event_time);
        assert!(FilterEvaluator::matches(&event, &filter));
    }

    // Req 8.8: Multiple conditions AND
    #[test]
    fn test_matches_multiple_conditions_and() {
        let keys = Keys::generate();
        let event = EventBuilder::new(Kind::TextNote, "test")
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        // Filter with multiple conditions
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

        // Filter with author match but kind mismatch
        let filter = Filter::new()
            .author(keys.public_key())
            .kind(Kind::Metadata); // Wrong kind

        assert!(!FilterEvaluator::matches(&event, &filter));
    }

    // ==================== Multiple Filter OR Tests (Req 8.9) ====================

    #[test]
    fn test_matches_any_empty_filters() {
        let event = create_test_event("hello");
        let filters: Vec<Filter> = vec![];

        // Empty filters should match everything
        assert!(FilterEvaluator::matches_any(&event, &filters));
    }

    #[test]
    fn test_matches_any_first_filter_matches() {
        let event = create_test_event_with_kind(1);

        let filters = vec![
            Filter::new().kind(Kind::TextNote),     // Matches
            Filter::new().kind(Kind::Metadata),     // Doesn't match
        ];

        assert!(FilterEvaluator::matches_any(&event, &filters));
    }

    #[test]
    fn test_matches_any_second_filter_matches() {
        let event = create_test_event_with_kind(1);

        let filters = vec![
            Filter::new().kind(Kind::Metadata),     // Doesn't match
            Filter::new().kind(Kind::TextNote),     // Matches
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

    // ==================== Filter Validation Tests (Req 8.11) ====================

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

    // ==================== Error Display Tests ====================

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
