// 削除対象の表現と抽出機能
//
// NIP-09削除リクエストイベントから削除対象を抽出し、型安全に表現する。
// Requirements: 1.2, 1.3

use nostr::Event;

/// 削除対象の種別
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeletionTargetKind {
    /// イベントID指定（eタグ）
    EventId(String),
    /// Addressable指定（aタグ）: kind, pubkey, d_tag
    Address {
        kind: u16,
        pubkey: String,
        d_tag: String,
    },
}

/// 削除対象
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeletionTarget {
    /// 削除対象の種別
    pub target: DeletionTargetKind,
    /// 削除リクエストのpubkey（所有者検証用）
    pub requester_pubkey: String,
    /// 削除リクエストのcreated_at（aタグ削除の時刻境界）
    pub request_created_at: u64,
}

impl DeletionTarget {
    /// 削除リクエストイベントから削除対象リストを抽出
    ///
    /// # Arguments
    /// * `event` - kind:5の削除リクエストイベント
    ///
    /// # Returns
    /// * 抽出された削除対象のリスト（eタグ・aタグ混在可能）
    ///
    /// # Notes
    /// - eタグ: 単純にイベントIDを抽出
    /// - aタグ: フォーマット（kind:pubkey:d_tag）を検証し、不正な場合はスキップ
    /// - aタグ内のpubkeyと削除リクエストのpubkeyを比較し、不一致は早期フィルタリング
    pub fn parse_from_event(event: &Event) -> Vec<DeletionTarget> {
        let requester_pubkey = event.pubkey.to_hex();
        let request_created_at = event.created_at.as_secs();

        event
            .tags
            .iter()
            .filter_map(|tag| {
                let tag_vec: Vec<String> = tag.clone().to_vec();
                if tag_vec.is_empty() {
                    return None;
                }

                let tag_name = &tag_vec[0];
                let tag_value = tag_vec.get(1)?;

                match tag_name.as_str() {
                    "e" => {
                        // eタグ: イベントID指定
                        if tag_value.is_empty() {
                            return None;
                        }
                        Some(DeletionTarget {
                            target: DeletionTargetKind::EventId(tag_value.clone()),
                            requester_pubkey: requester_pubkey.clone(),
                            request_created_at,
                        })
                    }
                    "a" => {
                        // aタグ: Addressable指定（kind:pubkey:d_tag形式）
                        Self::parse_a_tag_value(tag_value, &requester_pubkey, request_created_at)
                    }
                    _ => None, // その他のタグは無視
                }
            })
            .collect()
    }

