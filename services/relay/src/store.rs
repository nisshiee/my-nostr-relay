//! イベントストレージの抽象化
//!
//! - `EventStore` trait: ストレージの抽象インターフェース
//! - `InMemoryEventStore`: インメモリ実装（開発・テスト用）
//! - `DynamoEventStore`: DynamoDB永続化実装（本番用、`dynamo` feature有効時のみ）

#[cfg(feature = "dynamo")]
mod dynamo;
mod in_memory;

// Re-exports
#[cfg(feature = "dynamo")]
pub use dynamo::DynamoEventStore;
pub use in_memory::InMemoryEventStore;

use std::sync::Arc;

use crate::models::{Event, Filter, VerifiedEvent};
use crate::owner_priority::OwnerPriority;

#[cfg(feature = "dynamo")]
use tracing::debug;
#[cfg(not(feature = "dynamo"))]
use tracing::debug;

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

/// feature flagによるEventStore型の切り替え（静的ディスパッチ）
#[cfg(feature = "dynamo")]
pub type AppEventStore = DynamoEventStore;
#[cfg(not(feature = "dynamo"))]
pub type AppEventStore = InMemoryEventStore;

/// EventStoreのファクトリ関数（feature flagによる切り替え）
///
/// ストアとオーナー優先度のペアを返す。
/// オーナー優先度はWebSocketハンドラでcreated_atバリデーションの免除判定に使用する。
pub async fn create_event_store() -> Result<(AppEventStore, Arc<OwnerPriority>), StoreError> {
    #[cfg(feature = "dynamo")]
    {
        let table_name = std::env::var("DYNAMODB_TABLE_NAME")
            .unwrap_or_else(|_| "nostr_relay_events".to_string());

        debug!("DynamoEventStoreを初期化中 (table: {})", table_name);
        let store = DynamoEventStore::new(table_name).await?;
        let owner_priority = store.owner_priority();
        Ok((store, owner_priority))
    }

    #[cfg(not(feature = "dynamo"))]
    {
        debug!("InMemoryEventStoreを初期化中");
        let owner_priority = Arc::new(OwnerPriority::new(std::env::var("RELAY_PUBKEY").ok()));
        Ok((InMemoryEventStore::new(), owner_priority))
    }
}
