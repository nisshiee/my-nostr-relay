//! Relay構造体（EventStore + broadcast sender）

use std::time::Instant;

use tokio::sync::broadcast;
use tracing::{debug, instrument};

use crate::models::{Event, Filter, VerifiedEvent};
use crate::store::{EventStore, InMemoryEventStore, SaveResult, StoreError};

/// broadcast チャネルのキャパシティ
const BROADCAST_CAPACITY: usize = 1024;

/// Nostr Relay のコア構造体
///
/// イベントの永続化と配信を担う
pub struct Relay<S: EventStore = InMemoryEventStore> {
    /// イベントストレージ（抽象化）
    store: S,
    /// イベント配信用 broadcast sender
    event_tx: broadcast::Sender<Event>,
}

impl<S: EventStore> Relay<S> {
    /// 新しい Relay を作成
    ///
    /// # 引数
    ///
    /// * `store` - イベントストレージの実装
    pub fn new(store: S) -> Self {
        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        Self { store, event_tx }
    }


    /// イベントを保存し、成功したら broadcast で配信
    ///
    /// # 戻り値
    ///
    /// * `Ok(SaveResult::Saved)` - 新規イベントとして保存・配信完了
    /// * `Ok(SaveResult::Replaced)` - 既存イベントを置換・配信完了
    /// * `Ok(SaveResult::Duplicate)` - 既存イベント（配信なし）
    /// * `Ok(SaveResult::Ignored)` - 古いイベント（配信なし）
    /// * `Err(StoreError)` - ストレージエラー
    ///
    /// # Ephemeral イベント
    ///
    /// Ephemeral イベント (kind 20000-29999) は保存せず配信のみ行う
    #[instrument(skip(self, event), fields(event_id = %event.inner().id, kind = event.inner().kind.as_u16()))]
    pub async fn publish(&self, event: VerifiedEvent) -> Result<SaveResult, StoreError> {
        let start = Instant::now();

        // Ephemeral イベント: 保存せず配信のみ
        if event.kind.is_ephemeral() {
            let _ = self.event_tx.send(event.into_inner());
            debug!(elapsed_ms = start.elapsed().as_millis(), "publish完了（ephemeral）");
            return Ok(SaveResult::Ephemeral);
        }

        let result = self.store.save(&event).await?;

        // Saved または Replaced の場合のみ配信
        if result == SaveResult::Saved || result == SaveResult::Replaced {
            let _ = self.event_tx.send(event.into_inner());
        }

        debug!(elapsed_ms = start.elapsed().as_millis(), result = ?result, "publish完了");
        Ok(result)
    }

    /// フィルターにマッチするイベントをクエリ（EventStore に委譲）
    #[instrument(skip(self, filters), fields(filter_count = filters.len()))]
    pub async fn query(&self, filters: &[Filter]) -> Result<Vec<Event>, StoreError> {
        let start = Instant::now();
        let events = self.store.query(filters).await?;
        debug!(
            result_count = events.len(),
            elapsed_ms = start.elapsed().as_millis(),
            "クエリ完了"
        );
        Ok(events)
    }

    /// 新しい broadcast receiver を作成（各WebSocket接続用）
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.event_tx.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::InMemoryEventStore;
    use crate::test_helpers::{create_custom_event, create_test_event, create_test_event_with_content};

    #[tokio::test]
    async fn test_publish_new_event() {
        let store = InMemoryEventStore::new();
        let relay = Relay::new(store);

        let event = create_test_event();
        let verified = event.verify().unwrap();

        let result = relay.publish(verified).await.unwrap();
        assert_eq!(result, SaveResult::Saved);
    }

    #[tokio::test]
    async fn test_publish_duplicate_event() {
        let store = InMemoryEventStore::new();
        let relay = Relay::new(store);

        let event = create_test_event();
        let verified1 = event.clone().verify().unwrap();
        let verified2 = event.verify().unwrap();

        // 最初の publish
        let result1 = relay.publish(verified1).await.unwrap();
        assert_eq!(result1, SaveResult::Saved);

        // 重複 publish
        let result2 = relay.publish(verified2).await.unwrap();
        assert_eq!(result2, SaveResult::Duplicate);
    }

