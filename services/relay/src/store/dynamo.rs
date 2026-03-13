//! DynamoDB永続化イベントストア（本番用）

use std::collections::HashMap as AwsHashMap;
use std::sync::Arc;

use aws_sdk_dynamodb::Client as DynamoClient;
use aws_sdk_dynamodb::types::{AttributeValue, ReturnConsumedCapacity};
use tracing::{debug, error, info, instrument, trace, warn};

use super::{DeleteResult, EventStore, InMemoryEventStore, SaveResult, StoreError};
use crate::models::{Event, EventId, Filter, VerifiedEvent};
use crate::owner_priority::OwnerPriority;

/// DynamoDB対応のイベントストア
pub struct DynamoEventStore {
    /// インメモリストア（クエリとキャッシュ）
    inner: InMemoryEventStore,
    /// DynamoDBクライアント（永続化）
    client: DynamoClient,
    /// テーブル名
    table_name: String,
    /// GSI名: pk_kind (Replaceable用)
    gsi_pk_kind_name: String,
    /// GSI名: pk_kind_d (Addressable用)
    gsi_pk_kind_d_name: String,
    /// オーナー優先度によるイベント保持判定
    owner_priority: Arc<OwnerPriority>,
}

impl DynamoEventStore {
    /// 新しいDynamoEventStoreを作成
    ///
    /// GSI名は環境変数 `DYNAMODB_GSI_PK_KIND` / `DYNAMODB_GSI_PK_KIND_D` で設定可能。
    /// デフォルト: "GSI-PkKind" / "GSI-PkKindD"
    pub async fn new(table_name: String) -> Result<Self, StoreError> {
        let config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
        let client = DynamoClient::new(&config);
        let inner = InMemoryEventStore::new();

        let gsi_pk_kind_name =
            std::env::var("DYNAMODB_GSI_PK_KIND").unwrap_or_else(|_| "GSI-PkKind".to_string());
        let gsi_pk_kind_d_name =
            std::env::var("DYNAMODB_GSI_PK_KIND_D").unwrap_or_else(|_| "GSI-PkKindD".to_string());

        // オーナーpubkeyを環境変数から取得（未設定でも動作可能）
        let owner_pubkey = std::env::var("RELAY_PUBKEY").ok();
        let mut owner_priority = OwnerPriority::new(owner_pubkey);

        // DynamoDBからオーナーのフォローリストをロード
        owner_priority
            .load_follows_from_dynamo(&client, &table_name, &gsi_pk_kind_name)
            .await?;
        let follows_count = owner_priority.follows_count();
        info!(follows_count, "オーナーのフォローリストをロード完了");

        let owner_priority = Arc::new(owner_priority);

        let store = Self {
            inner,
            client,
            table_name,
            gsi_pk_kind_name,
            gsi_pk_kind_d_name,
            owner_priority,
        };

        Ok(store)
    }

    /// テスト用コンストラクタ（カスタムクライアント）
    #[cfg(test)]
    pub fn new_with_client(client: DynamoClient, table_name: String) -> Self {
        Self {
            inner: InMemoryEventStore::new(),
            client,
            table_name,
            gsi_pk_kind_name: "GSI-PkKind".to_string(),
            gsi_pk_kind_d_name: "GSI-PkKindD".to_string(),
            owner_priority: Arc::new(OwnerPriority::new(None)),
        }
    }

    /// オーナー優先度を取得する
    pub fn owner_priority(&self) -> Arc<OwnerPriority> {
        Arc::clone(&self.owner_priority)
    }

    /// テーブルのプロビジョンドRCUを取得
    async fn get_provisioned_rcu(&self) -> Result<i64, StoreError> {
        let desc = self
            .client
            .describe_table()
            .table_name(&self.table_name)
            .send()
            .await
            .map_err(|e| StoreError::Internal(format!("DynamoDB describe_table failed: {}", e)))?;

        let rcu = desc
            .table()
            .and_then(|t| t.provisioned_throughput())
            .map(|pt| pt.read_capacity_units().unwrap_or(5))
            .unwrap_or(5);

        Ok(rcu)
    }