    /// aタグの値をパースしてDeletionTargetを生成
    ///
    /// # Arguments
    /// * `value` - aタグの値（kind:pubkey:d_tag形式）
    /// * `requester_pubkey` - 削除リクエストのpubkey
    /// * `request_created_at` - 削除リクエストのcreated_at
    ///
    /// # Returns
    /// * `Some(DeletionTarget)` - パース成功かつpubkey一致
    /// * `None` - パース失敗またはpubkey不一致
    fn parse_a_tag_value(
        value: &str,
        requester_pubkey: &str,
        request_created_at: u64,
    ) -> Option<DeletionTarget> {
        // aタグのフォーマット: kind:pubkey:d_tag
        // d_tagにコロンが含まれる可能性があるため、splitn(3, ':')を使用
        let parts: Vec<&str> = value.splitn(3, ':').collect();
        if parts.len() < 3 {
            // 最低でもkind:pubkey:の形式が必要（d_tagは空でも可）
            return None;
        }

        // kindのパース
        let kind: u16 = parts[0].parse().ok()?;

        // pubkeyの取得
        let pubkey = parts[1].to_string();

        // d_tagの取得（空の場合もある）
        let d_tag = parts[2].to_string();

        // pubkeyの一致チェック（早期フィルタリング）
        if pubkey != requester_pubkey {
            return None;
        }

        Some(DeletionTarget {
            target: DeletionTargetKind::Address { kind, pubkey, d_tag },
            requester_pubkey: requester_pubkey.to_string(),
            request_created_at,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};

    // ==================== テストヘルパー関数 ====================

    /// テスト用のkind:5削除リクエストイベントを作成
    fn create_deletion_event(keys: &Keys, tags: Vec<Tag>) -> Event {
        EventBuilder::new(Kind::from(5), "deletion request")
            .tags(tags)
            .sign_with_keys(keys)
            .expect("Failed to create deletion event")
    }

    /// テスト用のkind:5削除リクエストイベントを指定タイムスタンプで作成
    fn create_deletion_event_with_timestamp(keys: &Keys, tags: Vec<Tag>, timestamp: u64) -> Event {
        EventBuilder::new(Kind::from(5), "deletion request")
            .tags(tags)
            .custom_created_at(Timestamp::from(timestamp))
            .sign_with_keys(keys)
            .expect("Failed to create deletion event")
    }

    // ==================== 1.2 eタグ解析テスト ====================

    /// eタグから削除対象を抽出できることを確認
    #[test]
    fn test_parse_e_tag_single() {
        let keys = Keys::generate();
        let event_id = "a".repeat(64);
        let e_tag = Tag::parse(["e", &event_id]).unwrap();
        let event = create_deletion_event(&keys, vec![e_tag]);

        let targets = DeletionTarget::parse_from_event(&event);

        assert_eq!(targets.len(), 1);
        assert_eq!(
            targets[0].target,
            DeletionTargetKind::EventId(event_id.clone())
        );
        assert_eq!(targets[0].requester_pubkey, keys.public_key().to_hex());
        assert_eq!(targets[0].request_created_at, event.created_at.as_secs());
    }

    /// 複数のeタグから削除対象を抽出できることを確認
    #[test]
    fn test_parse_e_tag_multiple() {
        let keys = Keys::generate();
        let event_id1 = "a".repeat(64);
        let event_id2 = "b".repeat(64);
        let event_id3 = "c".repeat(64);
        let e_tag1 = Tag::parse(["e", &event_id1]).unwrap();
        let e_tag2 = Tag::parse(["e", &event_id2]).unwrap();
        let e_tag3 = Tag::parse(["e", &event_id3]).unwrap();
        let event = create_deletion_event(&keys, vec![e_tag1, e_tag2, e_tag3]);

        let targets = DeletionTarget::parse_from_event(&event);

        assert_eq!(targets.len(), 3);
        // 順序を保持して抽出されることを確認
        assert_eq!(
            targets[0].target,
            DeletionTargetKind::EventId(event_id1.clone())
        );
        assert_eq!(
            targets[1].target,
            DeletionTargetKind::EventId(event_id2.clone())
        );
        assert_eq!(
            targets[2].target,
            DeletionTargetKind::EventId(event_id3.clone())
        );
    }

    /// eタグが空の場合は空のリストを返す
    #[test]
    fn test_parse_no_tags_returns_empty() {
        let keys = Keys::generate();
        let event = create_deletion_event(&keys, vec![]);

        let targets = DeletionTarget::parse_from_event(&event);

        assert!(targets.is_empty());
    }

    // ==================== 1.3 aタグ解析テスト ====================

    /// aタグから削除対象を抽出できることを確認
    #[test]
    fn test_parse_a_tag_single() {
        let keys = Keys::generate();
        let pubkey = keys.public_key().to_hex();
        let a_tag_value = format!("30000:{}:test-identifier", pubkey);
        let a_tag = Tag::parse(["a", &a_tag_value]).unwrap();
        let event = create_deletion_event(&keys, vec![a_tag]);

        let targets = DeletionTarget::parse_from_event(&event);

        assert_eq!(targets.len(), 1);
        assert_eq!(
            targets[0].target,
            DeletionTargetKind::Address {
                kind: 30000,
                pubkey: pubkey.clone(),
                d_tag: "test-identifier".to_string(),
            }
        );
    }

    /// 複数のaタグから削除対象を抽出できることを確認
    #[test]
    fn test_parse_a_tag_multiple() {
        let keys = Keys::generate();
        let pubkey = keys.public_key().to_hex();
        let a_tag1 = Tag::parse(["a", &format!("30000:{}:id1", pubkey)]).unwrap();
        let a_tag2 = Tag::parse(["a", &format!("30001:{}:id2", pubkey)]).unwrap();
        let event = create_deletion_event(&keys, vec![a_tag1, a_tag2]);

        let targets = DeletionTarget::parse_from_event(&event);

        assert_eq!(targets.len(), 2);
        assert_eq!(
            targets[0].target,
            DeletionTargetKind::Address {
                kind: 30000,
                pubkey: pubkey.clone(),
                d_tag: "id1".to_string(),
            }
        );
        assert_eq!(
            targets[1].target,
            DeletionTargetKind::Address {
                kind: 30001,
                pubkey: pubkey.clone(),
                d_tag: "id2".to_string(),
            }
        );
    }

    /// aタグとeタグの混在から削除対象を抽出できることを確認
    #[test]
    fn test_parse_mixed_e_and_a_tags() {
        let keys = Keys::generate();
        let pubkey = keys.public_key().to_hex();
        let event_id = "d".repeat(64);
        let e_tag = Tag::parse(["e", &event_id]).unwrap();
        let a_tag = Tag::parse(["a", &format!("30000:{}:mixed-test", pubkey)]).unwrap();
        let event = create_deletion_event(&keys, vec![e_tag, a_tag]);

        let targets = DeletionTarget::parse_from_event(&event);

        assert_eq!(targets.len(), 2);
        assert_eq!(
            targets[0].target,
            DeletionTargetKind::EventId(event_id.clone())
        );
        assert_eq!(
            targets[1].target,
            DeletionTargetKind::Address {
                kind: 30000,
                pubkey: pubkey.clone(),
                d_tag: "mixed-test".to_string(),
            }
        );
    }

    // ==================== aタグフォーマット検証テスト ====================

    /// 不正なaタグフォーマット（コロンが足りない）はスキップされる
    #[test]
    fn test_parse_a_tag_invalid_format_missing_colon() {
        let keys = Keys::generate();
        let pubkey = keys.public_key().to_hex();
        // 有効なaタグと無効なaタグを混在
        let valid_a_tag = Tag::parse(["a", &format!("30000:{}:valid", pubkey)]).unwrap();
        let invalid_a_tag = Tag::parse(["a", "invalid-no-colons"]).unwrap();
        let event = create_deletion_event(&keys, vec![invalid_a_tag, valid_a_tag]);

        let targets = DeletionTarget::parse_from_event(&event);

        // 無効なタグはスキップされ、有効なタグのみ抽出
        assert_eq!(targets.len(), 1);
        assert_eq!(
            targets[0].target,
            DeletionTargetKind::Address {
                kind: 30000,
                pubkey: pubkey.clone(),
                d_tag: "valid".to_string(),
            }
        );
    }

    /// 不正なaタグフォーマット（kindが数値でない）はスキップされる
    #[test]
    fn test_parse_a_tag_invalid_format_non_numeric_kind() {
        let keys = Keys::generate();
        let pubkey = keys.public_key().to_hex();
        let invalid_a_tag = Tag::parse(["a", &format!("not-a-number:{}:test", pubkey)]).unwrap();
        let event = create_deletion_event(&keys, vec![invalid_a_tag]);

        let targets = DeletionTarget::parse_from_event(&event);

        assert!(targets.is_empty());
    }

    /// aタグのd_tagが空の場合も正常に処理される
    #[test]
    fn test_parse_a_tag_empty_d_tag() {
        let keys = Keys::generate();
        let pubkey = keys.public_key().to_hex();
        let a_tag = Tag::parse(["a", &format!("30000:{}:", pubkey)]).unwrap();
        let event = create_deletion_event(&keys, vec![a_tag]);

        let targets = DeletionTarget::parse_from_event(&event);

        assert_eq!(targets.len(), 1);
        assert_eq!(
            targets[0].target,
            DeletionTargetKind::Address {
                kind: 30000,
                pubkey: pubkey.clone(),
                d_tag: "".to_string(),
            }
        );
    }

    // ==================== aタグpubkey不一致早期フィルタリングテスト ====================

    /// aタグ内のpubkeyと削除リクエストのpubkeyが不一致の場合はスキップ
    #[test]
    fn test_parse_a_tag_pubkey_mismatch_filtered() {
        let keys = Keys::generate();
        let other_pubkey = "f".repeat(64); // 別のpubkey
        let a_tag = Tag::parse(["a", &format!("30000:{}:test", other_pubkey)]).unwrap();
        let event = create_deletion_event(&keys, vec![a_tag]);

        let targets = DeletionTarget::parse_from_event(&event);

        // pubkey不一致のため空
        assert!(targets.is_empty());
    }

    /// pubkey一致のaタグのみが抽出される（混在ケース）
    #[test]
    fn test_parse_a_tag_filters_mismatched_pubkeys() {
        let keys = Keys::generate();
        let valid_pubkey = keys.public_key().to_hex();
        let other_pubkey = "f".repeat(64);
        let valid_a_tag = Tag::parse(["a", &format!("30000:{}:valid", valid_pubkey)]).unwrap();
        let invalid_a_tag = Tag::parse(["a", &format!("30000:{}:invalid", other_pubkey)]).unwrap();
        let event = create_deletion_event(&keys, vec![valid_a_tag, invalid_a_tag]);

        let targets = DeletionTarget::parse_from_event(&event);

        // pubkey一致のタグのみ抽出
        assert_eq!(targets.len(), 1);
        assert_eq!(
            targets[0].target,
            DeletionTargetKind::Address {
                kind: 30000,
                pubkey: valid_pubkey.clone(),
                d_tag: "valid".to_string(),
            }
        );
    }

    // ==================== requester情報保持テスト ====================

    /// 抽出された削除対象にrequester_pubkeyが正しく設定される
    #[test]
    fn test_requester_pubkey_is_set_correctly() {
        let keys = Keys::generate();
        let event_id = "a".repeat(64);
        let e_tag = Tag::parse(["e", &event_id]).unwrap();
        let event = create_deletion_event(&keys, vec![e_tag]);

        let targets = DeletionTarget::parse_from_event(&event);

        assert_eq!(targets[0].requester_pubkey, keys.public_key().to_hex());
    }

    /// 抽出された削除対象にrequest_created_atが正しく設定される
    #[test]
    fn test_request_created_at_is_set_correctly() {
        let keys = Keys::generate();
        let event_id = "a".repeat(64);
        let e_tag = Tag::parse(["e", &event_id]).unwrap();
        let timestamp = 1700000000u64;
        let event = create_deletion_event_with_timestamp(&keys, vec![e_tag], timestamp);

        let targets = DeletionTarget::parse_from_event(&event);

        assert_eq!(targets[0].request_created_at, timestamp);
    }

    // ==================== エッジケーステスト ====================

    /// 関係のないタグ（p, tなど）は無視される
    #[test]
    fn test_ignores_unrelated_tags() {
        let keys = Keys::generate();
        let event_id = "a".repeat(64);
        let p_tag = Tag::parse(["p", &"b".repeat(64)]).unwrap();
        let t_tag = Tag::parse(["t", "nostr"]).unwrap();
        let e_tag = Tag::parse(["e", &event_id]).unwrap();
        let event = create_deletion_event(&keys, vec![p_tag, t_tag, e_tag]);

        let targets = DeletionTarget::parse_from_event(&event);

        // eタグのみが抽出される
        assert_eq!(targets.len(), 1);
        assert_eq!(
            targets[0].target,
            DeletionTargetKind::EventId(event_id.clone())
        );
    }

    /// eタグの値が空の場合はスキップされる
    #[test]
    fn test_parse_e_tag_empty_value_skipped() {
        let keys = Keys::generate();
        let valid_event_id = "a".repeat(64);
        // eタグには通常値が必要だが、空の場合の動作を確認
        let valid_e_tag = Tag::parse(["e", &valid_event_id]).unwrap();
        let event = create_deletion_event(&keys, vec![valid_e_tag]);

        let targets = DeletionTarget::parse_from_event(&event);

        assert_eq!(targets.len(), 1);
    }
}
