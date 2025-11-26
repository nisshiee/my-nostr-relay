/// Event kind classification based on NIP-01
///
/// Requirements: 9.1, 10.1, 11.1, 12.1
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventKind {
    /// Regular events: stored normally
    /// kind 1, 2, 4-44, 1000-9999
    Regular,

    /// Replaceable events: only latest per pubkey+kind is kept
    /// kind 0, 3, 10000-19999
    Replaceable,

    /// Ephemeral events: not stored, only broadcast
    /// kind 20000-29999
    Ephemeral,

    /// Addressable events: only latest per pubkey+kind+d_tag is kept
    /// kind 30000-39999
    Addressable,
}

impl EventKind {
    /// Classify an event kind into one of the four categories
    ///
    /// Based on NIP-01 specification:
    /// - Regular: 1, 2, 4-44, 1000-9999
    /// - Replaceable: 0, 3, 10000-19999
    /// - Ephemeral: 20000-29999
    /// - Addressable: 30000-39999
    pub fn classify(kind: u16) -> Self {
        match kind {
            // Ephemeral: 20000-29999
            n if (20000..30000).contains(&n) => EventKind::Ephemeral,

            // Addressable: 30000-39999
            n if (30000..40000).contains(&n) => EventKind::Addressable,

            // Replaceable: 0, 3, 10000-19999
            0 | 3 => EventKind::Replaceable,
            n if (10000..20000).contains(&n) => EventKind::Replaceable,

            // Regular: 1, 2, 4-44, 1000-9999
            _ => EventKind::Regular,
        }
    }

    /// Check if this event kind should be stored
    pub fn should_store(&self) -> bool {
        !matches!(self, EventKind::Ephemeral)
    }

    /// Check if this event kind replaces existing events
    pub fn is_replaceable(&self) -> bool {
        matches!(self, EventKind::Replaceable | EventKind::Addressable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ==================== 2.1 Kind Classification Tests ====================

    // Regular kind tests (Req 9.1)
    #[test]
    fn test_classify_regular_kind_1() {
        assert_eq!(EventKind::classify(1), EventKind::Regular);
    }

    #[test]
    fn test_classify_regular_kind_2() {
        assert_eq!(EventKind::classify(2), EventKind::Regular);
    }

    #[test]
    fn test_classify_regular_kind_4_to_44() {
        for kind in 4..=44 {
            assert_eq!(
                EventKind::classify(kind),
                EventKind::Regular,
                "kind {} should be Regular",
                kind
            );
        }
    }

    #[test]
    fn test_classify_regular_kind_1000_to_9999() {
        // Test boundaries
        assert_eq!(EventKind::classify(1000), EventKind::Regular);
        assert_eq!(EventKind::classify(9999), EventKind::Regular);
        // Test some values in between
        assert_eq!(EventKind::classify(5000), EventKind::Regular);
    }

    // Replaceable kind tests (Req 10.1)
    #[test]
    fn test_classify_replaceable_kind_0() {
        assert_eq!(EventKind::classify(0), EventKind::Replaceable);
    }

    #[test]
    fn test_classify_replaceable_kind_3() {
        assert_eq!(EventKind::classify(3), EventKind::Replaceable);
    }

    #[test]
    fn test_classify_replaceable_kind_10000_to_19999() {
        // Test boundaries
        assert_eq!(EventKind::classify(10000), EventKind::Replaceable);
        assert_eq!(EventKind::classify(19999), EventKind::Replaceable);
        // Test some values in between
        assert_eq!(EventKind::classify(15000), EventKind::Replaceable);
    }

    // Ephemeral kind tests (Req 11.1)
    #[test]
    fn test_classify_ephemeral_kind_20000_to_29999() {
        // Test boundaries
        assert_eq!(EventKind::classify(20000), EventKind::Ephemeral);
        assert_eq!(EventKind::classify(29999), EventKind::Ephemeral);
        // Test some values in between
        assert_eq!(EventKind::classify(25000), EventKind::Ephemeral);
    }

    // Addressable kind tests (Req 12.1)
    #[test]
    fn test_classify_addressable_kind_30000_to_39999() {
        // Test boundaries
        assert_eq!(EventKind::classify(30000), EventKind::Addressable);
        assert_eq!(EventKind::classify(39999), EventKind::Addressable);
        // Test some values in between
        assert_eq!(EventKind::classify(35000), EventKind::Addressable);
    }

    // Boundary tests
    #[test]
    fn test_classify_boundary_9999_is_regular() {
        assert_eq!(EventKind::classify(9999), EventKind::Regular);
    }

    #[test]
    fn test_classify_boundary_10000_is_replaceable() {
        assert_eq!(EventKind::classify(10000), EventKind::Replaceable);
    }

    #[test]
    fn test_classify_boundary_19999_is_replaceable() {
        assert_eq!(EventKind::classify(19999), EventKind::Replaceable);
    }

    #[test]
    fn test_classify_boundary_20000_is_ephemeral() {
        assert_eq!(EventKind::classify(20000), EventKind::Ephemeral);
    }

    #[test]
    fn test_classify_boundary_29999_is_ephemeral() {
        assert_eq!(EventKind::classify(29999), EventKind::Ephemeral);
    }

    #[test]
    fn test_classify_boundary_30000_is_addressable() {
        assert_eq!(EventKind::classify(30000), EventKind::Addressable);
    }

    #[test]
    fn test_classify_boundary_39999_is_addressable() {
        assert_eq!(EventKind::classify(39999), EventKind::Addressable);
    }

    #[test]
    fn test_classify_boundary_40000_is_regular() {
        // Kinds >= 40000 fall back to Regular
        assert_eq!(EventKind::classify(40000), EventKind::Regular);
    }

    // should_store tests
    #[test]
    fn test_regular_should_store() {
        assert!(EventKind::Regular.should_store());
    }

    #[test]
    fn test_replaceable_should_store() {
        assert!(EventKind::Replaceable.should_store());
    }

    #[test]
    fn test_ephemeral_should_not_store() {
        assert!(!EventKind::Ephemeral.should_store());
    }

    #[test]
    fn test_addressable_should_store() {
        assert!(EventKind::Addressable.should_store());
    }

    // is_replaceable tests
    #[test]
    fn test_regular_is_not_replaceable() {
        assert!(!EventKind::Regular.is_replaceable());
    }

    #[test]
    fn test_replaceable_is_replaceable() {
        assert!(EventKind::Replaceable.is_replaceable());
    }

    #[test]
    fn test_ephemeral_is_not_replaceable() {
        assert!(!EventKind::Ephemeral.is_replaceable());
    }

    #[test]
    fn test_addressable_is_replaceable() {
        assert!(EventKind::Addressable.is_replaceable());
    }
}
