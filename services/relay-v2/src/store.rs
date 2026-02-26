//! イベントストレージの抽象化

use std::collections::HashMap;
use std::time::Instant;

use tokio::sync::RwLock;
#[cfg(feature = "dynamo")]
use tracing::{debug, instrument, trace, warn, error};

#[cfg(not(feature = "dynamo"))]
use tracing::{debug, instrument, trace};


use crate::models::{Event, EventId, Filter, VerifiedEvent};

// DynamoDB関連のimport (dynamo feature有効時のみ)
#[cfg(feature = "dynamo")]
use aws_sdk_dynamodb::Client as DynamoClient;
#[cfg(feature = "dynamo")]
use aws_sdk_dynamodb::types::AttributeValue;
#[cfg(feature = "dynamo")]
use std::collections::HashMap as AwsHashMap;

/// イベント保存の結果
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SaveResult {
    /// 保存成功（新規イベント）
    Saved,
    /// 重複イベント（既に存在）
    Duplicate,
    /// 無視（Replaceable/Addressable で古いイベント）
    Ignored,
    /// Ephemeral イベント（保存せず配信のみ）
    Ephemeral,
    /// 置換（既存イベントを上書き）
    Replaced,
}

/// 削除処理の結果
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeleteResult {
    /// 削除されたイベント数
    pub deleted_count: usize,
}

/// ストレージエラー
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StoreError {
    /// 内部エラー
    #[allow(dead_code)]
    #[error("内部エラー: {0}")]
    Internal(String),
}

/// イベントストレージの抽象インターフェース
///
/// in-memory から DynamoDB 等への移行を可能にする
// static dispatch のみで使用するため、dyn 互換性は不要
#[allow(async_fn_in_trait)]
pub trait EventStore: Send + Sync {
    /// イベントを保存
    async fn save(&self, event: &VerifiedEvent) -> Result<SaveResult, StoreError>;

    /// フィルターにマッチするイベントを検索
    async fn query(&self, filters: &[Filter]) -> Result<Vec<Event>, StoreError>;

    /// 削除リクエスト(kind 5)を処理し、参照されたイベントを削除
    async fn delete(&self, event: &VerifiedEvent) -> Result<DeleteResult, StoreError>;
}

/// インメモリイベントストア（開発・テスト用）
pub struct InMemoryEventStore {
    /// イベントID -> イベント
    events: RwLock<HashMap<EventId, Event>>,
    /// Replaceable: (pubkey_hex, kind) -> EventId
    replaceable_index: RwLock<HashMap<(String, u16), EventId>>,
    /// Addressable: (pubkey_hex, kind, d_tag) -> EventId
    addressable_index: RwLock<HashMap<(String, u16, String), EventId>>,
}

impl InMemoryEventStore {
    /// 新しい空のインメモリストアを作成
    pub fn new() -> Self {
        Self {
            events: RwLock::new(HashMap::new()),
            replaceable_index: RwLock::new(HashMap::new()),
            addressable_index: RwLock::new(HashMap::new()),
        }
    }

    /// イベントが既存イベントより新しいかどうかを判定
    /// 同タイムスタンプの場合は ID が小さい方を保持（新イベントの ID が小さければ新しいと見なす）
    fn is_newer(new_event: &Event, existing: &Event) -> bool {
        let new_ts = new_event.created_at.as_i64();
        let existing_ts = existing.created_at.as_i64();

        match new_ts.cmp(&existing_ts) {
            std::cmp::Ordering::Greater => true,
            std::cmp::Ordering::Less => false,
            std::cmp::Ordering::Equal => {
                // 同タイムスタンプ時: ID が小さい方を保持
                new_event.id.to_string() < existing.id.to_string()
            }
        }
    }
}

impl Default for InMemoryEventStore {
    fn default() -> Self {
        Self::new()
    }
}

impl EventStore for InMemoryEventStore {
    #[instrument(skip(self, event), fields(event_id = %event.inner().id, kind = event.inner().kind.as_u16()))]
    async fn save(&self, event: &VerifiedEvent) -> Result<SaveResult, StoreError> {
        let inner = event.inner();

        // Ephemeral イベントは保存しない
        if inner.kind.is_ephemeral() {
            trace!("ephemeralイベントのため保存をスキップ");
            return Ok(SaveResult::Ignored);
        }

        // 重複チェック
        {
            let events = self.events.read().await;
            if events.contains_key(&inner.id) {
                trace!("重複イベント検出");
                return Ok(SaveResult::Duplicate);
            }
        }

        // Replaceable イベント処理
        if inner.kind.is_replaceable() {
            trace!("replaceableイベントとして処理");
            return self.save_replaceable(inner).await;
        }

        // Addressable イベント処理
        if inner.kind.is_addressable() {
            trace!("addressableイベントとして処理");
            return self.save_addressable(inner).await;
        }

        // Regular イベント：単純に保存
        trace!("regularイベントとして保存");
        let mut events = self.events.write().await;
        events.insert(inner.id, inner.clone());
        Ok(SaveResult::Saved)
    }