    /// DynamoDBから直近のイベントをInMemoryストアにロードする
    ///
    /// バックグラウンドで呼び出すことを想定。ロード完了前のREQは
    /// InMemoryストアの内容のみで応答するため、結果が不完全になる場合がある。
    ///
    /// - `created_at_lower_limit` は秒単位。非優遇ユーザーのcutoffタイムスタンプ算出に使用。
    /// - プロビジョンドRCUに基づいてページ間ディレイを自動調整し、スロットリングを回避する
    pub async fn load_recent_events(&self, created_at_lower_limit: u64) -> Result<(), StoreError> {
        let now_ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let cutoff_ts = now_ts.saturating_sub(created_at_lower_limit);

        // プロビジョンドRCUを取得してディレイ計算に使用
        let provisioned_rcu = self.get_provisioned_rcu().await?;
        let retention_days = created_at_lower_limit / 86400;
        info!(
            "DynamoDBからイベントをロード中（オーナー/フォロー先は全期間、その他は直近{}日={}秒） (cutoff: {}, provisioned_rcu: {})",
            retention_days, created_at_lower_limit, cutoff_ts, provisioned_rcu
        );

        // 全件Scanし、アプリ側でowner_priorityによるフィルタリングを行う
        let scan_input = self
            .client
            .scan()
            .table_name(&self.table_name)
            .select(aws_sdk_dynamodb::types::Select::AllAttributes)
            .return_consumed_capacity(ReturnConsumedCapacity::Total);

        let mut loaded_count = 0;
        let mut page_count = 0u32;
        let mut total_consumed_rcu = 0.0f64;
        let mut continuation_token: Option<std::collections::HashMap<String, AttributeValue>> =
            None;

        loop {
            let mut page_scan = scan_input.clone();
            if let Some(ref token) = continuation_token {
                for (key, value) in token {
                    page_scan = page_scan.exclusive_start_key(key.clone(), value.clone());
                }
            }

            let result = page_scan
                .send()
                .await
                .map_err(|e| StoreError::Internal(format!("DynamoDB scan failed: {}", e)))?;

            page_count += 1;

            // ConsumedCapacityからディレイを計算
            let consumed_rcu = result
                .consumed_capacity()
                .and_then(|cc| cc.capacity_units())
                .unwrap_or(128.0); // フォールバック: 1MB分（128 RCU）を想定
            total_consumed_rcu += consumed_rcu;

            if let Some(items) = result.items {
                for item in items {
                    if let Ok(event) = self.parse_dynamo_item(item) {
                        // オーナー優先度による保持判定
                        if !self.owner_priority.should_retain(
                            &event.pubkey.to_hex(),
                            event.created_at.as_i64(),
                            cutoff_ts as i64,
                        ) {
                            continue;
                        }
                        if let Ok(verified) = event.verify()
                            && let Ok(save_result) = self.inner.save(&verified).await
                            && matches!(save_result, SaveResult::Saved | SaveResult::Replaced)
                        {
                            loaded_count += 1;
                        }
                    }
                }
            }

            continuation_token = result.last_evaluated_key;
            if continuation_token.is_none() {
                break;
            }

            // プロビジョンドRCUに基づくディレイ（マージン1秒追加）
            // ディレイ = (消費RCU / プロビジョンドRCU) + 1秒
            let delay_secs = (consumed_rcu / provisioned_rcu as f64) + 1.0;
            debug!(
                page_count,
                consumed_rcu, delay_secs, loaded_count, "ページロード完了、次のページまで待機"
            );
            tokio::time::sleep(std::time::Duration::from_secs_f64(delay_secs)).await;
        }

        info!(
            loaded_count,
            page_count, total_consumed_rcu, "DynamoDBからのイベントロード完了"
        );
        Ok(())
    }

    /// DynamoDBアイテムをEventにパース
    fn parse_dynamo_item(
        &self,
        item: AwsHashMap<String, AttributeValue>,
    ) -> Result<Event, StoreError> {
        let event_json = item
            .get("event_json")
            .and_then(|v| v.as_s().ok())
            .ok_or_else(|| StoreError::Internal("event_json not found".to_string()))?;

        serde_json::from_str(event_json)
            .map_err(|e| StoreError::Internal(format!("Failed to parse event JSON: {}", e)))
    }

