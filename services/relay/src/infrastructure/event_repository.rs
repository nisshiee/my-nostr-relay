/// DynamoDBでNostrイベントを管理するためのイベントリポジトリ
///
/// 要件: 8.10, 9.1, 10.2, 10.3, 10.4, 12.2, 12.3, 13.1, 13.2, 13.3, 13.4,
///       16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.8
/// 追加要件（OpenSearch REQ処理）: 5.1-5.8, 9.1-9.5
use async_trait::async_trait;
use aws_sdk_dynamodb::types::{AttributeValue, Delete, Put, TransactWriteItem};
use aws_sdk_dynamodb::Client as DynamoDbClient;
use std::collections::HashMap;
use nostr::{Event, Filter};
use thiserror::Error;

// ============================================================================
// QueryRepository トレイトとエラー型（Task 4.1）
// ============================================================================

/// QueryRepository固有のエラー型
///
/// クエリ操作専用のエラーを表現する。EventRepositoryErrorからの変換もサポート。
/// 要件: 9.1, 9.2
#[derive(Debug, Error, Clone, PartialEq)]
pub enum QueryRepositoryError {
    /// クエリ実行に失敗
    #[error("Query execution error: {0}")]
    QueryError(String),

    /// 接続に失敗
    #[error("Connection error: {0}")]
    ConnectionError(String),

    /// デシリアライズに失敗
    #[error("Deserialization error: {0}")]
    DeserializationError(String),
}

/// EventRepositoryErrorからQueryRepositoryErrorへの変換
///
/// DynamoEventRepositoryがQueryRepositoryを実装する際に使用。
/// 要件: 9.3, 9.4（Task 4.3: エラー型変換）
impl From<EventRepositoryError> for QueryRepositoryError {
    fn from(err: EventRepositoryError) -> Self {
        match err {
            EventRepositoryError::ReadError(msg) => QueryRepositoryError::QueryError(msg),
            EventRepositoryError::WriteError(msg) => QueryRepositoryError::QueryError(msg),
            EventRepositoryError::SerializationError(msg) => {
                QueryRepositoryError::DeserializationError(msg)
            }
        }
    }
}

/// クエリ専用リポジトリトレイト
///
/// EventRepositoryのサブセットとして、検索操作のみを抽象化する。
/// OpenSearchEventRepositoryとDynamoEventRepositoryの共通インターフェース。
/// 要件: 5.1-5.8, 9.1, 9.2
#[async_trait]
pub trait QueryRepository: Send + Sync {
    /// フィルターに合致するイベントをクエリ
    ///
    /// # 引数
    /// * `filters` - 検索条件のフィルター配列（OR結合）
    /// * `limit` - 取得する最大イベント数
    ///
    /// # 戻り値
    /// * `Ok(Vec<Event>)` - created_at降順でソートされたイベント
    /// * `Err(QueryRepositoryError)` - クエリ実行エラー
    async fn query(
        &self,
        filters: &[Filter],
        limit: Option<u32>,
    ) -> Result<Vec<Event>, QueryRepositoryError>;
}

// ============================================================================
// EventRepository エラー型と既存トレイト
// ============================================================================

use crate::domain::{EventKind, FilterEvaluator};

/// イベントリポジトリ操作のエラー型
#[derive(Debug, Error, Clone, PartialEq)]
pub enum EventRepositoryError {
    /// DynamoDBへの書き込みに失敗
    #[error("Write error: {0}")]
    WriteError(String),

    /// DynamoDBからの読み取りに失敗
    #[error("Read error: {0}")]
    ReadError(String),

    /// データのシリアライズ/デシリアライズに失敗
    #[error("Serialization error: {0}")]
    SerializationError(String),
}

/// イベント保存結果
#[derive(Debug, Clone, PartialEq)]
pub enum SaveResult {
    /// 新しいイベントとして保存された
    Saved,
    /// 重複イベント（同一IDが既に存在）
    Duplicate,
    /// 既存イベントを置換した（Replaceable/Addressable）
    Replaced,
}

/// イベント永続化用トレイト
///
/// QueryRepositoryを継承し、クエリ機能に加えて保存・取得機能を提供する。
/// 異なる実装を可能にします（実際のDynamoDB、テスト用モック）。
/// 要件: 9.1, 9.2（Task 4.2: QueryRepository継承構造）
#[async_trait]
pub trait EventRepository: QueryRepository {
    /// イベントを保存（Kind別に適切な処理を実行）
    ///
    /// # 引数
    /// * `event` - 保存するイベント
    ///
    /// # 戻り値
    /// * 成功時は`Ok(SaveResult)` - Saved, Duplicate, または Replaced
    /// * 失敗時は`Err(EventRepositoryError)`
    ///
    /// 要件: 9.1, 10.2, 10.3, 12.2, 12.3, 16.1, 16.2, 16.3, 16.6, 16.7
    async fn save(&self, event: &Event) -> Result<SaveResult, EventRepositoryError>;

    /// イベントIDで取得
    ///
    /// # 引数
    /// * `event_id` - イベントID（64文字の16進数文字列）
    ///
    /// # 戻り値
    /// * 見つかった場合は`Ok(Some(Event))`
    /// * 見つからなかった場合は`Ok(None)`
    /// * 失敗時は`Err(EventRepositoryError)`
    async fn get_by_id(&self, event_id: &str) -> Result<Option<Event>, EventRepositoryError>;
}

/// EventRepositoryのDynamoDB実装
///
/// この構造体はDynamoDBを使用してNostrイベントを
/// 永続的に保存するEventRepositoryトレイトを実装します。
#[derive(Debug, Clone)]
pub struct DynamoEventRepository {
    /// DynamoDBクライアント
    client: DynamoDbClient,
    /// イベントテーブル名
    table_name: String,
}

impl DynamoEventRepository {
    /// 新しいDynamoEventRepositoryを作成
    ///
    /// # 引数
    /// * `client` - DynamoDBクライアント
    /// * `table_name` - イベントテーブルの名前
    pub fn new(client: DynamoDbClient, table_name: String) -> Self {
        Self { client, table_name }
    }

    /// イベントからpk_kind属性を生成（Replaceableイベント用）
    /// フォーマット: {pubkey}#{kind}
    fn build_pk_kind(event: &Event) -> String {
        format!("{}#{}", event.pubkey.to_hex(), event.kind.as_u16())
    }

    /// イベントからpk_kind_d属性を生成（Addressableイベント用）
    /// フォーマット: {pubkey}#{kind}#{d_tag}
    fn build_pk_kind_d(event: &Event) -> String {
        let d_tag = Self::extract_d_tag(event).unwrap_or_default();
        format!("{}#{}#{}", event.pubkey.to_hex(), event.kind.as_u16(), d_tag)
    }