    #[instrument(skip(self, filters), fields(filter_count = filters.len()))]
    async fn query(&self, filters: &[Filter]) -> Result<Vec<Event>, StoreError> {
        use std::collections::HashSet;

        let start = Instant::now();
        let events = self.events.read().await;

        // 各フィルターごとにマッチ・limit適用し、結果をマージ（NIP-01: フィルター間はOR）
        let mut seen_ids = HashSet::new();
        let mut merged: Vec<Event> = Vec::new();

        for filter in filters {
            let mut filter_matched: Vec<Event> = events
                .values()
                .filter(|e| filter.matches(e))
                .cloned()
                .collect();

            // ソート: created_at 降順、同タイムスタンプは event ID 昇順
            filter_matched.sort_by(|a, b| {
                match b.created_at.as_i64().cmp(&a.created_at.as_i64()) {
                    std::cmp::Ordering::Equal => a.id.to_string().cmp(&b.id.to_string()),
                    other => other,
                }
            });

            // フィルターごとのlimit適用
            if let Some(limit) = filter.limit {
                filter_matched.truncate(limit as usize);
            }

            // 重複排除してマージ
            for event in filter_matched {
                if seen_ids.insert(event.id) {
                    merged.push(event);
                }
            }
        }

        // 最終ソート（マージ後）
        merged.sort_by(|a, b| {
            match b.created_at.as_i64().cmp(&a.created_at.as_i64()) {
                std::cmp::Ordering::Equal => a.id.to_string().cmp(&b.id.to_string()),
                other => other,
            }
        });

        debug!(
            total_events = events.len(),
            result_count = merged.len(),
            elapsed_ms = start.elapsed().as_millis(),
            "ストアクエリ完了"
        );
        Ok(merged)
    }

    #[instrument(skip(self, event), fields(event_id = %event.inner().id))]
    async fn delete(&self, event: &VerifiedEvent) -> Result<DeleteResult, StoreError> {
        let inner = event.inner();
        let requester_pubkey = inner.pubkey.to_hex();
        let mut deleted_count = 0;

        // ロック取得前にタグ値を収集
        let e_tag_ids: Vec<String> = inner.e_tag_values().iter().map(|s| s.to_string()).collect();
        let a_tag_values: Vec<(String, String, String)> = inner
            .a_tag_values()
            .iter()
            .map(|(k, p, d)| (k.to_string(), p.to_string(), d.to_string()))
            .collect();

        // e-tag処理とa-tag処理間のrace conditionを防ぐため、全ロックを一括取得
        let mut events = self.events.write().await;
        let mut replaceable_index = self.replaceable_index.write().await;
        let mut addressable_index = self.addressable_index.write().await;

        // e-tag処理: イベントIDで削除
        for id_hex in &e_tag_ids {
            if let Ok(event_id) = id_hex.parse::<EventId>() {
                if let Some(target) = events.get(&event_id) {
                    // 同一pubkeyチェック
                    if target.pubkey.to_hex() != requester_pubkey {
                        continue;
                    }
                    // kind-5イベントは削除しない
                    if target.kind.is_deletion_request() {
                        continue;
                    }
                    // インデックスから削除
                    if target.kind.is_replaceable() {
                        let key = (target.pubkey.to_hex(), target.kind.as_u16());
                        replaceable_index.remove(&key);
                    }
                    if target.kind.is_addressable() {
                        let d_tag = target.d_tag_value().to_string();
                        let key = (target.pubkey.to_hex(), target.kind.as_u16(), d_tag);
                        addressable_index.remove(&key);
                    }
                    events.remove(&event_id);
                    deleted_count += 1;
                }
            }
        }

        // a-tag処理: kind:pubkey:d-identifier でaddressableイベントを削除
        // NOTE: 現在はaddressable_index（最新版のみ）を参照している。InMemoryStoreでは最新版のみ
        // 保持しているため問題ないが、将来DB実装する際はNIP-09仕様に従い全バージョンを削除する必要がある。
        for (kind_str, pubkey, d_id) in &a_tag_values {
            // 削除リクエスト送信者のpubkeyと一致する必要がある
            if pubkey != &requester_pubkey {
                continue;
            }
            if let Ok(kind_num) = kind_str.parse::<u16>() {
                // kind-5は削除しない
                if kind_num == 5 {
                    continue;
                }
                let key = (pubkey.clone(), kind_num, d_id.clone());
                if let Some(existing_id) = addressable_index.get(&key).copied() {
                    if let Some(existing) = events.get(&existing_id) {
                        // 削除リクエストのcreated_at以前のイベントのみ削除
                        if existing.created_at.as_i64() <= inner.created_at.as_i64() {
                            events.remove(&existing_id);
                            addressable_index.remove(&key);
                            deleted_count += 1;
                        }
                    }
                }
            }
        }

        debug!(deleted_count, "削除処理完了");
        Ok(DeleteResult { deleted_count })
    }
}

impl InMemoryEventStore {
    /// Replaceable イベントの保存処理
    async fn save_replaceable(&self, event: &Event) -> Result<SaveResult, StoreError> {
        let key = (event.pubkey.to_hex(), event.kind.as_u16());

        let mut events = self.events.write().await;
        let mut replaceable_index = self.replaceable_index.write().await;

        let mut replaced = false;
        if let Some(existing_id) = replaceable_index.get(&key).copied() {
            if let Some(existing) = events.get(&existing_id)
                && !Self::is_newer(event, existing)
            {
                // 既存イベントの方が新しい（または同等）ので無視
                return Ok(SaveResult::Ignored);
            }
            // 既存イベントを削除
            events.remove(&existing_id);
            replaced = true;
        }

        // 新イベントを保存
        events.insert(event.id, event.clone());
        replaceable_index.insert(key, event.id);

        if replaced {
            Ok(SaveResult::Replaced)
        } else {
            Ok(SaveResult::Saved)
        }
    }