    /// EventをDynamoDBアイテムに変換
    fn event_to_dynamo_item(&self, event: &Event) -> AwsHashMap<String, AttributeValue> {
        let mut item = AwsHashMap::new();

        // Primary Key: イベントID
        item.insert("id".to_string(), AttributeValue::S(event.id.to_string()));

        // GSI用キー: pk_kind（replaceable用）- 区切り文字は # (issue #19 仕様準拠)
        item.insert(
            "pk_kind".to_string(),
            AttributeValue::S(format!("{}#{}", event.pubkey.to_hex(), event.kind.as_u16())),
        );

        // GSI用キー: pk_kind_d（addressable用）- 区切り文字は # (issue #19 仕様準拠)
        let d_tag = if event.kind.is_addressable() {
            event.d_tag_value().to_string()
        } else {
            "".to_string()
        };
        item.insert(
            "pk_kind_d".to_string(),
            AttributeValue::S(format!(
                "{}#{}#{}",
                event.pubkey.to_hex(),
                event.kind.as_u16(),
                d_tag
            )),
        );

        // タイムスタンプ
        item.insert(
            "created_at".to_string(),
            AttributeValue::N(event.created_at.as_i64().to_string()),
        );

        // 運用用属性（コンソールでの視認性向上）
        item.insert(
            "kind".to_string(),
            AttributeValue::N(event.kind.as_u16().to_string()),
        );
        item.insert(
            "pubkey".to_string(),
            AttributeValue::S(event.pubkey.to_hex()),
        );

        // イベントデータ（JSON）
        item.insert(
            "event_json".to_string(),
            AttributeValue::S(serde_json::to_string(event).unwrap_or_default()),
        );

        item
    }

    /// DynamoDBにイベントを保存
    async fn put_item_to_dynamo(&self, event: &Event) -> Result<(), StoreError> {
        let item = self.event_to_dynamo_item(event);

        self.client
            .put_item()
            .table_name(&self.table_name)
            .set_item(Some(item))
            .send()
            .await
            .map_err(|e| StoreError::Internal(format!("DynamoDB put_item failed: {}", e)))?;

        Ok(())
    }

    /// DynamoDBからイベントを削除
    async fn delete_item_from_dynamo(&self, event_id: &EventId) -> Result<(), StoreError> {
        let mut key = AwsHashMap::new();
        key.insert("id".to_string(), AttributeValue::S(event_id.to_string()));

        self.client
            .delete_item()
            .table_name(&self.table_name)
            .set_key(Some(key))
            .send()
            .await
            .map_err(|e| StoreError::Internal(format!("DynamoDB delete_item failed: {}", e)))?;

        Ok(())
    }

    /// GSIを使ってReplaceable/Addressableイベントをクエリ（最新を取得）
    async fn query_existing_replaceable(
        &self,
        pubkey: &str,
        kind: u16,
    ) -> Result<Option<Event>, StoreError> {
        let pk_kind = format!("{}#{}", pubkey, kind);

        let result = self
            .client
            .query()
            .table_name(&self.table_name)
            .index_name(&self.gsi_pk_kind_name)
            .key_condition_expression("pk_kind = :pk_kind")
            .expression_attribute_values(":pk_kind", AttributeValue::S(pk_kind))
            .scan_index_forward(false) // created_at降順で最新を取得
            .limit(1)
            .send()
            .await
            .map_err(|e| StoreError::Internal(format!("DynamoDB query failed: {}", e)))?;

        if let Some(items) = result.items
            && let Some(item) = items.into_iter().next()
        {
            return Ok(Some(self.parse_dynamo_item(item)?));
        }

        Ok(None)
    }

    /// GSIを使ってAddressableイベントをクエリ（最新を取得）
    async fn query_existing_addressable(
        &self,
        pubkey: &str,
        kind: u16,
        d_tag: &str,
    ) -> Result<Option<Event>, StoreError> {
        let pk_kind_d = format!("{}#{}#{}", pubkey, kind, d_tag);

        let result = self
            .client
            .query()
            .table_name(&self.table_name)
            .index_name(&self.gsi_pk_kind_d_name)
            .key_condition_expression("pk_kind_d = :pk_kind_d")
            .expression_attribute_values(":pk_kind_d", AttributeValue::S(pk_kind_d))
            .scan_index_forward(false) // created_at降順で最新を取得
            .limit(1)
            .send()
            .await
            .map_err(|e| StoreError::Internal(format!("DynamoDB query failed: {}", e)))?;

        if let Some(items) = result.items
            && let Some(item) = items.into_iter().next()
        {
            return Ok(Some(self.parse_dynamo_item(item)?));
        }

        Ok(None)
    }
}