    #[tokio::test]
    async fn test_broadcast_on_publish() {
        let store = InMemoryEventStore::new();
        let relay = Relay::new(store);

        // subscriber を作成
        let mut rx = relay.subscribe();

        let event = create_test_event();
        let event_id = event.id;
        let verified = event.verify().unwrap();

        // publish
        relay.publish(verified).await.unwrap();

        // broadcast で受信できるか確認
        let received = rx.recv().await.unwrap();
        assert_eq!(received.id, event_id);
    }

    #[tokio::test]
    async fn test_no_broadcast_on_duplicate() {
        let store = InMemoryEventStore::new();
        let relay = Relay::new(store);

        let event = create_test_event();
        let verified1 = event.clone().verify().unwrap();
        let verified2 = event.verify().unwrap();

        // 最初の publish
        relay.publish(verified1).await.unwrap();

        // subscriber を作成（最初の publish 後）
        let mut rx = relay.subscribe();

        // 重複 publish（broadcast されないはず）
        relay.publish(verified2).await.unwrap();

        // 受信を試みるが、タイムアウトするはず
        let result = tokio::time::timeout(std::time::Duration::from_millis(100), rx.recv()).await;
        assert!(result.is_err()); // タイムアウト
    }

    #[tokio::test]
    async fn test_query() {
        let store = InMemoryEventStore::new();
        let relay = Relay::new(store);

        let event1 = create_test_event_with_content("Event 1");
        let verified1 = event1.clone().verify().unwrap();
        relay.publish(verified1).await.unwrap();

        let event2 = create_test_event_with_content("Event 2");
        let verified2 = event2.clone().verify().unwrap();
        relay.publish(verified2).await.unwrap();

        // 全イベントをクエリ
        let filter = Filter::default();
        let results = relay.query(&[filter]).await.unwrap();
        assert_eq!(results.len(), 2);
    }

    #[tokio::test]
    async fn test_ephemeral_event_broadcast_but_not_stored() {
        let store = InMemoryEventStore::new();
        let relay = Relay::new(store);

        // subscriber を作成
        let mut rx = relay.subscribe();

        // Ephemeral イベント (kind 20000)
        let event = create_custom_event(20000, 1000, "ephemeral message", vec![]);
        let event_id = event.id;
        let verified = event.verify().unwrap();

        // publish（Ephemeral が返される）
        let result = relay.publish(verified).await.unwrap();
        assert_eq!(result, SaveResult::Ephemeral);

        // broadcast で受信できる
        let received = rx.recv().await.unwrap();
        assert_eq!(received.id, event_id);

        // しかし保存されていない
        let results = relay.query(&[Filter::default()]).await.unwrap();
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn test_replaced_event_broadcast() {
        let store = InMemoryEventStore::new();
        let relay = Relay::new(store);

        // 最初の replaceable イベント
        let old_event = create_custom_event(0, 1000, "old profile", vec![]);
        relay.publish(old_event.verify().unwrap()).await.unwrap();

        // subscriber を作成（最初のイベント後）
        let mut rx = relay.subscribe();

        // 新しい replaceable イベント
        let new_event = create_custom_event(0, 2000, "new profile", vec![]);
        let new_event_id = new_event.id;
        let verified_new = new_event.verify().unwrap();

        let result = relay.publish(verified_new).await.unwrap();
        assert_eq!(result, SaveResult::Replaced);

        // broadcast で受信できる
        let received = rx.recv().await.unwrap();
        assert_eq!(received.id, new_event_id);
    }

    #[tokio::test]
    async fn test_ignored_event_no_broadcast() {
        let store = InMemoryEventStore::new();
        let relay = Relay::new(store);

        // 新しい replaceable イベントを先に保存
        let new_event = create_custom_event(0, 2000, "new profile", vec![]);
        relay.publish(new_event.verify().unwrap()).await.unwrap();

        // subscriber を作成
        let mut rx = relay.subscribe();

        // 古い replaceable イベント（無視される）
        let old_event = create_custom_event(0, 1000, "old profile", vec![]);
        let verified_old = old_event.verify().unwrap();

        let result = relay.publish(verified_old).await.unwrap();
        assert_eq!(result, SaveResult::Ignored);

        // broadcast されない（タイムアウト）
        let result =
            tokio::time::timeout(std::time::Duration::from_millis(100), rx.recv()).await;
        assert!(result.is_err()); // タイムアウト
    }
}