    /// イベントからdタグの値を抽出
    fn extract_d_tag(event: &Event) -> Option<String> {
        event
            .tags
            .iter()
            .find(|tag| {
                let tag_vec: Vec<String> = (*tag).clone().to_vec();
                !tag_vec.is_empty() && tag_vec[0] == "d"
            })
            .and_then(|tag| {
                let tag_vec: Vec<String> = (*tag).clone().to_vec();
                tag_vec.get(1).cloned()
            })
    }

    /// 英字1文字タグの最初の値を抽出
    /// 戻り値: Vec<(タグ名, 値)>
    fn extract_single_letter_tags(event: &Event) -> Vec<(String, String)> {
        let mut tags = Vec::new();

        for tag in event.tags.iter() {
            let tag_vec: Vec<String> = (*tag).clone().to_vec();
            if tag_vec.len() >= 2 {
                let tag_name = &tag_vec[0];
                // 英字1文字のタグのみ
                if tag_name.len() == 1 && tag_name.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
                    // 同じタグ名がまだ追加されていない場合のみ追加（最初の値のみ）
                    if !tags.iter().any(|(name, _)| name == tag_name) {
                        tags.push((tag_name.clone(), tag_vec[1].clone()));
                    }
                }
            }
        }

        tags
    }

    /// イベントを完全なJSONにシリアライズ
    fn serialize_event(event: &Event) -> Result<String, EventRepositoryError> {
        serde_json::to_string(event)
            .map_err(|e| EventRepositoryError::SerializationError(e.to_string()))
    }

    /// JSONからイベントをデシリアライズ
    fn deserialize_event(json: &str) -> Result<Event, EventRepositoryError> {
        serde_json::from_str(json)
            .map_err(|e| EventRepositoryError::SerializationError(e.to_string()))
    }

    /// 通常イベント（Regular）の保存
    async fn save_regular(&self, event: &Event) -> Result<SaveResult, EventRepositoryError> {
        let event_json = Self::serialize_event(event)?;
        let event_id = event.id.to_hex();

        // イベントを保存（条件: 同じIDが存在しない場合のみ）
        let mut builder = self
            .client
            .put_item()
            .table_name(&self.table_name)
            .item("id", AttributeValue::S(event_id.clone()))
            .item("pubkey", AttributeValue::S(event.pubkey.to_hex()))
            .item("kind", AttributeValue::N(event.kind.as_u16().to_string()))
            .item("created_at", AttributeValue::N(event.created_at.as_secs().to_string()))
            .item("content", AttributeValue::S(event.content.clone()))
            .item("tags", AttributeValue::S(serde_json::to_string(&event.tags).unwrap_or_default()))
            .item("sig", AttributeValue::S(event.sig.to_string()))
            .item("event_json", AttributeValue::S(event_json))
            .item("pk_kind", AttributeValue::S(Self::build_pk_kind(event)))
            .condition_expression("attribute_not_exists(id)");

        // 英字1文字タグを個別属性として追加
        for (tag_name, tag_value) in Self::extract_single_letter_tags(event) {
            let attr_name = format!("tag_{}", tag_name.to_lowercase());
            builder = builder.item(attr_name, AttributeValue::S(tag_value));
        }

        let result = builder.send().await;

        match result {
            Ok(_) => Ok(SaveResult::Saved),
            Err(err) => {
                let service_error = err.into_service_error();
                if service_error.is_conditional_check_failed_exception() {
                    return Ok(SaveResult::Duplicate);
                }
                Err(EventRepositoryError::WriteError(service_error.to_string()))
            }
        }
    }

    /// イベント保存用の属性マップを構築
    fn build_event_item(
        event: &Event,
        event_json: &str,
        pk_kind: Option<&str>,
        pk_kind_d: Option<&str>,
    ) -> HashMap<String, AttributeValue> {
        let mut item = HashMap::new();
        item.insert("id".to_string(), AttributeValue::S(event.id.to_hex()));
        item.insert("pubkey".to_string(), AttributeValue::S(event.pubkey.to_hex()));
        item.insert("kind".to_string(), AttributeValue::N(event.kind.as_u16().to_string()));
        item.insert("created_at".to_string(), AttributeValue::N(event.created_at.as_secs().to_string()));
        item.insert("content".to_string(), AttributeValue::S(event.content.clone()));
        item.insert("tags".to_string(), AttributeValue::S(serde_json::to_string(&event.tags).unwrap_or_default()));
        item.insert("sig".to_string(), AttributeValue::S(event.sig.to_string()));
        item.insert("event_json".to_string(), AttributeValue::S(event_json.to_string()));

        if let Some(pk) = pk_kind {
            item.insert("pk_kind".to_string(), AttributeValue::S(pk.to_string()));
        }
        if let Some(pkd) = pk_kind_d {
            item.insert("pk_kind_d".to_string(), AttributeValue::S(pkd.to_string()));
        }

        // 英字1文字タグを個別属性として追加
        for (tag_name, tag_value) in Self::extract_single_letter_tags(event) {
            let attr_name = format!("tag_{}", tag_name.to_lowercase());
            item.insert(attr_name, AttributeValue::S(tag_value));
        }

        item
    }

    /// 置換可能イベント（Replaceable）の保存
    async fn save_replaceable(&self, event: &Event) -> Result<SaveResult, EventRepositoryError> {
        let event_json = Self::serialize_event(event)?;
        let pk_kind = Self::build_pk_kind(event);

        // 既存のReplaceableイベントを検索
        let existing = self.find_replaceable_event(&pk_kind).await?;

        if let Some(existing_event) = existing {
            // 既存イベントがある場合、created_at比較
            // 新しいイベントのcreated_atが同じかそれより古い場合
            if event.created_at < existing_event.created_at {
                // 古いイベントは保存しない
                return Ok(SaveResult::Duplicate);
            }
            if event.created_at == existing_event.created_at {
                // 同一タイムスタンプの場合、ID辞書順で先のイベントを保持
                if event.id.to_hex() >= existing_event.id.to_hex() {
                    return Ok(SaveResult::Duplicate);
                }
            }

            // トランザクションで削除と保存を原子的に実行
            let item = Self::build_event_item(event, &event_json, Some(&pk_kind), None);

            let delete_item = Delete::builder()
                .table_name(&self.table_name)
                .key("id", AttributeValue::S(existing_event.id.to_hex()))
                .build()
                .map_err(|e| EventRepositoryError::WriteError(e.to_string()))?;

            let put_item = Put::builder()
                .table_name(&self.table_name)
                .set_item(Some(item))
                .condition_expression("attribute_not_exists(id)")
                .build()
                .map_err(|e| EventRepositoryError::WriteError(e.to_string()))?;

            let result = self
                .client
                .transact_write_items()
                .transact_items(TransactWriteItem::builder().delete(delete_item).build())
                .transact_items(TransactWriteItem::builder().put(put_item).build())
                .send()
                .await;

            match result {
                Ok(_) => Ok(SaveResult::Replaced),
                Err(err) => {
                    let service_error = err.into_service_error();
                    // TransactionCanceledExceptionの中にConditionalCheckFailedが含まれているか確認
                    if service_error
                        .to_string()
                        .contains("ConditionalCheckFailed")
                    {
                        return Ok(SaveResult::Duplicate);
                    }
                    Err(EventRepositoryError::WriteError(service_error.to_string()))
                }
            }
        } else {
            // 既存イベントがない場合は通常のput_item
            let mut builder = self
                .client
                .put_item()
                .table_name(&self.table_name)
                .item("id", AttributeValue::S(event.id.to_hex()))
                .item("pubkey", AttributeValue::S(event.pubkey.to_hex()))
                .item("kind", AttributeValue::N(event.kind.as_u16().to_string()))
                .item("created_at", AttributeValue::N(event.created_at.as_secs().to_string()))
                .item("content", AttributeValue::S(event.content.clone()))
                .item("tags", AttributeValue::S(serde_json::to_string(&event.tags).unwrap_or_default()))
                .item("sig", AttributeValue::S(event.sig.to_string()))
                .item("event_json", AttributeValue::S(event_json))
                .item("pk_kind", AttributeValue::S(pk_kind))
                .condition_expression("attribute_not_exists(id)");

            // 英字1文字タグを個別属性として追加
            for (tag_name, tag_value) in Self::extract_single_letter_tags(event) {
                let attr_name = format!("tag_{}", tag_name.to_lowercase());
                builder = builder.item(attr_name, AttributeValue::S(tag_value));
            }

            let result = builder.send().await;

            match result {
                Ok(_) => Ok(SaveResult::Saved),
                Err(err) => {
                    let service_error = err.into_service_error();
                    if service_error.is_conditional_check_failed_exception() {
                        return Ok(SaveResult::Duplicate);
                    }
                    Err(EventRepositoryError::WriteError(service_error.to_string()))
                }
            }
        }
    }

    /// アドレス指定可能イベント（Addressable）の保存
    async fn save_addressable(&self, event: &Event) -> Result<SaveResult, EventRepositoryError> {
        let event_json = Self::serialize_event(event)?;
        let pk_kind = Self::build_pk_kind(event);
        let pk_kind_d = Self::build_pk_kind_d(event);

        // 既存のAddressableイベントを検索
        let existing = self.find_addressable_event(&pk_kind_d).await?;

        if let Some(existing_event) = existing {
            // 既存イベントがある場合、created_at比較
            if event.created_at < existing_event.created_at {
                return Ok(SaveResult::Duplicate);
            }
            if event.created_at == existing_event.created_at {
                // 同一タイムスタンプの場合、ID辞書順で先のイベントを保持
                if event.id.to_hex() >= existing_event.id.to_hex() {
                    return Ok(SaveResult::Duplicate);
                }
            }

            // トランザクションで削除と保存を原子的に実行
            let item = Self::build_event_item(event, &event_json, Some(&pk_kind), Some(&pk_kind_d));

            let delete_item = Delete::builder()
                .table_name(&self.table_name)
                .key("id", AttributeValue::S(existing_event.id.to_hex()))
                .build()
                .map_err(|e| EventRepositoryError::WriteError(e.to_string()))?;

            let put_item = Put::builder()
                .table_name(&self.table_name)
                .set_item(Some(item))
                .condition_expression("attribute_not_exists(id)")
                .build()
                .map_err(|e| EventRepositoryError::WriteError(e.to_string()))?;

            let result = self
                .client
                .transact_write_items()
                .transact_items(TransactWriteItem::builder().delete(delete_item).build())
                .transact_items(TransactWriteItem::builder().put(put_item).build())
                .send()
                .await;

            match result {
                Ok(_) => Ok(SaveResult::Replaced),
                Err(err) => {
                    let service_error = err.into_service_error();
                    // TransactionCanceledExceptionの中にConditionalCheckFailedが含まれているか確認
                    if service_error
                        .to_string()
                        .contains("ConditionalCheckFailed")
                    {
                        return Ok(SaveResult::Duplicate);
                    }
                    Err(EventRepositoryError::WriteError(service_error.to_string()))
                }
            }
        } else {
            // 既存イベントがない場合は通常のput_item
            let mut builder = self
                .client
                .put_item()
                .table_name(&self.table_name)
                .item("id", AttributeValue::S(event.id.to_hex()))
                .item("pubkey", AttributeValue::S(event.pubkey.to_hex()))
                .item("kind", AttributeValue::N(event.kind.as_u16().to_string()))
                .item("created_at", AttributeValue::N(event.created_at.as_secs().to_string()))
                .item("content", AttributeValue::S(event.content.clone()))
                .item("tags", AttributeValue::S(serde_json::to_string(&event.tags).unwrap_or_default()))
                .item("sig", AttributeValue::S(event.sig.to_string()))
                .item("event_json", AttributeValue::S(event_json))
                .item("pk_kind", AttributeValue::S(pk_kind))
                .item("pk_kind_d", AttributeValue::S(pk_kind_d))
                .condition_expression("attribute_not_exists(id)");

            // 英字1文字タグを個別属性として追加
            for (tag_name, tag_value) in Self::extract_single_letter_tags(event) {
                let attr_name = format!("tag_{}", tag_name.to_lowercase());
                builder = builder.item(attr_name, AttributeValue::S(tag_value));
            }

            let result = builder.send().await;

            match result {
                Ok(_) => Ok(SaveResult::Saved),
                Err(err) => {
                    let service_error = err.into_service_error();
                    if service_error.is_conditional_check_failed_exception() {
                        return Ok(SaveResult::Duplicate);
                    }
                    Err(EventRepositoryError::WriteError(service_error.to_string()))
                }
            }
        }
    }

    /// pk_kindでReplaceableイベントを検索（GSI-PkKindを使用）
    async fn find_replaceable_event(
        &self,
        pk_kind: &str,
    ) -> Result<Option<Event>, EventRepositoryError> {
        let result = self
            .client
            .query()
            .table_name(&self.table_name)
            .index_name("GSI-PkKind")
            .key_condition_expression("pk_kind = :pk")
            .expression_attribute_values(":pk", AttributeValue::S(pk_kind.to_string()))
            .limit(1)
            .scan_index_forward(false) // created_at降順
            .send()
            .await
            .map_err(|e| EventRepositoryError::ReadError(e.into_service_error().to_string()))?;

        if let Some(items) = result.items
            && let Some(item) = items.into_iter().next()
            && let Some(json) = item.get("event_json").and_then(|v| v.as_s().ok())
        {
            return Ok(Some(Self::deserialize_event(json)?));
        }

        Ok(None)
    }

    /// pk_kind_dでAddressableイベントを検索（GSI-PkKindDを使用）
    async fn find_addressable_event(
        &self,
        pk_kind_d: &str,
    ) -> Result<Option<Event>, EventRepositoryError> {
        let result = self
            .client
            .query()
            .table_name(&self.table_name)
            .index_name("GSI-PkKindD")
            .key_condition_expression("pk_kind_d = :pkd")
            .expression_attribute_values(":pkd", AttributeValue::S(pk_kind_d.to_string()))
            .limit(1)
            .scan_index_forward(false) // created_at降順
            .send()
            .await
            .map_err(|e| EventRepositoryError::ReadError(e.into_service_error().to_string()))?;

        if let Some(items) = result.items
            && let Some(item) = items.into_iter().next()
            && let Some(json) = item.get("event_json").and_then(|v| v.as_s().ok())
        {
            return Ok(Some(Self::deserialize_event(json)?));
        }

        Ok(None)
    }

    /// フィルターに基づいてイベントをクエリ（テーブルスキャン + アプリ層フィルタリング）
    async fn query_by_scan(
        &self,
        filters: &[Filter],
        limit: Option<u32>,
    ) -> Result<Vec<Event>, EventRepositoryError> {
        let mut events = Vec::new();
        let mut last_evaluated_key = None;

        // ページネーション: LastEvaluatedKeyがある限りスキャンを続ける
        loop {
            let mut scan_builder = self.client.scan().table_name(&self.table_name);

            // 前回のスキャンの続きから開始
            if let Some(key) = last_evaluated_key.take() {
                scan_builder = scan_builder.set_exclusive_start_key(Some(key));
            }

            let result = scan_builder
                .send()
                .await
                .map_err(|e| EventRepositoryError::ReadError(e.into_service_error().to_string()))?;

            if let Some(items) = result.items {
                for item in items {
                    if let Some(json) = item.get("event_json").and_then(|v| v.as_s().ok())
                        && let Ok(event) = Self::deserialize_event(json)
                    {
                        // フィルター評価
                        if filters.is_empty() || FilterEvaluator::matches_any(&event, filters) {
                            events.push(event);
                        }
                    }
                }
            }

            // 次のページがあるか確認
            match result.last_evaluated_key {
                Some(key) => last_evaluated_key = Some(key),
                None => break, // 全データ取得完了
            }
        }

        // ソート: created_at降順、同一タイムスタンプはid辞書順
        events.sort_by(|a, b| {
            match b.created_at.cmp(&a.created_at) {
                std::cmp::Ordering::Equal => a.id.to_hex().cmp(&b.id.to_hex()),
                other => other,
            }
        });

        // limit適用
        if let Some(limit) = limit {
            events.truncate(limit as usize);
        }

        Ok(events)
    }
}