impl EventStore for DynamoEventStore {
    #[instrument(skip(self, event), fields(event_id = %event.inner().id, kind = event.inner().kind.as_u16()))]
    async fn save(&self, event: &VerifiedEvent) -> Result<SaveResult, StoreError> {
        let inner = event.inner();

        // Ephemeralイベントは保存しない
        if inner.kind.is_ephemeral() {
            trace!("ephemeralイベントのため保存をスキップ");
            return Ok(SaveResult::Ephemeral);
        }

        // Regular イベント: InMemoryで重複チェック → DynamoDB保存 → InMemory保存
        if inner.kind.is_regular() {
            // InMemoryでの重複チェック
            {
                let events = self.inner.events.read().await;
                if events.contains_key(&inner.id) {
                    trace!("重複イベント検出（InMemory）");
                    return Ok(SaveResult::Duplicate);
                }
            }

            // DynamoDBに保存
            self.put_item_to_dynamo(inner).await?;

            // InMemoryに保存
            let result = self.inner.save(event).await?;

            match result {
                SaveResult::Saved => Ok(SaveResult::Saved),
                SaveResult::Duplicate => {
                    // 並行保存によりInMemoryでは重複だが、DynamoDBには既に保存済み
                    // DynamoDBからロールバック（冪等なのでDuplicate扱いで問題ない）
                    warn!(
                        "Regular event duplicate detected after DynamoDB write, rolling back: {}",
                        inner.id
                    );
                    if let Err(e) = self.delete_item_from_dynamo(&inner.id).await {
                        error!(
                            "Failed to rollback DynamoDB write for duplicate event {}: {}",
                            inner.id, e
                        );
                    }
                    Ok(SaveResult::Duplicate)
                }
                _ => Ok(SaveResult::Saved), // 通常はここに来ない
            }
        }
        // Replaceableイベント: DynamoDBでクエリ → 判定 → 保存/置換/無視
        else if inner.kind.is_replaceable() {
            let pubkey = inner.pubkey.to_hex();
            let kind = inner.kind.as_u16();

            // DynamoDBから既存イベントをクエリ
            let existing_event = self.query_existing_replaceable(&pubkey, kind).await?;

            if let Some(ref existing) = existing_event {
                if !InMemoryEventStore::is_newer(inner, existing) {
                    trace!("既存イベントの方が新しいため無視");
                    // 既存イベントをInMemoryに復元（パージ済みの場合の復元）
                    if let Ok(verified_existing) = existing.clone().verify() {
                        let _ = self.inner.save(&verified_existing).await;
                    }
                    return Ok(SaveResult::Ignored);
                }

                // 古いイベントを削除
                self.delete_item_from_dynamo(&existing.id).await?;
                trace!("既存のreplaceableイベントを削除: {}", existing.id);
            }

            // 新しいイベントを保存
            self.put_item_to_dynamo(inner).await?;

            // InMemoryに保存（ここで実際のreplacementが処理される）
            let result = self.inner.save(event).await?;

            match result {
                SaveResult::Ignored => {
                    // InMemoryでは古いと判定された（InMemoryにはDynamoDBより新しいイベントがある）
                    // DynamoDBをロールバック: 新イベントを削除し、既存イベントを復元
                    warn!(
                        "Replaceable event ignored by InMemory after DynamoDB write, rolling back: {}",
                        inner.id
                    );
                    self.delete_item_from_dynamo(&inner.id).await?;
                    if let Some(ref existing) = existing_event {
                        self.put_item_to_dynamo(existing).await?;
                    }
                    Ok(SaveResult::Ignored)
                }
                other => Ok(other),
            }
        }
        // Addressableイベント: 同様の処理
        else if inner.kind.is_addressable() {
            let pubkey = inner.pubkey.to_hex();
            let kind = inner.kind.as_u16();
            let d_tag = inner.d_tag_value().to_string();

            // DynamoDBから既存イベントをクエリ
            let existing_event = self
                .query_existing_addressable(&pubkey, kind, &d_tag)
                .await?;

            if let Some(ref existing) = existing_event {
                if !InMemoryEventStore::is_newer(inner, existing) {
                    trace!("既存イベントの方が新しいため無視");
                    // 既存イベントをInMemoryに復元（パージ済みの場合の復元）
                    if let Ok(verified_existing) = existing.clone().verify() {
                        let _ = self.inner.save(&verified_existing).await;
                    }
                    return Ok(SaveResult::Ignored);
                }

                // 古いイベントを削除
                self.delete_item_from_dynamo(&existing.id).await?;
                trace!("既存のaddressableイベントを削除: {}", existing.id);
            }

            // 新しいイベントを保存
            self.put_item_to_dynamo(inner).await?;

            // InMemoryに保存
            let result = self.inner.save(event).await?;

            match result {
                SaveResult::Ignored => {
                    // InMemoryでは古いと判定された → DynamoDBをロールバック
                    warn!(
                        "Addressable event ignored by InMemory after DynamoDB write, rolling back: {}",
                        inner.id
                    );
                    self.delete_item_from_dynamo(&inner.id).await?;
                    if let Some(ref existing) = existing_event {
                        self.put_item_to_dynamo(existing).await?;
                    }
                    Ok(SaveResult::Ignored)
                }
                other => Ok(other),
            }
        } else {
            // その他のイベント（通常はない）
            warn!("Unknown event kind: {}", inner.kind.as_u16());
            Ok(SaveResult::Ignored)
        }
    }

