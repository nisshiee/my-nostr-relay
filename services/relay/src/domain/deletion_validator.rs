// 削除可否の検証ロジック
//
// 削除操作の可否を検証する純粋関数群。
// 外部依存を持たない純粋なドメインロジック。
// Requirements: 2.2, 3.2, 3.3, 5.1

/// 削除検証ロジック
///
/// 削除リクエストの検証に使用する静的メソッドを提供。
/// ステートレスな純粋関数として実装。
pub struct DeletionValidator;

impl DeletionValidator {
    /// pubkeyの一致を検証
    ///
    /// # Arguments
    /// * `target_pubkey` - 削除対象イベントのpubkey
    /// * `requester_pubkey` - 削除リクエストのpubkey
    ///
    /// # Returns
    /// * `true` - 一致（削除可能）
    /// * `false` - 不一致（削除不可）
    pub fn validate_pubkey_match(target_pubkey: &str, requester_pubkey: &str) -> bool {
        target_pubkey == requester_pubkey
    }

    /// 削除保護対象のkindかどうか判定
    ///
    /// kind:5は他のkind:5で削除できない（NIP-09仕様）
    ///
    /// # Arguments
    /// * `kind` - 削除対象イベントのkind
    ///
    /// # Returns
    /// * `true` - 保護対象（削除不可）
    /// * `false` - 削除可能
    pub fn is_protected_kind(kind: u16) -> bool {
        kind == 5
    }