/// DynamoEventRepositoryのQueryRepository実装
///
/// EventRepositoryErrorをQueryRepositoryErrorに変換してqueryを提供。
/// 要件: 9.3, 9.4（Task 4.3: QueryRepository互換性維持）
#[async_trait]
impl QueryRepository for DynamoEventRepository {
    async fn query(
        &self,
        filters: &[Filter],
        limit: Option<u32>,
    ) -> Result<Vec<Event>, QueryRepositoryError> {
        // 現時点ではすべてのクエリをスキャンベースで実装
        // 将来の最適化: OpenSearchを使用した効率的なクエリ
        self.query_by_scan(filters, limit)
            .await
            .map_err(QueryRepositoryError::from)
    }
}

/// DynamoEventRepositoryのEventRepository実装
///
/// QueryRepositoryを継承しているため、save()とget_by_id()のみ実装。
#[async_trait]
impl EventRepository for DynamoEventRepository {
    async fn save(&self, event: &Event) -> Result<SaveResult, EventRepositoryError> {
        let kind = EventKind::classify(event.kind.as_u16());

        match kind {
            EventKind::Regular => self.save_regular(event).await,
            EventKind::Replaceable => self.save_replaceable(event).await,
            EventKind::Ephemeral => {
                // Ephemeralイベントは保存しない
                Ok(SaveResult::Saved)
            }
            EventKind::Addressable => self.save_addressable(event).await,
        }
    }