    #[instrument(skip(self, filters), fields(filter_count = filters.len()))]
    async fn query(&self, filters: &[Filter]) -> Result<Vec<Event>, StoreError> {
        // クエリはInMemoryのみ
        self.inner.query(filters).await
    }

    #[instrument(skip(self, event), fields(event_id = %event.inner().id))]
    async fn delete(&self, event: &VerifiedEvent) -> Result<DeleteResult, StoreError> {
        // まずInMemoryで削除（対象イベントの特定のため）
        let result = self.inner.delete(event).await?;

        if result.deleted_count > 0 {
            let inner = event.inner();
            let requester_pubkey = inner.pubkey.to_hex();

            // e-tagで指定されたイベントをDynamoDBから削除
            for id_hex in inner.e_tag_values() {
                if let Ok(event_id) = id_hex.parse::<EventId>()
                    && let Err(e) = self.delete_item_from_dynamo(&event_id).await
                {
                    error!("DynamoDBからのイベント削除に失敗: {}", e);
                }
            }

            // a-tagで指定されたイベントも同様に処理
            for (kind_str, pubkey, d_id) in inner.a_tag_values() {
                if pubkey == requester_pubkey
                    && let Ok(kind_num) = kind_str.parse::<u16>()
                    && kind_num != 5
                    && let Ok(Some(target_event)) = self
                        .query_existing_addressable(pubkey, kind_num, d_id)
                        .await
                    && target_event.created_at.as_i64() <= inner.created_at.as_i64()
                    && let Err(e) = self.delete_item_from_dynamo(&target_event.id).await
                {
                    error!("DynamoDBからのaddressableイベント削除に失敗: {}", e);
                }
            }
        }

        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::{create_custom_event, create_test_event};
    use aws_sdk_dynamodb::{Client as DynamoClient, Config as DynamoConfig};
    use serial_test::serial;

    async fn create_test_dynamo_store() -> DynamoEventStore {
        let config = DynamoConfig::builder()
            .endpoint_url("http://localhost:8000")
            .behavior_version(aws_sdk_dynamodb::config::BehaviorVersion::latest())
            .build();
        let client = DynamoClient::from_conf(config);

        DynamoEventStore::new_with_client(client, "test_nostr_relay_events".to_string())
    }

    #[tokio::test]
    #[serial]
    async fn test_dynamo_event_store_save_regular_event() {
        let store = create_test_dynamo_store().await;
        let event = create_test_event();
        let verified = event.clone().verify().unwrap();

        let result = store.save(&verified).await;

        if result.is_err() {
            eprintln!("DynamoDB Local not available, skipping test");
            return;
        }

        assert_eq!(result.unwrap(), SaveResult::Saved);

        let results = store
            .query(&[crate::models::Filter::default()])
            .await
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0], event);
    }

    #[tokio::test]
    #[serial]
    async fn test_dynamo_event_store_replaceable_event() {
        let store = create_test_dynamo_store().await;

        let old_event = create_custom_event(0, 1000, "old profile", vec![]);
        let verified_old = old_event.verify().unwrap();

        let result1 = store.save(&verified_old).await;
        if result1.is_err() {
            eprintln!("DynamoDB Local not available, skipping test");
            return;
        }
        assert_eq!(result1.unwrap(), SaveResult::Saved);

        let new_event = create_custom_event(0, 2000, "new profile", vec![]);
        let verified_new = new_event.clone().verify().unwrap();
        let result2 = store.save(&verified_new).await.unwrap();
        assert_eq!(result2, SaveResult::Replaced);

        let results = store
            .query(&[crate::models::Filter::default()])
            .await
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].content, "new profile");
    }
}