    /// Addressable イベントの保存処理
    async fn save_addressable(&self, event: &Event) -> Result<SaveResult, StoreError> {
        let d_tag = event.d_tag_value().to_string();
        let key = (event.pubkey.to_hex(), event.kind.as_u16(), d_tag);

        let mut events = self.events.write().await;
        let mut addressable_index = self.addressable_index.write().await;

        let mut replaced = false;
        if let Some(existing_id) = addressable_index.get(&key).copied() {
            if let Some(existing) = events.get(&existing_id)
                && !Self::is_newer(event, existing)
            {
                // 既存イベントの方が新しい（または同等）ので無視
                return Ok(SaveResult::Ignored);
            }
            // 既存イベントを削除
            events.remove(&existing_id);
            replaced = true;
        }

        // 新イベントを保存
        events.insert(event.id, event.clone());
        addressable_index.insert(key, event.id);

        if replaced {
            Ok(SaveResult::Replaced)
        } else {
            Ok(SaveResult::Saved)
        }
    }
}

/// DynamoDB対応のイベントストア (dynamo feature有効時のみ)
#[cfg(feature = "dynamo")]
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
}

#[cfg(feature = "dynamo")]
impl DynamoEventStore {
    /// 新しいDynamoEventStoreを作成
    ///
    /// GSI名は環境変数 `DYNAMODB_GSI_PK_KIND` / `DYNAMODB_GSI_PK_KIND_D` で設定可能。
    /// デフォルト: "GSI-PkKind" / "GSI-PkKindD"
    pub async fn new(table_name: String) -> Result<Self, StoreError> {
        let config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
        let client = DynamoClient::new(&config);
        let inner = InMemoryEventStore::new();
        
        let gsi_pk_kind_name = std::env::var("DYNAMODB_GSI_PK_KIND")
            .unwrap_or_else(|_| "GSI-PkKind".to_string());
        let gsi_pk_kind_d_name = std::env::var("DYNAMODB_GSI_PK_KIND_D")
            .unwrap_or_else(|_| "GSI-PkKindD".to_string());
        
        let store = Self {
            inner,
            client,
            table_name,
            gsi_pk_kind_name,
            gsi_pk_kind_d_name,
        };
        
        // 起動時にDynamoDBから最新のイベントをロード
        store.load_recent_events().await?;
        
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
        }
    }

    /// DynamoDBから直近のイベントをInMemoryStoreにロード
    /// created_atフィルターで直近のイベントのみロード（デフォルト: 30日）
    async fn load_recent_events(&self) -> Result<(), StoreError> {
        let retention_days: u64 = std::env::var("DYNAMODB_LOAD_RETENTION_DAYS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(30);
        let now_ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let cutoff_ts = now_ts.saturating_sub(retention_days * 86400);
        
        debug!("DynamoDBから直近{}日のイベントをロード中 (cutoff: {})...", retention_days, cutoff_ts);
        
        let mut scan_input = self.client
            .scan()
            .table_name(&self.table_name)
            .filter_expression("created_at >= :cutoff")
            .expression_attribute_values(":cutoff", AttributeValue::N(cutoff_ts.to_string()))
            .select(aws_sdk_dynamodb::types::Select::AllAttributes);

        let mut loaded_count = 0;
        let mut continuation_token: Option<std::collections::HashMap<String, AttributeValue>> = None;

        loop {
            if let Some(ref token) = continuation_token {
                for (key, value) in token {
                    scan_input = scan_input.exclusive_start_key(key.clone(), value.clone());
                }
            }

            let result = scan_input
                .clone()
                .send()
                .await
                .map_err(|e| StoreError::Internal(format!("DynamoDB scan failed: {}", e)))?;

            if let Some(items) = result.items {
                for item in items {
                    if let Ok(event) = self.parse_dynamo_item(item) {
                        if let Ok(verified) = event.verify() {
                            // InMemoryStoreに直接保存（DynamoDBには重複書き込みしない）
                            if let Ok(save_result) = self.inner.save(&verified).await {
                                if matches!(save_result, SaveResult::Saved | SaveResult::Replaced) {
                                    loaded_count += 1;
                                }
                            }
                        }
                    }
                }
            }

            continuation_token = result.last_evaluated_key;
            if continuation_token.is_none() {
                break;
            }
        }

        debug!(loaded_count, "DynamoDBからのイベントロード完了");
        Ok(())
    }

    /// DynamoDBアイテムをEventにパース
    fn parse_dynamo_item(&self, item: AwsHashMap<String, AttributeValue>) -> Result<Event, StoreError> {
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
        item.insert("pk_kind".to_string(), AttributeValue::S(format!("{}#{}", event.pubkey.to_hex(), event.kind.as_u16())));
        
        // GSI用キー: pk_kind_d（addressable用）- 区切り文字は # (issue #19 仕様準拠)
        let d_tag = if event.kind.is_addressable() {
            event.d_tag_value().to_string()
        } else {
            "".to_string()
        };
        item.insert("pk_kind_d".to_string(), AttributeValue::S(format!("{}#{}#{}", event.pubkey.to_hex(), event.kind.as_u16(), d_tag)));
        
        // タイムスタンプ
        item.insert("created_at".to_string(), AttributeValue::N(event.created_at.as_i64().to_string()));
        
        // イベントデータ（JSON）
        item.insert("event_json".to_string(), AttributeValue::S(serde_json::to_string(event).unwrap_or_default()));
        
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
    async fn query_existing_replaceable(&self, pubkey: &str, kind: u16) -> Result<Option<Event>, StoreError> {
        let pk_kind = format!("{}#{}", pubkey, kind);
        
        let result = self.client
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

        if let Some(items) = result.items {
            if let Some(item) = items.into_iter().next() {
                return Ok(Some(self.parse_dynamo_item(item)?));
            }
        }
        
        Ok(None)
    }

    /// GSIを使ってAddressableイベントをクエリ（最新を取得）
    async fn query_existing_addressable(&self, pubkey: &str, kind: u16, d_tag: &str) -> Result<Option<Event>, StoreError> {
        let pk_kind_d = format!("{}#{}#{}", pubkey, kind, d_tag);
        
        let result = self.client
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

        if let Some(items) = result.items {
            if let Some(item) = items.into_iter().next() {
                return Ok(Some(self.parse_dynamo_item(item)?));
            }
        }
        
        Ok(None)
    }
}

/// feature flagによるEventStore型の切り替え（静的ディスパッチ）
#[cfg(feature = "dynamo")]
pub type AppEventStore = DynamoEventStore;
#[cfg(not(feature = "dynamo"))]
pub type AppEventStore = InMemoryEventStore;

/// EventStoreのファクトリ関数（feature flagによる切り替え）
pub async fn create_event_store() -> Result<AppEventStore, StoreError> {
    #[cfg(feature = "dynamo")]
    {
        let table_name = std::env::var("DYNAMODB_TABLE_NAME")
            .unwrap_or_else(|_| "nostr_relay_events".to_string());
        
        debug!("DynamoEventStoreを初期化中 (table: {})", table_name);
        DynamoEventStore::new(table_name).await
    }
    
    #[cfg(not(feature = "dynamo"))]
    {
        debug!("InMemoryEventStoreを初期化中");
        Ok(InMemoryEventStore::new())
    }
}

#[cfg(feature = "dynamo")]
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
                    warn!("Regular event duplicate detected after DynamoDB write, rolling back: {}", inner.id);
                    if let Err(e) = self.delete_item_from_dynamo(&inner.id).await {
                        error!("Failed to rollback DynamoDB write for duplicate event {}: {}", inner.id, e);
                    }
                    Ok(SaveResult::Duplicate)
                },
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
                    warn!("Replaceable event ignored by InMemory after DynamoDB write, rolling back: {}", inner.id);
                    self.delete_item_from_dynamo(&inner.id).await?;
                    if let Some(ref existing) = existing_event {
                        self.put_item_to_dynamo(existing).await?;
                    }
                    Ok(SaveResult::Ignored)
                },
                other => Ok(other),
            }
        }
        // Addressableイベント: 同様の処理
        else if inner.kind.is_addressable() {
            let pubkey = inner.pubkey.to_hex();
            let kind = inner.kind.as_u16();
            let d_tag = inner.d_tag_value().to_string();
            
            // DynamoDBから既存イベントをクエリ
            let existing_event = self.query_existing_addressable(&pubkey, kind, &d_tag).await?;
            
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
                    warn!("Addressable event ignored by InMemory after DynamoDB write, rolling back: {}", inner.id);
                    self.delete_item_from_dynamo(&inner.id).await?;
                    if let Some(ref existing) = existing_event {
                        self.put_item_to_dynamo(existing).await?;
                    }
                    Ok(SaveResult::Ignored)
                },
                other => Ok(other),
            }
        }
        else {
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
            // InMemoryで削除されたイベントをDynamoDBからも削除
            // NOTE: 実装を簡単にするため、削除対象のイベントIDを再度特定する
            // より効率的にするには、InMemoryEventStore::delete() から削除されたイベントのリストを返すように変更する必要がある
            let inner = event.inner();
            let requester_pubkey = inner.pubkey.to_hex();
            
            // e-tagで指定されたイベントをDynamoDBから削除
            for id_hex in inner.e_tag_values() {
                if let Ok(event_id) = id_hex.parse::<EventId>() {
                    // InMemoryで削除済みということは、DynamoDBからも削除すべき
                    if let Err(e) = self.delete_item_from_dynamo(&event_id).await {
                        error!("DynamoDBからのイベント削除に失敗: {}", e);
                    }
                }
            }
            
            // a-tagで指定されたイベントも同様に処理
            for (kind_str, pubkey, d_id) in inner.a_tag_values() {
                if pubkey == &requester_pubkey {
                    if let Ok(kind_num) = kind_str.parse::<u16>() {
                        if kind_num != 5 { // kind-5は削除しない
                            if let Ok(Some(target_event)) = self.query_existing_addressable(pubkey, kind_num, d_id).await {
                                if target_event.created_at.as_i64() <= inner.created_at.as_i64() {
                                    if let Err(e) = self.delete_item_from_dynamo(&target_event.id).await {
                                        error!("DynamoDBからのaddressableイベント削除に失敗: {}", e);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::{create_custom_event, create_custom_event_with_keypair, create_test_event, create_test_event_with_content};

    #[tokio::test]
    async fn test_save_and_query() {
        let store = InMemoryEventStore::new();
        let event = create_test_event();
        let verified = event.clone().verify().unwrap();

        // 保存
        let result = store.save(&verified).await.unwrap();
        assert_eq!(result, SaveResult::Saved);

        // 空フィルターでクエリ（全イベントにマッチ）
        let filter = Filter::default();
        let results = store.query(&[filter]).await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0], event);
    }

    #[tokio::test]
    async fn test_duplicate_event() {
        let store = InMemoryEventStore::new();
        let event = create_test_event();
        let verified = event.verify().unwrap();

        // 最初の保存
        let result1 = store.save(&verified).await.unwrap();
        assert_eq!(result1, SaveResult::Saved);

        // 重複保存
        let result2 = store.save(&verified).await.unwrap();
        assert_eq!(result2, SaveResult::Duplicate);
    }

    #[tokio::test]
    async fn test_query_with_filter() {
        let store = InMemoryEventStore::new();

        // 2つの異なるイベントを保存
        let event1 = create_test_event_with_content("Event 1");
        let verified1 = event1.clone().verify().unwrap();
        store.save(&verified1).await.unwrap();

        let event2 = create_test_event_with_content("Event 2");
        let verified2 = event2.clone().verify().unwrap();
        store.save(&verified2).await.unwrap();

        // IDフィルターでクエリ
        let filter = Filter {
            ids: Some(vec![event1.id]),
            ..Default::default()
        };
        let results = store.query(&[filter]).await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, event1.id);
    }

    #[tokio::test]
    async fn test_query_no_match() {
        let store = InMemoryEventStore::new();
        let event = create_test_event();
        let verified = event.verify().unwrap();
        store.save(&verified).await.unwrap();

        // マッチしないフィルター
        let filter = Filter {
            ids: Some(vec![]), // 空リストは何もマッチしない
            ..Default::default()
        };
        let results = store.query(&[filter]).await.unwrap();
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn test_query_multiple_filters() {
        let store = InMemoryEventStore::new();

        let event1 = create_test_event_with_content("Event 1");
        let verified1 = event1.clone().verify().unwrap();
        store.save(&verified1).await.unwrap();

        let event2 = create_test_event_with_content("Event 2");
        let verified2 = event2.clone().verify().unwrap();
        store.save(&verified2).await.unwrap();

        // 複数フィルター（OR条件）
        let filter1 = Filter {
            ids: Some(vec![event1.id]),
            ..Default::default()
        };
        let filter2 = Filter {
            ids: Some(vec![event2.id]),
            ..Default::default()
        };
        let results = store.query(&[filter1, filter2]).await.unwrap();
        assert_eq!(results.len(), 2);
    }

    // ========== Replaceable イベントテスト ==========

    #[tokio::test]
    async fn test_replaceable_event_newer_overwrites() {
        let store = InMemoryEventStore::new();

        // kind 0 (replaceable) の古いイベント
        let old_event = create_custom_event(0, 1000, "old profile", vec![]);
        let verified_old = old_event.verify().unwrap();
        let result1 = store.save(&verified_old).await.unwrap();
        assert_eq!(result1, SaveResult::Saved);

        // kind 0 の新しいイベント（同一 pubkey）
        let new_event = create_custom_event(0, 2000, "new profile", vec![]);
        let verified_new = new_event.clone().verify().unwrap();
        let result2 = store.save(&verified_new).await.unwrap();
        assert_eq!(result2, SaveResult::Replaced);

        // 新しいイベントのみが残っている
        let results = store.query(&[Filter::default()]).await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].content, "new profile");
    }

    #[tokio::test]
    async fn test_replaceable_event_older_ignored() {
        let store = InMemoryEventStore::new();

        // kind 0 の新しいイベントを先に保存
        let new_event = create_custom_event(0, 2000, "new profile", vec![]);
        let verified_new = new_event.clone().verify().unwrap();
        store.save(&verified_new).await.unwrap();

        // kind 0 の古いイベントを後から保存（無視される）
        let old_event = create_custom_event(0, 1000, "old profile", vec![]);
        let verified_old = old_event.verify().unwrap();
        let result = store.save(&verified_old).await.unwrap();
        assert_eq!(result, SaveResult::Ignored);

        // 新しいイベントのみが残っている
        let results = store.query(&[Filter::default()]).await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].content, "new profile");
    }

    #[tokio::test]
    async fn test_replaceable_event_same_timestamp_smaller_id_wins() {
        let store = InMemoryEventStore::new();

        // 同じ created_at で異なる content（→異なる ID）
        let event1 = create_custom_event(0, 1000, "content a", vec![]);
        let event2 = create_custom_event(0, 1000, "content b", vec![]);

        // ID が小さい方を特定
        let (smaller_id_event, larger_id_event) =
            if event1.id.to_string() < event2.id.to_string() {
                (event1, event2)
            } else {
                (event2, event1)
            };

        // まず ID が大きい方を保存
        let verified_larger = larger_id_event.verify().unwrap();
        store.save(&verified_larger).await.unwrap();

        // ID が小さい方を保存（置換される）
        let verified_smaller = smaller_id_event.clone().verify().unwrap();
        let result = store.save(&verified_smaller).await.unwrap();
        assert_eq!(result, SaveResult::Replaced);

        // ID が小さい方が残っている
        let results = store.query(&[Filter::default()]).await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, smaller_id_event.id);
    }

    // ========== Addressable イベントテスト ==========

    #[tokio::test]
    async fn test_addressable_event_newer_overwrites() {
        let store = InMemoryEventStore::new();

        // kind 30000 (addressable) の古いイベント
        let old_event = create_custom_event(30000, 1000, "old article", vec![vec!["d", "article1"]]);
        let verified_old = old_event.verify().unwrap();
        let result1 = store.save(&verified_old).await.unwrap();
        assert_eq!(result1, SaveResult::Saved);

        // 同じ d タグの新しいイベント
        let new_event =
            create_custom_event(30000, 2000, "new article", vec![vec!["d", "article1"]]);
        let verified_new = new_event.clone().verify().unwrap();
        let result2 = store.save(&verified_new).await.unwrap();
        assert_eq!(result2, SaveResult::Replaced);

        // 新しいイベントのみが残っている
        let results = store.query(&[Filter::default()]).await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].content, "new article");
    }

    #[tokio::test]
    async fn test_addressable_event_different_d_tag() {
        let store = InMemoryEventStore::new();

        // 異なる d タグを持つ 2 つの addressable イベント
        let event1 = create_custom_event(30000, 1000, "article 1", vec![vec!["d", "article1"]]);
        let verified1 = event1.clone().verify().unwrap();
        store.save(&verified1).await.unwrap();

        let event2 = create_custom_event(30000, 1000, "article 2", vec![vec!["d", "article2"]]);
        let verified2 = event2.clone().verify().unwrap();
        store.save(&verified2).await.unwrap();

        // 両方のイベントが保存される（異なる d タグなので）
        let results = store.query(&[Filter::default()]).await.unwrap();
        assert_eq!(results.len(), 2);
    }

    #[tokio::test]
    async fn test_addressable_event_no_d_tag_treated_as_empty() {
        let store = InMemoryEventStore::new();

        // d タグがない addressable イベント
        let event1 = create_custom_event(30000, 1000, "no d tag 1", vec![]);
        let verified1 = event1.verify().unwrap();
        store.save(&verified1).await.unwrap();

        // d タグがない別の addressable イベント（同一視される）
        let event2 = create_custom_event(30000, 2000, "no d tag 2", vec![]);
        let verified2 = event2.clone().verify().unwrap();
        let result = store.save(&verified2).await.unwrap();
        assert_eq!(result, SaveResult::Replaced);

        // 1 つのイベントのみ残る
        let results = store.query(&[Filter::default()]).await.unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].content, "no d tag 2");
    }

    // ========== Ephemeral イベントテスト ==========

    #[tokio::test]
    async fn test_ephemeral_event_not_stored() {
        let store = InMemoryEventStore::new();

        // kind 20000 (ephemeral)
        let event = create_custom_event(20000, 1000, "ephemeral message", vec![]);
        let verified = event.verify().unwrap();
        let result = store.save(&verified).await.unwrap();
        assert_eq!(result, SaveResult::Ignored);

        // 保存されていない
        let results = store.query(&[Filter::default()]).await.unwrap();
        assert!(results.is_empty());
    }

    // ========== limit / ソートテスト ==========

    #[tokio::test]
    async fn test_query_sorted_by_created_at_descending() {
        let store = InMemoryEventStore::new();

        // 異なる created_at で 3 つのイベント（順番をバラバラに保存）
        let event2 = create_custom_event(1, 2000, "middle", vec![]);
        let event1 = create_custom_event(1, 1000, "oldest", vec![]);
        let event3 = create_custom_event(1, 3000, "newest", vec![]);

        store.save(&event2.verify().unwrap()).await.unwrap();
        store.save(&event1.verify().unwrap()).await.unwrap();
        store.save(&event3.verify().unwrap()).await.unwrap();

        let results = store.query(&[Filter::default()]).await.unwrap();
        assert_eq!(results.len(), 3);
        // created_at 降順でソート
        assert_eq!(results[0].content, "newest");
        assert_eq!(results[1].content, "middle");
        assert_eq!(results[2].content, "oldest");
    }

    #[tokio::test]
    async fn test_query_limit() {
        let store = InMemoryEventStore::new();

        // 3 つのイベントを保存
        let event1 = create_custom_event(1, 1000, "event 1", vec![]);
        let event2 = create_custom_event(1, 2000, "event 2", vec![]);
        let event3 = create_custom_event(1, 3000, "event 3", vec![]);

        store.save(&event1.verify().unwrap()).await.unwrap();
        store.save(&event2.verify().unwrap()).await.unwrap();
        store.save(&event3.verify().unwrap()).await.unwrap();

        // limit=2 で取得
        let filter = Filter {
            limit: Some(2),
            ..Default::default()
        };
        let results = store.query(&[filter]).await.unwrap();
        assert_eq!(results.len(), 2);
        // created_at 降順で最新 2 件
        assert_eq!(results[0].content, "event 3");
        assert_eq!(results[1].content, "event 2");
    }

    #[tokio::test]
    async fn test_query_multiple_filters_limit_per_filter() {
        let store = InMemoryEventStore::new();

        // kind=1 のイベント 3 つ、kind=2 のイベント 3 つ
        for i in 1..=3 {
            let event = create_custom_event(1, i * 1000, &format!("kind1 event {i}"), vec![]);
            store.save(&event.verify().unwrap()).await.unwrap();
        }
        for i in 1..=3 {
            let event = create_custom_event(2, i * 1000 + 500, &format!("kind2 event {i}"), vec![]);
            store.save(&event.verify().unwrap()).await.unwrap();
        }

        // NIP-01: limit は各フィルターごとに適用される
        let filter1 = Filter {
            kinds: Some(vec![serde_json::from_str("1").unwrap()]),
            limit: Some(1),
            ..Default::default()
        };
        let filter2 = Filter {
            kinds: Some(vec![serde_json::from_str("2").unwrap()]),
            limit: Some(2),
            ..Default::default()
        };
        let results = store.query(&[filter1, filter2]).await.unwrap();
        // filter1 → kind=1の最新1件、filter2 → kind=2の最新2件 = 合計3件
        assert_eq!(results.len(), 3);
    }

    // ========== NIP-09 削除リクエストテスト ==========

    #[tokio::test]
    async fn test_delete_by_e_tag() {
        let store = InMemoryEventStore::new();

        // 通常イベントを保存
        let event = create_custom_event(1, 1000, "to be deleted", vec![]);
        let event_id = event.id.to_string();
        store.save(&event.verify().unwrap()).await.unwrap();

        // 削除リクエスト (kind 5) を作成
        let delete_event = create_custom_event(5, 2000, "", vec![vec!["e", &event_id], vec!["k", "1"]]);
        let verified_delete = delete_event.verify().unwrap();

        let result = store.delete(&verified_delete).await.unwrap();
        assert_eq!(result.deleted_count, 1);

        // イベントが削除されている
        let results = store.query(&[Filter::default()]).await.unwrap();
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn test_delete_different_pubkey_ignored() {
        let store = InMemoryEventStore::new();

        // 通常イベントを保存（デフォルトキーペア）
        let event = create_custom_event(1, 1000, "protected", vec![]);
        let event_id = event.id.to_string();
        store.save(&event.verify().unwrap()).await.unwrap();

        // 異なるキーペアで削除リクエスト
        let other_secret = [
            0x02, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
            0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
            0x1d, 0x1e, 0x1f, 0x20,
        ];
        let delete_event = create_custom_event_with_keypair(5, 2000, "", vec![vec!["e", &event_id]], other_secret);
        let verified_delete = delete_event.verify().unwrap();

        let result = store.delete(&verified_delete).await.unwrap();
        assert_eq!(result.deleted_count, 0);

        // イベントは残っている
        let results = store.query(&[Filter::default()]).await.unwrap();
        assert_eq!(results.len(), 1);
    }

    #[tokio::test]
    async fn test_delete_kind5_has_no_effect() {
        let store = InMemoryEventStore::new();

        // kind 5 イベントを保存
        let kind5_event = create_custom_event(5, 1000, "deletion request", vec![]);
        let kind5_id = kind5_event.id.to_string();
        store.save(&kind5_event.verify().unwrap()).await.unwrap();

        // kind 5 を削除しようとする
        let delete_event = create_custom_event(5, 2000, "", vec![vec!["e", &kind5_id]]);
        let verified_delete = delete_event.verify().unwrap();
        store.save(&verified_delete).await.unwrap();

        let result = store.delete(&verified_delete).await.unwrap();
        assert_eq!(result.deleted_count, 0);

        // kind 5 イベントは残っている（+ 新しい削除リクエスト自体も）
        let results = store.query(&[Filter::default()]).await.unwrap();
        assert_eq!(results.len(), 2);
    }

    #[tokio::test]
    async fn test_delete_by_a_tag() {
        let store = InMemoryEventStore::new();

        // addressable イベントを保存
        let event = create_custom_event(30000, 1000, "article", vec![vec!["d", "my-article"]]);
        let pubkey = event.pubkey.to_hex();
        store.save(&event.verify().unwrap()).await.unwrap();

        // a タグで削除
        let a_tag_value = format!("30000:{}:my-article", pubkey);
        let delete_event = create_custom_event(5, 2000, "", vec![vec!["a", &a_tag_value], vec!["k", "30000"]]);
        let verified_delete = delete_event.verify().unwrap();

        let result = store.delete(&verified_delete).await.unwrap();
        assert_eq!(result.deleted_count, 1);

        let results = store.query(&[Filter::default()]).await.unwrap();
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn test_delete_a_tag_respects_created_at() {
        let store = InMemoryEventStore::new();

        // addressable イベント (created_at = 3000)
        let event = create_custom_event(30000, 3000, "newer article", vec![vec!["d", "my-article"]]);
        let pubkey = event.pubkey.to_hex();
        store.save(&event.verify().unwrap()).await.unwrap();

        // 削除リクエスト (created_at = 2000) → イベントの方が新しいので削除されない
        let a_tag_value = format!("30000:{}:my-article", pubkey);
        let delete_event = create_custom_event(5, 2000, "", vec![vec!["a", &a_tag_value]]);
        let verified_delete = delete_event.verify().unwrap();

        let result = store.delete(&verified_delete).await.unwrap();
        assert_eq!(result.deleted_count, 0);

        let results = store.query(&[Filter::default()]).await.unwrap();
        assert_eq!(results.len(), 1);
    }

    #[tokio::test]
    async fn test_delete_multiple_events() {
        let store = InMemoryEventStore::new();

        let event1 = create_custom_event(1, 1000, "event 1", vec![]);
        let event2 = create_custom_event(1, 2000, "event 2", vec![]);
        let id1 = event1.id.to_string();
        let id2 = event2.id.to_string();
        store.save(&event1.verify().unwrap()).await.unwrap();
        store.save(&event2.verify().unwrap()).await.unwrap();

        // 両方を削除
        let delete_event = create_custom_event(5, 3000, "", vec![vec!["e", &id1], vec!["e", &id2]]);
        let verified_delete = delete_event.verify().unwrap();

        let result = store.delete(&verified_delete).await.unwrap();
        assert_eq!(result.deleted_count, 2);

        let results = store.query(&[Filter::default()]).await.unwrap();
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn test_delete_with_both_e_and_a_tags() {
        let store = InMemoryEventStore::new();

        // 通常イベント
        let event1 = create_custom_event(1, 1000, "regular event", vec![]);
        let event1_id = event1.id.to_string();
        store.save(&event1.verify().unwrap()).await.unwrap();

        // Addressableイベント
        let event2 = create_custom_event(30000, 1000, "article", vec![vec!["d", "my-article"]]);
        let pubkey = event2.pubkey.to_hex();
        store.save(&event2.verify().unwrap()).await.unwrap();

        // e-tagとa-tagを同時に含む削除リクエスト
        let a_tag_value = format!("30000:{}:my-article", pubkey);
        let delete_event = create_custom_event(
            5, 2000, "",
            vec![vec!["e", &event1_id], vec!["a", &a_tag_value]],
        );
        let verified_delete = delete_event.verify().unwrap();

        let result = store.delete(&verified_delete).await.unwrap();
        assert_eq!(result.deleted_count, 2);

        let results = store.query(&[Filter::default()]).await.unwrap();
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn test_delete_replaceable_event_cleans_replaceable_index() {
        let store = InMemoryEventStore::new();

        // Replaceableイベント (kind 0)
        let event = create_custom_event(0, 1000, "profile", vec![]);
        let event_id = event.id.to_string();
        store.save(&event.verify().unwrap()).await.unwrap();

        // e-tagで削除
        let delete_event = create_custom_event(5, 2000, "", vec![vec!["e", &event_id]]);
        let verified_delete = delete_event.verify().unwrap();
        store.delete(&verified_delete).await.unwrap();

        // 新しいreplaceableイベントを保存 → Saved（Replacedではない）になることで
        // replaceable_indexが正しくクリーンアップされたことを確認
        let new_event = create_custom_event(0, 3000, "new profile", vec![]);
        let result = store.save(&new_event.verify().unwrap()).await.unwrap();
        assert_eq!(result, SaveResult::Saved);
    }

    #[tokio::test]
    async fn test_delete_nonexistent_event() {
        let store = InMemoryEventStore::new();

        let fake_id = "0000000000000000000000000000000000000000000000000000000000000000";
        let delete_event = create_custom_event(5, 1000, "", vec![vec!["e", fake_id]]);
        let verified_delete = delete_event.verify().unwrap();

        let result = store.delete(&verified_delete).await.unwrap();
        assert_eq!(result.deleted_count, 0);
    }

    // ========== DynamoEventStore テスト ==========
    
    #[cfg(feature = "dynamo")]
    mod dynamo_tests {
        use super::*;
        use aws_sdk_dynamodb::{Client as DynamoClient, Config as DynamoConfig};
        use serial_test::serial; // DynamoDB Localテストの並行実行を防ぐため

        // モックテスト用のヘルパー関数
        async fn create_test_dynamo_store() -> DynamoEventStore {
            // 実際のAWS環境では、環境変数からDynamoDBクライアントが作成される
            // テスト用には、DynamoDB Local を使用するか、モックを使用する
            // ここではDynamoDB Localの使用を前提とする
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
            // このテストはDynamoDB Localが起動している場合のみ実行される
            // CI環境では別途DynamoDB Localの起動が必要
            let store = create_test_dynamo_store().await;
            let event = create_test_event();
            let verified = event.clone().verify().unwrap();

            // テストの実装は InMemoryEventStore と同様だが、DynamoDB永続化が含まれる
            let result = store.save(&verified).await;
            
            // DynamoDB Localが起動していない場合はエラーになるため、テストをスキップ
            if result.is_err() {
                eprintln!("DynamoDB Local not available, skipping test");
                return;
            }
            
            assert_eq!(result.unwrap(), SaveResult::Saved);

            // クエリテスト（InMemory経由）
            let results = store.query(&[Filter::default()]).await.unwrap();
            assert_eq!(results.len(), 1);
            assert_eq!(results[0], event);
        }

        #[tokio::test]
        #[serial]
        async fn test_dynamo_event_store_replaceable_event() {
            let store = create_test_dynamo_store().await;

            // 最初のreplaceableイベント
            let old_event = create_custom_event(0, 1000, "old profile", vec![]);
            let verified_old = old_event.verify().unwrap();
            
            let result1 = store.save(&verified_old).await;
            if result1.is_err() {
                eprintln!("DynamoDB Local not available, skipping test");
                return;
            }
            assert_eq!(result1.unwrap(), SaveResult::Saved);

            // 新しいreplaceableイベント（置換）
            let new_event = create_custom_event(0, 2000, "new profile", vec![]);
            let verified_new = new_event.clone().verify().unwrap();
            let result2 = store.save(&verified_new).await.unwrap();
            assert_eq!(result2, SaveResult::Replaced);

            // クエリで新しいイベントのみが返されることを確認
            let results = store.query(&[Filter::default()]).await.unwrap();
            assert_eq!(results.len(), 1);
            assert_eq!(results[0].content, "new profile");
        }

        // 注意: DynamoDB LocalまたはモックなしでのCI実行を考慮し、
        // より複雑なテストは統合テスト或いはモックを使った単体テストとして別途実装する
    }
}
