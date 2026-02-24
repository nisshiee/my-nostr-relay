#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct Kind(u16);

impl Kind {
    /// 内部のu16値を返す
    pub fn as_u16(&self) -> u16 {
        self.0
    }

    /// Regular event (kind 1, 2, 4-44, 1000-9999)
    /// 通常のイベント（保存・配信される）
    #[allow(dead_code)]
    pub fn is_regular(&self) -> bool {
        let k = self.0;
        k == 1 || k == 2 || (4..=44).contains(&k) || (1000..10000).contains(&k)
    }

    /// Replaceable event (kind 0, 3, 10000-19999)
    /// 同一 pubkey + kind で最新のみ保持
    pub fn is_replaceable(&self) -> bool {
        let k = self.0;
        k == 0 || k == 3 || (10000..20000).contains(&k)
    }

    /// Deletion request (kind 5, NIP-09)
    pub fn is_deletion_request(&self) -> bool {
        self.0 == 5
    }

    /// Ephemeral event (kind 20000-29999)
    /// 保存せず配信のみ
    pub fn is_ephemeral(&self) -> bool {
        (20000..30000).contains(&self.0)
    }

    /// Addressable event (kind 30000-39999)
    /// 同一 pubkey + kind + d タグで最新のみ保持
    pub fn is_addressable(&self) -> bool {
        (30000..40000).contains(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_regular() {
        // 境界値テスト
        assert!(Kind(1).is_regular());
        assert!(Kind(2).is_regular());
        assert!(Kind(4).is_regular());
        assert!(Kind(44).is_regular());
        assert!(Kind(1000).is_regular());
        assert!(Kind(9999).is_regular());

        // 範囲外
        assert!(!Kind(0).is_regular());
        assert!(!Kind(3).is_regular());
        assert!(!Kind(45).is_regular());
        assert!(!Kind(999).is_regular());
        assert!(!Kind(10000).is_regular());
    }

    #[test]
    fn test_is_replaceable() {
        // 境界値テスト
        assert!(Kind(0).is_replaceable());
        assert!(Kind(3).is_replaceable());
        assert!(Kind(10000).is_replaceable());
        assert!(Kind(19999).is_replaceable());

        // 範囲外
        assert!(!Kind(1).is_replaceable());
        assert!(!Kind(2).is_replaceable());
        assert!(!Kind(9999).is_replaceable());
        assert!(!Kind(20000).is_replaceable());
    }

    #[test]
    fn test_is_ephemeral() {
        // 境界値テスト
        assert!(Kind(20000).is_ephemeral());
        assert!(Kind(29999).is_ephemeral());

        // 範囲外
        assert!(!Kind(19999).is_ephemeral());
        assert!(!Kind(30000).is_ephemeral());
    }

    #[test]
    fn test_is_addressable() {
        // 境界値テスト
        assert!(Kind(30000).is_addressable());
        assert!(Kind(39999).is_addressable());

        // 範囲外
        assert!(!Kind(29999).is_addressable());
        assert!(!Kind(40000).is_addressable());
    }
}