    /// Addressable削除の時刻境界を検証
    ///
    /// 削除リクエストのcreated_at以前に作成されたイベントのみ削除対象。
    ///
    /// # Arguments
    /// * `event_created_at` - 削除対象イベントのcreated_at
    /// * `request_created_at` - 削除リクエストのcreated_at
    ///
    /// # Returns
    /// * `true` - 削除リクエスト以前（削除対象）
    /// * `false` - 削除リクエスト以降（削除対象外）
    pub fn is_within_deletion_window(event_created_at: u64, request_created_at: u64) -> bool {
        event_created_at <= request_created_at
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ==================== 2.2 pubkey一致検証テスト ====================

    /// pubkeyが一致する場合はtrueを返す
    #[test]
    fn test_validate_pubkey_match_returns_true_when_match() {
        let pubkey = "a".repeat(64);
        assert!(DeletionValidator::validate_pubkey_match(&pubkey, &pubkey));
    }

    /// pubkeyが不一致の場合はfalseを返す
    #[test]
    fn test_validate_pubkey_match_returns_false_when_mismatch() {
        let target_pubkey = "a".repeat(64);
        let requester_pubkey = "b".repeat(64);
        assert!(!DeletionValidator::validate_pubkey_match(
            &target_pubkey,
            &requester_pubkey
        ));
    }

    /// 空のpubkey同士は一致とみなす
    #[test]
    fn test_validate_pubkey_match_empty_strings_match() {
        assert!(DeletionValidator::validate_pubkey_match("", ""));
    }

    /// 部分一致はfalseを返す
    #[test]
    fn test_validate_pubkey_match_partial_match_returns_false() {
        let target_pubkey = "a".repeat(64);
        let requester_pubkey = "a".repeat(63) + "b";
        assert!(!DeletionValidator::validate_pubkey_match(
            &target_pubkey,
            &requester_pubkey
        ));
    }

    // ==================== 5.1 kind:5保護判定テスト ====================

    /// kind:5は保護対象
    #[test]
    fn test_is_protected_kind_returns_true_for_kind_5() {
        assert!(DeletionValidator::is_protected_kind(5));
    }

    /// kind:1（通常投稿）は保護対象外
    #[test]
    fn test_is_protected_kind_returns_false_for_kind_1() {
        assert!(!DeletionValidator::is_protected_kind(1));
    }

    /// kind:0（メタデータ）は保護対象外
    #[test]
    fn test_is_protected_kind_returns_false_for_kind_0() {
        assert!(!DeletionValidator::is_protected_kind(0));
    }

    /// kind:3（コンタクトリスト）は保護対象外
    #[test]
    fn test_is_protected_kind_returns_false_for_kind_3() {
        assert!(!DeletionValidator::is_protected_kind(3));
    }

    /// kind:30000（Addressable）は保護対象外
    #[test]
    fn test_is_protected_kind_returns_false_for_addressable_kind() {
        assert!(!DeletionValidator::is_protected_kind(30000));
    }

    /// kind:4は保護対象外
    #[test]
    fn test_is_protected_kind_returns_false_for_kind_4() {
        assert!(!DeletionValidator::is_protected_kind(4));
    }

    /// kind:6は保護対象外
    #[test]
    fn test_is_protected_kind_returns_false_for_kind_6() {
        assert!(!DeletionValidator::is_protected_kind(6));
    }

    // ==================== 3.3 時刻境界検証テスト ====================

    /// イベントが削除リクエストより前に作成された場合はtrue
    #[test]
    fn test_is_within_deletion_window_event_before_request() {
        let event_created_at = 1000;
        let request_created_at = 2000;
        assert!(DeletionValidator::is_within_deletion_window(
            event_created_at,
            request_created_at
        ));
    }

    /// イベントが削除リクエストと同時刻の場合はtrue（境界値テスト）
    #[test]
    fn test_is_within_deletion_window_event_same_as_request() {
        let timestamp = 1500;
        assert!(DeletionValidator::is_within_deletion_window(
            timestamp, timestamp
        ));
    }

    /// イベントが削除リクエストより後に作成された場合はfalse
    #[test]
    fn test_is_within_deletion_window_event_after_request() {
        let event_created_at = 2000;
        let request_created_at = 1000;
        assert!(!DeletionValidator::is_within_deletion_window(
            event_created_at,
            request_created_at
        ));
    }

    /// タイムスタンプ0の場合も正しく処理される
    #[test]
    fn test_is_within_deletion_window_zero_timestamp() {
        assert!(DeletionValidator::is_within_deletion_window(0, 0));
        assert!(DeletionValidator::is_within_deletion_window(0, 100));
        assert!(!DeletionValidator::is_within_deletion_window(100, 0));
    }

    /// 大きなタイムスタンプでも正しく処理される
    #[test]
    fn test_is_within_deletion_window_large_timestamps() {
        let large_event_time = u64::MAX - 1000;
        let large_request_time = u64::MAX;
        assert!(DeletionValidator::is_within_deletion_window(
            large_event_time,
            large_request_time
        ));
        assert!(!DeletionValidator::is_within_deletion_window(
            large_request_time,
            large_event_time
        ));
    }

    // ==================== 複合テスト ====================

    /// 実際の削除判定シナリオ：所有者が自身のkind:1イベントを削除
    #[test]
    fn test_real_scenario_owner_deletes_own_event() {
        let pubkey = "abc123".repeat(10);
        let event_kind = 1; // 通常投稿
        let event_created_at = 1700000000;
        let request_created_at = 1700000100; // 100秒後の削除リクエスト

        // 検証: 全ての条件を満たす
        assert!(DeletionValidator::validate_pubkey_match(&pubkey, &pubkey));
        assert!(!DeletionValidator::is_protected_kind(event_kind));
        assert!(DeletionValidator::is_within_deletion_window(
            event_created_at,
            request_created_at
        ));
    }

    /// 実際の削除判定シナリオ：他人のイベントを削除しようとする
    #[test]
    fn test_real_scenario_attempt_delete_others_event() {
        let target_pubkey = "aaa".repeat(20);
        let requester_pubkey = "bbb".repeat(20);

        // 検証: pubkey不一致で削除不可
        assert!(!DeletionValidator::validate_pubkey_match(
            &target_pubkey,
            &requester_pubkey
        ));
    }

    /// 実際の削除判定シナリオ：kind:5イベントを削除しようとする
    #[test]
    fn test_real_scenario_attempt_delete_deletion_event() {
        let pubkey = "abc123".repeat(10);
        let event_kind = 5; // 削除リクエスト自体

        // 検証: pubkey一致でもkind:5は保護対象
        assert!(DeletionValidator::validate_pubkey_match(&pubkey, &pubkey));
        assert!(DeletionValidator::is_protected_kind(event_kind));
    }

    /// 実際の削除判定シナリオ：Addressableイベントの時刻境界外削除
    #[test]
    fn test_real_scenario_addressable_after_deletion_request() {
        let pubkey = "abc123".repeat(10);
        let event_kind = 30000; // Addressableイベント
        let request_created_at = 1700000000; // 削除リクエスト時刻
        let event_created_at = 1700000100; // 削除リクエスト後に更新されたバージョン

        // 検証: pubkey一致、kind保護なしだが、時刻境界外
        assert!(DeletionValidator::validate_pubkey_match(&pubkey, &pubkey));
        assert!(!DeletionValidator::is_protected_kind(event_kind));
        assert!(!DeletionValidator::is_within_deletion_window(
            event_created_at,
            request_created_at
        ));
    }
}