    async fn get_by_id(&self, event_id: &str) -> Result<Option<Event>, EventRepositoryError> {
        let result = self
            .client
            .get_item()
            .table_name(&self.table_name)
            .key("id", AttributeValue::S(event_id.to_string()))
            .send()
            .await
            .map_err(|e| EventRepositoryError::ReadError(e.into_service_error().to_string()))?;

        match result.item {
            Some(item) => {
                let json = item.get("event_json").and_then(|v| v.as_s().ok()).ok_or_else(
                    || {
                        EventRepositoryError::SerializationError(
                            "Missing event_json field".to_string(),
                        )
                    },
                )?;
                Ok(Some(Self::deserialize_event(json)?))
            }
            None => Ok(None),
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Timestamp};
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    // ==================== 3.5 イベントリポジトリテスト ====================

    // EventRepositoryError表示メッセージのテスト (要件 16.8)
    #[test]
    fn test_event_repository_error_write_error_display() {
        let error = EventRepositoryError::WriteError("conditional check failed".to_string());
        assert_eq!(error.to_string(), "Write error: conditional check failed");
    }

    #[test]
    fn test_event_repository_error_read_error_display() {
        let error = EventRepositoryError::ReadError("item not found".to_string());
        assert_eq!(error.to_string(), "Read error: item not found");
    }

    #[test]
    fn test_event_repository_error_serialization_error_display() {
        let error = EventRepositoryError::SerializationError("invalid format".to_string());
        assert_eq!(error.to_string(), "Serialization error: invalid format");
    }

    // EventRepositoryError等価性のテスト
    #[test]
    fn test_event_repository_error_equality() {
        assert_eq!(
            EventRepositoryError::WriteError("test".to_string()),
            EventRepositoryError::WriteError("test".to_string())
        );
        assert_ne!(
            EventRepositoryError::WriteError("test1".to_string()),
            EventRepositoryError::WriteError("test2".to_string())
        );
        assert_ne!(
            EventRepositoryError::WriteError("test".to_string()),
            EventRepositoryError::ReadError("test".to_string())
        );
    }

    // SaveResult等価性のテスト
    #[test]
    fn test_save_result_equality() {
        assert_eq!(SaveResult::Saved, SaveResult::Saved);
        assert_eq!(SaveResult::Duplicate, SaveResult::Duplicate);
        assert_eq!(SaveResult::Replaced, SaveResult::Replaced);
        assert_ne!(SaveResult::Saved, SaveResult::Duplicate);
        assert_ne!(SaveResult::Saved, SaveResult::Replaced);
    }

    // ==================== Task 4.1 QueryRepositoryErrorテスト ====================

    // QueryRepositoryError表示メッセージのテスト (要件 9.1, 9.2)
    #[test]
    fn test_query_repository_error_query_error_display() {
        let error = QueryRepositoryError::QueryError("query failed".to_string());
        assert_eq!(error.to_string(), "Query execution error: query failed");
    }

    #[test]
    fn test_query_repository_error_connection_error_display() {
        let error = QueryRepositoryError::ConnectionError("connection refused".to_string());
        assert_eq!(error.to_string(), "Connection error: connection refused");
    }

    #[test]
    fn test_query_repository_error_deserialization_error_display() {
        let error = QueryRepositoryError::DeserializationError("invalid json".to_string());
        assert_eq!(error.to_string(), "Deserialization error: invalid json");
    }

    // QueryRepositoryError等価性のテスト
    #[test]
    fn test_query_repository_error_equality() {
        assert_eq!(
            QueryRepositoryError::QueryError("test".to_string()),
            QueryRepositoryError::QueryError("test".to_string())
        );
        assert_ne!(
            QueryRepositoryError::QueryError("test1".to_string()),
            QueryRepositoryError::QueryError("test2".to_string())
        );
        assert_ne!(
            QueryRepositoryError::QueryError("test".to_string()),
            QueryRepositoryError::ConnectionError("test".to_string())
        );
    }

    // ==================== Task 4.3 エラー型変換テスト ====================

    // EventRepositoryError -> QueryRepositoryError変換テスト (要件 9.3, 9.4)
    #[test]
    fn test_event_repository_error_to_query_repository_error_read_error() {
        let event_error = EventRepositoryError::ReadError("DB read failed".to_string());
        let query_error: QueryRepositoryError = event_error.into();
        assert_eq!(
            query_error,
            QueryRepositoryError::QueryError("DB read failed".to_string())
        );
    }

    #[test]
    fn test_event_repository_error_to_query_repository_error_write_error() {
        let event_error = EventRepositoryError::WriteError("DB write failed".to_string());
        let query_error: QueryRepositoryError = event_error.into();
        assert_eq!(
            query_error,
            QueryRepositoryError::QueryError("DB write failed".to_string())
        );
    }

    #[test]
    fn test_event_repository_error_to_query_repository_error_serialization_error() {
        let event_error = EventRepositoryError::SerializationError("parse error".to_string());
        let query_error: QueryRepositoryError = event_error.into();
        assert_eq!(
            query_error,
            QueryRepositoryError::DeserializationError("parse error".to_string())
        );
    }

    // pk_kind生成のテスト
    #[test]
    fn test_build_pk_kind() {
        let keys = Keys::generate();
        let event = EventBuilder::new(Kind::Metadata, "test")
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        let pk_kind = DynamoEventRepository::build_pk_kind(&event);
        assert!(pk_kind.contains('#'));
        assert!(pk_kind.starts_with(&keys.public_key().to_hex()));
        assert!(pk_kind.ends_with("#0")); // kind 0 = Metadata
    }

    // pk_kind_d生成のテスト
    #[test]
    fn test_build_pk_kind_d() {
        let keys = Keys::generate();
        let d_tag = nostr::Tag::parse(["d", "test-identifier"]).unwrap();
        let event = EventBuilder::new(Kind::from(30000), "test")
            .tags(vec![d_tag])
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        let pk_kind_d = DynamoEventRepository::build_pk_kind_d(&event);
        assert!(pk_kind_d.contains("#30000#"));
        assert!(pk_kind_d.ends_with("#test-identifier"));
    }

    // pk_kind_d生成（dタグなし）のテスト
    #[test]
    fn test_build_pk_kind_d_without_d_tag() {
        let keys = Keys::generate();
        let event = EventBuilder::new(Kind::from(30000), "test")
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        let pk_kind_d = DynamoEventRepository::build_pk_kind_d(&event);
        assert!(pk_kind_d.ends_with("#")); // 空のdタグ
    }

    // dタグ抽出のテスト
    #[test]
    fn test_extract_d_tag() {
        let keys = Keys::generate();
        let d_tag = nostr::Tag::parse(["d", "my-identifier"]).unwrap();
        let event = EventBuilder::new(Kind::from(30000), "test")
            .tags(vec![d_tag])
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        let d_value = DynamoEventRepository::extract_d_tag(&event);
        assert_eq!(d_value, Some("my-identifier".to_string()));
    }

    // dタグ抽出（dタグなし）のテスト
    #[test]
    fn test_extract_d_tag_none() {
        let keys = Keys::generate();
        let event = EventBuilder::new(Kind::TextNote, "test")
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        let d_value = DynamoEventRepository::extract_d_tag(&event);
        assert!(d_value.is_none());
    }

    // 英字1文字タグ抽出のテスト (要件 13.1)
    #[test]
    fn test_extract_single_letter_tags() {
        let keys = Keys::generate();
        let e_tag = nostr::Tag::parse(["e", &"a".repeat(64)]).unwrap();
        let p_tag = nostr::Tag::parse(["p", &"b".repeat(64)]).unwrap();
        let event = EventBuilder::new(Kind::TextNote, "test")
            .tags(vec![e_tag, p_tag])
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        let tags = DynamoEventRepository::extract_single_letter_tags(&event);
        assert_eq!(tags.len(), 2);
        assert!(tags.iter().any(|(name, value)| name == "e" && value == &"a".repeat(64)));
        assert!(tags.iter().any(|(name, value)| name == "p" && value == &"b".repeat(64)));
    }

    // 同じタグ名の複数タグ（最初の値のみ抽出）のテスト
    #[test]
    fn test_extract_single_letter_tags_first_only() {
        let keys = Keys::generate();
        let e_tag1 = nostr::Tag::parse(["e", "first"]).unwrap();
        let e_tag2 = nostr::Tag::parse(["e", "second"]).unwrap();
        let event = EventBuilder::new(Kind::TextNote, "test")
            .tags(vec![e_tag1, e_tag2])
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        let tags = DynamoEventRepository::extract_single_letter_tags(&event);
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0], ("e".to_string(), "first".to_string()));
    }

    // イベントシリアライズ/デシリアライズのテスト
    #[test]
    fn test_serialize_deserialize_event() {
        let keys = Keys::generate();
        let event = EventBuilder::text_note("test content")
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        let json = DynamoEventRepository::serialize_event(&event).unwrap();
        let deserialized = DynamoEventRepository::deserialize_event(&json).unwrap();

        assert_eq!(event.id, deserialized.id);
        assert_eq!(event.pubkey, deserialized.pubkey);
        assert_eq!(event.content, deserialized.content);
    }

    // 不正なJSONのデシリアライズエラーテスト
    #[test]
    fn test_deserialize_invalid_json() {
        let result = DynamoEventRepository::deserialize_event("invalid json");
        assert!(result.is_err());
        match result.unwrap_err() {
            EventRepositoryError::SerializationError(_) => {}
            _ => panic!("Expected SerializationError"),
        }
    }

    // ==================== モックイベントリポジトリ ====================

    /// ユニットテスト用のモックEventRepository
    #[derive(Debug, Clone)]
    pub struct MockEventRepository {
        /// 保存されたイベント: event_id -> Event
        events: Arc<Mutex<HashMap<String, Event>>>,
        /// Replaceableイベント: pk_kind -> event_id
        replaceable_index: Arc<Mutex<HashMap<String, String>>>,
        /// Addressableイベント: pk_kind_d -> event_id
        addressable_index: Arc<Mutex<HashMap<String, String>>>,
        /// 次の操作で返すエラー（エラーパスのテスト用）
        next_error: Arc<Mutex<Option<EventRepositoryError>>>,
    }

    impl MockEventRepository {
        pub fn new() -> Self {
            Self {
                events: Arc::new(Mutex::new(HashMap::new())),
                replaceable_index: Arc::new(Mutex::new(HashMap::new())),
                addressable_index: Arc::new(Mutex::new(HashMap::new())),
                next_error: Arc::new(Mutex::new(None)),
            }
        }

        pub fn set_next_error(&self, error: EventRepositoryError) {
            *self.next_error.lock().unwrap() = Some(error);
        }

        pub fn event_count(&self) -> usize {
            self.events.lock().unwrap().len()
        }

        pub fn get_event_sync(&self, event_id: &str) -> Option<Event> {
            self.events.lock().unwrap().get(event_id).cloned()
        }

        fn take_error(&self) -> Option<EventRepositoryError> {
            self.next_error.lock().unwrap().take()
        }
    }

    /// MockEventRepositoryのQueryRepository実装
    ///
    /// Task 4.3: QueryRepository互換性維持
    #[async_trait]
    impl QueryRepository for MockEventRepository {
        async fn query(
            &self,
            filters: &[Filter],
            limit: Option<u32>,
        ) -> Result<Vec<Event>, QueryRepositoryError> {
            if let Some(error) = self.take_error() {
                return Err(QueryRepositoryError::from(error));
            }

            let events = self.events.lock().unwrap();
            let mut result: Vec<Event> = events
                .values()
                .filter(|event| {
                    filters.is_empty() || FilterEvaluator::matches_any(event, filters)
                })
                .cloned()
                .collect();

            // ソート: created_at降順、同一タイムスタンプはid辞書順
            result.sort_by(|a, b| {
                match b.created_at.cmp(&a.created_at) {
                    std::cmp::Ordering::Equal => a.id.to_hex().cmp(&b.id.to_hex()),
                    other => other,
                }
            });

            // limit適用
            if let Some(limit) = limit {
                result.truncate(limit as usize);
            }

            Ok(result)
        }
    }

    /// MockEventRepositoryのEventRepository実装
    #[async_trait]
    impl EventRepository for MockEventRepository {
        async fn save(&self, event: &Event) -> Result<SaveResult, EventRepositoryError> {
            if let Some(error) = self.take_error() {
                return Err(error);
            }

            let event_id = event.id.to_hex();
            let kind = EventKind::classify(event.kind.as_u16());

            // Ephemeralイベントは保存しない
            if kind == EventKind::Ephemeral {
                return Ok(SaveResult::Saved);
            }

            // 重複チェック
            if self.events.lock().unwrap().contains_key(&event_id) {
                return Ok(SaveResult::Duplicate);
            }

            match kind {
                EventKind::Regular => {
                    self.events
                        .lock()
                        .unwrap()
                        .insert(event_id, event.clone());
                    Ok(SaveResult::Saved)
                }
                EventKind::Replaceable => {
                    let pk_kind = DynamoEventRepository::build_pk_kind(event);
                    let mut replaceable = self.replaceable_index.lock().unwrap();
                    let mut events = self.events.lock().unwrap();

                    if let Some(existing_id) = replaceable.get(&pk_kind).cloned() {
                        if let Some(existing) = events.get(&existing_id) {
                            // created_at比較
                            if event.created_at < existing.created_at {
                                return Ok(SaveResult::Duplicate);
                            }
                            if event.created_at == existing.created_at
                                && event.id.to_hex() >= existing.id.to_hex()
                            {
                                return Ok(SaveResult::Duplicate);
                            }
                            // 既存を削除
                            events.remove(&existing_id);
                        }
                        // 新しいイベントを保存
                        events.insert(event_id.clone(), event.clone());
                        replaceable.insert(pk_kind, event_id);
                        Ok(SaveResult::Replaced)
                    } else {
                        events.insert(event_id.clone(), event.clone());
                        replaceable.insert(pk_kind, event_id);
                        Ok(SaveResult::Saved)
                    }
                }
                EventKind::Addressable => {
                    let pk_kind_d = DynamoEventRepository::build_pk_kind_d(event);
                    let mut addressable = self.addressable_index.lock().unwrap();
                    let mut events = self.events.lock().unwrap();

                    if let Some(existing_id) = addressable.get(&pk_kind_d).cloned() {
                        if let Some(existing) = events.get(&existing_id) {
                            // created_at比較
                            if event.created_at < existing.created_at {
                                return Ok(SaveResult::Duplicate);
                            }
                            if event.created_at == existing.created_at
                                && event.id.to_hex() >= existing.id.to_hex()
                            {
                                return Ok(SaveResult::Duplicate);
                            }
                            // 既存を削除
                            events.remove(&existing_id);
                        }
                        // 新しいイベントを保存
                        events.insert(event_id.clone(), event.clone());
                        addressable.insert(pk_kind_d, event_id);
                        Ok(SaveResult::Replaced)
                    } else {
                        events.insert(event_id.clone(), event.clone());
                        addressable.insert(pk_kind_d, event_id);
                        Ok(SaveResult::Saved)
                    }
                }
                EventKind::Ephemeral => Ok(SaveResult::Saved),
            }
        }

        async fn get_by_id(&self, event_id: &str) -> Result<Option<Event>, EventRepositoryError> {
            if let Some(error) = self.take_error() {
                return Err(error);
            }

            Ok(self.events.lock().unwrap().get(event_id).cloned())
        }
    }

    // ==================== モックリポジトリを使用したテスト ====================

    // テストイベント作成ヘルパー
    fn create_test_event(content: &str) -> Event {
        let keys = Keys::generate();
        EventBuilder::text_note(content)
            .sign_with_keys(&keys)
            .expect("Failed to create event")
    }

    fn create_test_event_with_keys(keys: &Keys, content: &str) -> Event {
        EventBuilder::text_note(content)
            .sign_with_keys(keys)
            .expect("Failed to create event")
    }

    fn create_replaceable_event(keys: &Keys, kind: u16, content: &str) -> Event {
        EventBuilder::new(Kind::from(kind), content)
            .sign_with_keys(keys)
            .expect("Failed to create event")
    }

    fn create_addressable_event(keys: &Keys, kind: u16, d_tag: &str, content: &str) -> Event {
        let tag = nostr::Tag::parse(["d", d_tag]).unwrap();
        EventBuilder::new(Kind::from(kind), content)
            .tags(vec![tag])
            .sign_with_keys(keys)
            .expect("Failed to create event")
    }

    // Regular イベント保存テスト (要件 9.1, 16.1, 16.2, 16.3)
    #[tokio::test]
    async fn test_mock_repo_save_regular_event() {
        let repo = MockEventRepository::new();
        let event = create_test_event("test content");
        let event_id = event.id.to_hex();

        let result = repo.save(&event).await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), SaveResult::Saved);
        assert_eq!(repo.event_count(), 1);

        let saved = repo.get_event_sync(&event_id).unwrap();
        assert_eq!(saved.content, "test content");
    }

    // 重複イベント検出テスト (要件 16.1)
    #[tokio::test]
    async fn test_mock_repo_save_duplicate_event() {
        let repo = MockEventRepository::new();
        let event = create_test_event("test content");

        let result1 = repo.save(&event).await;
        assert_eq!(result1.unwrap(), SaveResult::Saved);

        let result2 = repo.save(&event).await;
        assert_eq!(result2.unwrap(), SaveResult::Duplicate);

        assert_eq!(repo.event_count(), 1);
    }

    // Replaceable イベント保存テスト (要件 10.2, 10.3, 16.6)
    #[tokio::test]
    async fn test_mock_repo_save_replaceable_event() {
        let repo = MockEventRepository::new();
        let keys = Keys::generate();

        // 最初のReplaceableイベント（kind 0 = Metadata）
        let event1 = create_replaceable_event(&keys, 0, "first");
        let result1 = repo.save(&event1).await;
        assert_eq!(result1.unwrap(), SaveResult::Saved);
        assert_eq!(repo.event_count(), 1);

        // 同じpubkey+kindで新しいイベント
        // 新しいイベントはcreated_atが同じか新しい場合のみ置換
        std::thread::sleep(std::time::Duration::from_millis(1100)); // 1秒以上待機
        let event2 = create_replaceable_event(&keys, 0, "second");
        let result2 = repo.save(&event2).await;

        // event2のcreated_atがevent1より新しければReplaced
        if event2.created_at > event1.created_at {
            assert_eq!(result2.unwrap(), SaveResult::Replaced);
            assert_eq!(repo.event_count(), 1);

            // 保存されているのは新しいイベント
            let saved = repo.events.lock().unwrap();
            let stored_event = saved.values().next().unwrap();
            assert_eq!(stored_event.content, "second");
        }
    }

    // Replaceable イベントの古いイベントは保存されないテスト (要件 10.2)
    #[tokio::test]
    async fn test_mock_repo_replaceable_older_not_saved() {
        let repo = MockEventRepository::new();
        let keys = Keys::generate();

        // 新しいタイムスタンプで最初のイベントを作成
        let event1 = EventBuilder::new(Kind::Metadata, "newer")
            .custom_created_at(Timestamp::from_secs(2000000000))
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        repo.save(&event1).await.unwrap();

        // 古いタイムスタンプで2番目のイベントを作成
        let event2 = EventBuilder::new(Kind::Metadata, "older")
            .custom_created_at(Timestamp::from_secs(1000000000))
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        let result = repo.save(&event2).await;
        assert_eq!(result.unwrap(), SaveResult::Duplicate);

        // 保存されているのは新しいイベントのまま
        assert_eq!(repo.event_count(), 1);
        let saved = repo.events.lock().unwrap();
        let stored_event = saved.values().next().unwrap();
        assert_eq!(stored_event.content, "newer");
    }

    // 同一タイムスタンプのReplaceableイベント（ID辞書順テスト） (要件 10.3)
    #[tokio::test]
    async fn test_mock_repo_replaceable_same_timestamp_id_comparison() {
        let repo = MockEventRepository::new();
        let keys = Keys::generate();
        let timestamp = Timestamp::from_secs(1700000000);

        // 同じタイムスタンプで2つのイベントを作成
        let event1 = EventBuilder::new(Kind::Metadata, "first")
            .custom_created_at(timestamp)
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        let event2 = EventBuilder::new(Kind::Metadata, "second")
            .custom_created_at(timestamp)
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        // ID辞書順で先のものを判定
        let (first_event, second_event) = if event1.id.to_hex() < event2.id.to_hex() {
            (event1, event2)
        } else {
            (event2, event1)
        };

        // 辞書順で後のイベントを先に保存
        repo.save(&second_event).await.unwrap();
        assert_eq!(repo.event_count(), 1);

        // 辞書順で先のイベントを後から保存→置換される
        let result = repo.save(&first_event).await;
        assert_eq!(result.unwrap(), SaveResult::Replaced);

        // 辞書順で先のイベントが保持される
        let saved = repo.events.lock().unwrap();
        let stored_event = saved.values().next().unwrap();
        assert_eq!(stored_event.id, first_event.id);
    }

    // Addressable イベント保存テスト (要件 12.2, 16.7)
    #[tokio::test]
    async fn test_mock_repo_save_addressable_event() {
        let repo = MockEventRepository::new();
        let keys = Keys::generate();

        let event1 = create_addressable_event(&keys, 30000, "identifier", "first");
        let result1 = repo.save(&event1).await;
        assert_eq!(result1.unwrap(), SaveResult::Saved);

        // 同じpubkey+kind+d_tagで新しいイベント
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let event2 = create_addressable_event(&keys, 30000, "identifier", "second");
        let result2 = repo.save(&event2).await;

        if event2.created_at > event1.created_at {
            assert_eq!(result2.unwrap(), SaveResult::Replaced);
            assert_eq!(repo.event_count(), 1);
        }
    }

    // 異なるd_tagのAddressableイベントは別々に保存されるテスト
    #[tokio::test]
    async fn test_mock_repo_addressable_different_d_tag() {
        let repo = MockEventRepository::new();
        let keys = Keys::generate();

        let event1 = create_addressable_event(&keys, 30000, "id1", "first");
        let event2 = create_addressable_event(&keys, 30000, "id2", "second");

        repo.save(&event1).await.unwrap();
        repo.save(&event2).await.unwrap();

        // 異なるd_tagなので両方保存される
        assert_eq!(repo.event_count(), 2);
    }

    // Ephemeral イベントは保存されないテスト (要件 11.1, 11.2)
    #[tokio::test]
    async fn test_mock_repo_ephemeral_not_stored() {
        let repo = MockEventRepository::new();
        let keys = Keys::generate();

        let event = EventBuilder::new(Kind::from(20000), "ephemeral content")
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        let result = repo.save(&event).await;
        assert_eq!(result.unwrap(), SaveResult::Saved);

        // 実際には保存されない
        assert_eq!(repo.event_count(), 0);
    }

    // クエリテスト - フィルターなし (要件 16.4)
    #[tokio::test]
    async fn test_mock_repo_query_no_filter() {
        let repo = MockEventRepository::new();

        let event1 = create_test_event("event 1");
        let event2 = create_test_event("event 2");
        let event3 = create_test_event("event 3");

        repo.save(&event1).await.unwrap();
        repo.save(&event2).await.unwrap();
        repo.save(&event3).await.unwrap();

        let result = repo.query(&[], None).await.unwrap();
        assert_eq!(result.len(), 3);
    }

    // クエリテスト - kindsフィルター
    #[tokio::test]
    async fn test_mock_repo_query_with_kinds_filter() {
        let repo = MockEventRepository::new();
        let keys = Keys::generate();

        let event1 = create_test_event_with_keys(&keys, "text note");
        let event2 = EventBuilder::new(Kind::Metadata, "metadata")
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        repo.save(&event1).await.unwrap();
        repo.save(&event2).await.unwrap();

        let filter = Filter::new().kind(Kind::TextNote);
        let result = repo.query(&[filter], None).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].kind, Kind::TextNote);
    }

    // クエリテスト - limit (要件 8.7)
    #[tokio::test]
    async fn test_mock_repo_query_with_limit() {
        let repo = MockEventRepository::new();

        for i in 0..10 {
            let event = create_test_event(&format!("event {}", i));
            repo.save(&event).await.unwrap();
        }

        let result = repo.query(&[], Some(5)).await.unwrap();
        assert_eq!(result.len(), 5);
    }

    // クエリテスト - created_at降順ソート (要件 8.10)
    #[tokio::test]
    async fn test_mock_repo_query_sorted_by_created_at_desc() {
        let repo = MockEventRepository::new();
        let keys = Keys::generate();

        let event1 = EventBuilder::text_note("old")
            .custom_created_at(Timestamp::from_secs(1000000000))
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        let event2 = EventBuilder::text_note("new")
            .custom_created_at(Timestamp::from_secs(2000000000))
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        let event3 = EventBuilder::text_note("middle")
            .custom_created_at(Timestamp::from_secs(1500000000))
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        repo.save(&event1).await.unwrap();
        repo.save(&event2).await.unwrap();
        repo.save(&event3).await.unwrap();

        let result = repo.query(&[], None).await.unwrap();

        assert_eq!(result[0].content, "new");
        assert_eq!(result[1].content, "middle");
        assert_eq!(result[2].content, "old");
    }

    // get_by_idテスト
    #[tokio::test]
    async fn test_mock_repo_get_by_id() {
        let repo = MockEventRepository::new();
        let event = create_test_event("test content");
        let event_id = event.id.to_hex();

        repo.save(&event).await.unwrap();

        let result = repo.get_by_id(&event_id).await.unwrap();
        assert!(result.is_some());
        assert_eq!(result.unwrap().content, "test content");
    }

    // get_by_id - 存在しないイベントテスト
    #[tokio::test]
    async fn test_mock_repo_get_by_id_not_found() {
        let repo = MockEventRepository::new();

        let result = repo.get_by_id("nonexistent").await.unwrap();
        assert!(result.is_none());
    }

    // エラーパスのテスト (要件 16.8)
    #[tokio::test]
    async fn test_mock_repo_save_error() {
        let repo = MockEventRepository::new();
        repo.set_next_error(EventRepositoryError::WriteError(
            "DynamoDB unavailable".to_string(),
        ));

        let event = create_test_event("test");
        let result = repo.save(&event).await;

        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            EventRepositoryError::WriteError("DynamoDB unavailable".to_string())
        );
    }

    #[tokio::test]
    async fn test_mock_repo_query_error() {
        let repo = MockEventRepository::new();
        repo.set_next_error(EventRepositoryError::ReadError(
            "DynamoDB unavailable".to_string(),
        ));

        let result = repo.query(&[], None).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_mock_repo_get_by_id_error() {
        let repo = MockEventRepository::new();
        repo.set_next_error(EventRepositoryError::ReadError(
            "DynamoDB unavailable".to_string(),
        ));

        let result = repo.get_by_id("test").await;

        assert!(result.is_err());
    }

    // 複数フィルターのORテスト (要件 8.9)
    #[tokio::test]
    async fn test_mock_repo_query_multiple_filters_or() {
        let repo = MockEventRepository::new();
        let keys = Keys::generate();

        // kind=1のイベント
        let event1 = create_test_event_with_keys(&keys, "text note");
        // kind=0のイベント
        let event2 = EventBuilder::new(Kind::Metadata, "metadata")
            .sign_with_keys(&keys)
            .expect("Failed to create event");
        // kind=3のイベント
        let event3 = EventBuilder::new(Kind::ContactList, "contacts")
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        repo.save(&event1).await.unwrap();
        repo.save(&event2).await.unwrap();
        repo.save(&event3).await.unwrap();

        // kind=1 OR kind=0のフィルター
        let filters = vec![
            Filter::new().kind(Kind::TextNote),
            Filter::new().kind(Kind::Metadata),
        ];

        let result = repo.query(&filters, None).await.unwrap();
        assert_eq!(result.len(), 2);
    }

    // authorsフィルターテスト (要件 8.2, 13.2)
    #[tokio::test]
    async fn test_mock_repo_query_authors_filter() {
        let repo = MockEventRepository::new();
        let keys1 = Keys::generate();
        let keys2 = Keys::generate();

        let event1 = create_test_event_with_keys(&keys1, "from keys1");
        let event2 = create_test_event_with_keys(&keys2, "from keys2");

        repo.save(&event1).await.unwrap();
        repo.save(&event2).await.unwrap();

        let filter = Filter::new().author(keys1.public_key());
        let result = repo.query(&[filter], None).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].pubkey, keys1.public_key());
    }
}
