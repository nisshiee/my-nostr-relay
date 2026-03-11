//! オーナー優先度によるイベント保持判定
//!
//! リレーオーナーとそのフォロー先のイベントは期間制限なく保持し、
//! それ以外のイベントはcutoffタイムスタンプ以降のみ保持する。

use std::collections::HashSet;

/// オーナー優先度によるイベント保持判定
pub struct OwnerPriority {
    /// オーナーのpubkey（hex文字列）。Noneの場合は全イベントがcutoffフィルタ対象
    owner_pubkey: Option<String>,
    /// オーナーのフォロー先pubkeyセット（hex文字列）
    follows: HashSet<String>,
}

impl OwnerPriority {
    /// 新しいOwnerPriorityを作成する。followsは空で初期化される。
    pub fn new(owner_pubkey: Option<String>) -> Self {
        Self {
            owner_pubkey,
            follows: HashSet::new(),
        }
    }

    /// フォロー先の数を返す
    pub fn follows_count(&self) -> usize {
        self.follows.len()
    }

    /// イベントを保持すべきかどうかを判定する
    ///
    /// - owner_pubkeyがNone → created_at >= cutoff_ts で判定
    /// - pubkeyがオーナー本人 → 全期間保持
    /// - pubkeyがフォロー先 → 全期間保持
    /// - それ以外 → created_at >= cutoff_ts で判定
    pub fn should_retain(&self, pubkey: &str, created_at: i64, cutoff_ts: i64) -> bool {
        match &self.owner_pubkey {
            None => created_at >= cutoff_ts,
            Some(owner) => {
                if pubkey == owner {
                    return true;
                }
                if self.follows.contains(pubkey) {
                    return true;
                }
                created_at >= cutoff_ts
            }
        }
    }

    /// DynamoDBからオーナーのフォローリスト（kind 3）を読み込む
    ///
    /// GSI `pk_kind` を使って `<owner_pubkey>#3` でQueryし、最新1件を取得。
    /// `event_json` をパースして `p` タグからフォロー先pubkeyセットを構築する。
    #[cfg(feature = "dynamo")]
    pub async fn load_follows_from_dynamo(
        &mut self,
        client: &aws_sdk_dynamodb::Client,
        table_name: &str,
        gsi_name: &str,
    ) -> Result<(), crate::store::StoreError> {
        let owner_pubkey = match &self.owner_pubkey {
            Some(pk) => pk,
            None => return Ok(()), // owner_pubkeyがNoneの場合は何もしない
        };

        let pk_kind_value = format!("{}#3", owner_pubkey);

        let result = client
            .query()
            .table_name(table_name)
            .index_name(gsi_name)
            .key_condition_expression("pk_kind = :pk_kind")
            .expression_attribute_values(
                ":pk_kind",
                aws_sdk_dynamodb::types::AttributeValue::S(pk_kind_value),
            )
            .scan_index_forward(false) // created_at降順で最新を取得
            .limit(1)
            .send()
            .await
            .map_err(|e| crate::store::StoreError::Internal(format!("DynamoDB Query失敗: {e}")))?;

        let items = result.items();
        if items.is_empty() {
            // kind 3が見つからない場合はfollowsを空のままにする
            return Ok(());
        }

        let item = &items[0];
        let event_json = item
            .get("event_json")
            .and_then(|v| v.as_s().ok())
            .ok_or_else(|| {
                crate::store::StoreError::Internal("event_jsonが見つからない".to_string())
            })?;

        let event: crate::models::Event = serde_json::from_str(event_json).map_err(|e| {
            crate::store::StoreError::Internal(format!("event_jsonのパース失敗: {e}"))
        })?;

        // pタグからフォロー先pubkeyを収集
        self.follows = event
            .tags
            .iter()
            .filter(|tag| tag.name() == "p")
            .filter_map(|tag| tag.value().map(|v| v.to_string()))
            .collect();

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER_PK: &str = "owner_pubkey_hex";
    const FOLLOW_PK: &str = "follow_pubkey_hex";
    const OTHER_PK: &str = "other_pubkey_hex";
    const CUTOFF: i64 = 1000;

    /// オーナー優先度を作成し、フォロー先を設定するヘルパー
    fn create_with_follows() -> OwnerPriority {
        let mut op = OwnerPriority::new(Some(OWNER_PK.to_string()));
        op.follows.insert(FOLLOW_PK.to_string());
        op
    }

    #[test]
    fn test_owner_event_retained_before_cutoff() {
        // オーナー本人のイベントはcutoff以前でも保持
        let op = create_with_follows();
        assert!(op.should_retain(OWNER_PK, CUTOFF - 500, CUTOFF));
    }

    #[test]
    fn test_owner_event_retained_after_cutoff() {
        // オーナー本人のイベントはcutoff以降も保持
        let op = create_with_follows();
        assert!(op.should_retain(OWNER_PK, CUTOFF + 500, CUTOFF));
    }

    #[test]
    fn test_follow_event_retained_before_cutoff() {
        // フォロー先のイベントはcutoff以前でも保持
        let op = create_with_follows();
        assert!(op.should_retain(FOLLOW_PK, CUTOFF - 500, CUTOFF));
    }

    #[test]
    fn test_follow_event_retained_after_cutoff() {
        // フォロー先のイベントはcutoff以降も保持
        let op = create_with_follows();
        assert!(op.should_retain(FOLLOW_PK, CUTOFF + 500, CUTOFF));
    }

    #[test]
    fn test_other_event_rejected_before_cutoff() {
        // それ以外のイベントはcutoff以前は保持しない
        let op = create_with_follows();
        assert!(!op.should_retain(OTHER_PK, CUTOFF - 1, CUTOFF));
    }

    #[test]
    fn test_other_event_retained_at_cutoff() {
        // それ以外のイベントはcutoffちょうどなら保持
        let op = create_with_follows();
        assert!(op.should_retain(OTHER_PK, CUTOFF, CUTOFF));
    }

    #[test]
    fn test_other_event_retained_after_cutoff() {
        // それ以外のイベントはcutoff以降は保持
        let op = create_with_follows();
        assert!(op.should_retain(OTHER_PK, CUTOFF + 500, CUTOFF));
    }

    #[test]
    fn test_none_owner_uses_cutoff_for_all() {
        // owner_pubkeyがNoneの場合は全イベントがcutoffで判定される
        let op = OwnerPriority::new(None);
        assert!(!op.should_retain(OWNER_PK, CUTOFF - 1, CUTOFF));
        assert!(op.should_retain(OWNER_PK, CUTOFF, CUTOFF));
        assert!(op.should_retain(OWNER_PK, CUTOFF + 500, CUTOFF));
    }
}
