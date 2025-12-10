// HttpSqliteIndexer - DynamoDB StreamsからHTTP SQLiteへのインデックス処理
//
// DynamoDB Streamsイベントを受け取り、IndexerClientを使用してEC2 HTTP APIに
// イベントを登録/削除する。OpenSearch Indexerと同様のインターフェースを提供。
//
// 要件: 5.3, 5.4

use super::indexer_client::{HttpSqliteIndexerError as ClientError, IndexerClient};
use aws_lambda_events::event::dynamodb::{Event, EventRecord};
use nostr::Event as NostrEvent;
use serde_dynamo::AttributeValue;
use thiserror::Error;
use tracing::{debug, error, info, warn};

/// HttpSqliteIndexerのプロセスエラー型
///
/// # エラー種別
/// - `MissingEventJson`: event_jsonフィールドが欠損
/// - `MissingEventId`: イベントIDが欠損
/// - `DeserializationError`: イベントのデシリアライズに失敗
/// - `ClientError`: IndexerClientエラー
#[derive(Debug, Error)]
pub enum HttpSqliteIndexerProcessError {
    /// event_jsonが欠損しています
    #[error("event_jsonが欠損しています: {0}")]
    MissingEventJson(String),

    /// イベントIDが欠損しています
    #[error("イベントIDが欠損しています: {0}")]
    MissingEventId(String),

    /// イベントのデシリアライズに失敗
    #[error("イベントのデシリアライズに失敗: {0}")]
    DeserializationError(String),

    /// IndexerClientエラー
    #[error("IndexerClientエラー: {0}")]
    ClientError(#[from] ClientError),
}

/// インデックス処理の結果
///
/// DynamoDB Streamsイベント処理の成功/失敗/スキップ件数を保持
#[derive(Debug, Clone)]
pub struct HttpSqliteIndexerResult {
    /// 処理に成功したレコード数
    pub success_count: usize,
    /// 処理に失敗したレコード数
    pub failure_count: usize,
    /// スキップしたレコード数（event_json欠損等）
    pub skip_count: usize,
}

impl HttpSqliteIndexerResult {
    /// 新しいHttpSqliteIndexerResultを作成
    pub fn new() -> Self {
        Self {
            success_count: 0,
            failure_count: 0,
            skip_count: 0,
        }
    }
}

impl Default for HttpSqliteIndexerResult {
    fn default() -> Self {
        Self::new()
    }
}

/// 処理アクション
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HttpSqliteProcessAction {
    /// インデックス化した
    Indexed,
    /// 削除した
    Deleted,
    /// スキップした（理由を含む）
    Skipped(String),
}

/// HTTP SQLite Indexer
///
/// DynamoDB StreamsイベントをEC2 HTTP APIに送信してSQLiteにインデックス化する。
/// IndexerClientを使用して再試行とエラーハンドリングを行う。
///
/// # 要件
/// - 5.3: INSERT/MODIFYイベントでPOST /eventsにイベントを送信
/// - 5.4: REMOVEイベントでDELETE /events/{id}にリクエストを送信
pub struct HttpSqliteIndexer {
    /// IndexerClient - EC2 HTTP APIクライアント
    client: IndexerClient,
}

impl HttpSqliteIndexer {
    /// 新しいHttpSqliteIndexerを作成
    ///
    /// # 引数
    /// * `client` - IndexerClient
    pub fn new(client: IndexerClient) -> Self {
        Self { client }
    }

    /// DynamoDB Streamsイベントを処理
    ///
    /// # Arguments
    /// * `event` - DynamoDB Streamsイベント
    ///
    /// # Returns
    /// * `HttpSqliteIndexerResult` - 処理結果（成功/失敗/スキップ件数）
    pub async fn process_event(&self, event: Event) -> HttpSqliteIndexerResult {
        let record_count = event.records.len();
        info!(record_count = record_count, "DynamoDB Streamsイベント処理開始");

        let mut result = HttpSqliteIndexerResult::new();

        for record in event.records {
            match self.process_record(&record).await {
                Ok(HttpSqliteProcessAction::Indexed) => {
                    result.success_count += 1;
                }
                Ok(HttpSqliteProcessAction::Deleted) => {
                    result.success_count += 1;
                }
                Ok(HttpSqliteProcessAction::Skipped(reason)) => {
                    debug!(reason = %reason, "レコードをスキップ");
                    result.skip_count += 1;
                }
                Err(e) => {
                    error!(error = %e, "レコード処理に失敗");
                    result.failure_count += 1;
                }
            }
        }

        info!(
            success_count = result.success_count,
            failure_count = result.failure_count,
            skip_count = result.skip_count,
            "DynamoDB Streamsイベント処理完了"
        );

        result
    }

    /// 単一レコードを処理
    ///
    /// # Arguments
    /// * `record` - DynamoDB Streamsレコード
    ///
    /// # Returns
    /// * `Ok(HttpSqliteProcessAction)` - 処理アクション
    /// * `Err(HttpSqliteIndexerProcessError)` - 処理エラー
    async fn process_record(
        &self,
        record: &EventRecord,
    ) -> Result<HttpSqliteProcessAction, HttpSqliteIndexerProcessError> {
        let event_name = &record.event_name;

        match event_name.as_str() {
            "INSERT" | "MODIFY" => {
                // 要件 5.3: INSERTまたはMODIFYでPOST /eventsに送信
                self.index_record(record).await
            }
            "REMOVE" => {
                // 要件 5.4: REMOVEでDELETE /events/{id}に送信
                self.delete_record(record).await
            }
            _ => {
                warn!(event_name = event_name, "未知のイベントタイプ");
                Ok(HttpSqliteProcessAction::Skipped(
                    "未知のイベントタイプ".to_string(),
                ))
            }
        }
    }

    /// レコードをインデックス化（INSERT/MODIFY）
    ///
    /// # 要件
    /// - 5.3: INSERT/MODIFYイベントでPOSTを送信
    async fn index_record(
        &self,
        record: &EventRecord,
    ) -> Result<HttpSqliteProcessAction, HttpSqliteIndexerProcessError> {
        // NewImageからevent_jsonを取得
        let new_image = &record.change.new_image;
        if new_image.is_empty() {
            return Err(HttpSqliteIndexerProcessError::MissingEventJson(
                "NewImageがありません".to_string(),
            ));
        }

        let event_json = Self::extract_event_json(new_image)?;

        // NostrイベントをデシリアライズしてIndexerClientで送信
        let nostr_event: NostrEvent = serde_json::from_str(&event_json).map_err(|e| {
            HttpSqliteIndexerProcessError::DeserializationError(format!(
                "イベントのデシリアライズに失敗: {}",
                e
            ))
        })?;

        // IndexerClientを使用してインデックス化
        self.client.index_event(&nostr_event).await.map_err(|e| {
            error!(error = %e, "IndexerClient.index_eventエラー");
            HttpSqliteIndexerProcessError::ClientError(e)
        })?;

        debug!(event_id = %nostr_event.id, "イベントをインデックス化");

        Ok(HttpSqliteProcessAction::Indexed)
    }

    /// レコードを削除（REMOVE）
    ///
    /// # 要件
    /// - 5.4: REMOVEイベントでDELETEを送信
    async fn delete_record(
        &self,
        record: &EventRecord,
    ) -> Result<HttpSqliteProcessAction, HttpSqliteIndexerProcessError> {
        // Keysまたは OldImageからイベントIDを取得
        let event_id = Self::extract_event_id(record)?;

        // IndexerClientを使用して削除
        self.client.delete_event(&event_id).await.map_err(|e| {
            error!(error = %e, event_id = %event_id, "IndexerClient.delete_eventエラー");
            HttpSqliteIndexerProcessError::ClientError(e)
        })?;

        debug!(event_id = event_id, "イベントを削除");

        Ok(HttpSqliteProcessAction::Deleted)
    }

    /// DynamoDB ItemからイベントIDを抽出
    fn extract_event_id(record: &EventRecord) -> Result<String, HttpSqliteIndexerProcessError> {
        // まずKeysから取得を試みる
        if let Some(AttributeValue::S(id)) = record.change.keys.get("id") {
            return Ok(id.clone());
        }

        // Keysにない場合はOldImageから取得
        if let Some(AttributeValue::S(id)) = record.change.old_image.get("id") {
            return Ok(id.clone());
        }

        Err(HttpSqliteIndexerProcessError::MissingEventId(
            "KeysとOldImageの両方にイベントIDがありません".to_string(),
        ))
    }

    /// DynamoDB Itemからevent_jsonを抽出
    fn extract_event_json(
        image: &serde_dynamo::Item,
    ) -> Result<String, HttpSqliteIndexerProcessError> {
        let event_json_attr = image.get("event_json").ok_or_else(|| {
            HttpSqliteIndexerProcessError::MissingEventJson(
                "event_jsonフィールドがありません".to_string(),
            )
        })?;

        // AttributeValueからString値を取得
        match event_json_attr {
            AttributeValue::S(s) => Ok(s.clone()),
            _ => Err(HttpSqliteIndexerProcessError::MissingEventJson(
                "event_jsonがString型ではありません".to_string(),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_lambda_events::event::dynamodb::StreamRecord;
    use serde_dynamo::Item;
    use std::collections::HashMap;

    // ==================== ヘルパー関数 ====================

    /// テスト用のDynamoDB Itemを作成
    fn create_item(attrs: Vec<(&str, AttributeValue)>) -> Item {
        let mut map: HashMap<String, AttributeValue> = HashMap::new();
        for (key, value) in attrs {
            map.insert(key.to_string(), value);
        }
        Item::from(map)
    }

    /// テスト用の文字列AttributeValueを作成
    fn string_attr(value: &str) -> AttributeValue {
        AttributeValue::S(value.to_string())
    }

    /// テスト用のNostrイベントJSONを作成
    fn create_test_event_json() -> String {
        use nostr::{EventBuilder, Keys, Kind};

        let keys = Keys::generate();
        let event = EventBuilder::new(Kind::TextNote, "Test content")
            .sign_with_keys(&keys)
            .expect("イベント署名に失敗");

        serde_json::to_string(&event).expect("シリアライズに失敗")
    }

    /// テスト用のデフォルトStreamRecordを作成
    fn create_default_stream_record() -> StreamRecord {
        use chrono::{TimeZone, Utc};
        StreamRecord {
            approximate_creation_date_time: Utc.timestamp_opt(0, 0).unwrap(),
            keys: Item::from(HashMap::new()),
            new_image: Item::from(HashMap::new()),
            old_image: Item::from(HashMap::new()),
            sequence_number: None,
            size_bytes: 0,
            stream_view_type: None,
        }
    }

    /// テスト用のデフォルトEventRecordを作成
    fn create_default_event_record() -> EventRecord {
        EventRecord {
            aws_region: String::new(),
            change: create_default_stream_record(),
            event_id: String::new(),
            event_name: String::new(),
            event_source: None,
            event_source_arn: None,
            event_version: None,
            user_identity: None,
            record_format: None,
            table_name: None,
        }
    }

    // ==================== extract_event_json テスト ====================

    #[test]
    fn test_extract_event_json_success() {
        // 正常なevent_json抽出
        let event_json = create_test_event_json();
        let image = create_item(vec![
            ("id", string_attr("test_event_id")),
            ("event_json", string_attr(&event_json)),
        ]);

        let result = HttpSqliteIndexer::extract_event_json(&image);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), event_json);
    }

    #[test]
    fn test_extract_event_json_missing_field() {
        // event_jsonフィールドがない場合
        let image = create_item(vec![("id", string_attr("test_id"))]);

        let result = HttpSqliteIndexer::extract_event_json(&image);
        assert!(result.is_err());
        match result.unwrap_err() {
            HttpSqliteIndexerProcessError::MissingEventJson(msg) => {
                assert!(msg.contains("event_json"));
            }
            other => panic!("予期しないエラー型: {:?}", other),
        }
    }

    #[test]
    fn test_extract_event_json_wrong_type() {
        // event_jsonが文字列型でない場合
        let image = create_item(vec![("event_json", AttributeValue::N("123".to_string()))]);

        let result = HttpSqliteIndexer::extract_event_json(&image);
        assert!(result.is_err());
        match result.unwrap_err() {
            HttpSqliteIndexerProcessError::MissingEventJson(msg) => {
                assert!(msg.contains("String型"));
            }
            other => panic!("予期しないエラー型: {:?}", other),
        }
    }

    // ==================== extract_event_id テスト ====================

    #[test]
    fn test_extract_event_id_from_keys() {
        // KeysからイベントIDを取得
        let keys = create_item(vec![("id", string_attr("test_event_id"))]);

        let record = EventRecord {
            event_name: "REMOVE".to_string(),
            change: StreamRecord {
                keys,
                old_image: Item::from(HashMap::new()),
                new_image: Item::from(HashMap::new()),
                ..create_default_stream_record()
            },
            ..create_default_event_record()
        };

        let result = HttpSqliteIndexer::extract_event_id(&record);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "test_event_id");
    }

    #[test]
    fn test_extract_event_id_from_old_image() {
        // OldImageからイベントIDを取得（Keysが空の場合）
        let old_image = create_item(vec![("id", string_attr("old_event_id"))]);

        let record = EventRecord {
            event_name: "REMOVE".to_string(),
            change: StreamRecord {
                keys: Item::from(HashMap::new()),
                old_image,
                new_image: Item::from(HashMap::new()),
                ..create_default_stream_record()
            },
            ..create_default_event_record()
        };

        let result = HttpSqliteIndexer::extract_event_id(&record);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "old_event_id");
    }

    #[test]
    fn test_extract_event_id_not_found() {
        // イベントIDが見つからない場合
        let record = EventRecord {
            event_name: "REMOVE".to_string(),
            change: StreamRecord {
                keys: Item::from(HashMap::new()),
                old_image: Item::from(HashMap::new()),
                new_image: Item::from(HashMap::new()),
                ..create_default_stream_record()
            },
            ..create_default_event_record()
        };

        let result = HttpSqliteIndexer::extract_event_id(&record);
        assert!(result.is_err());
        match result.unwrap_err() {
            HttpSqliteIndexerProcessError::MissingEventId(msg) => {
                assert!(msg.contains("イベントID"));
            }
            other => panic!("予期しないエラー型: {:?}", other),
        }
    }

    // ==================== HttpSqliteProcessAction テスト ====================

    #[test]
    fn test_process_action_equality() {
        assert_eq!(
            HttpSqliteProcessAction::Indexed,
            HttpSqliteProcessAction::Indexed
        );
        assert_eq!(
            HttpSqliteProcessAction::Deleted,
            HttpSqliteProcessAction::Deleted
        );
        assert_eq!(
            HttpSqliteProcessAction::Skipped("reason".to_string()),
            HttpSqliteProcessAction::Skipped("reason".to_string())
        );
        assert_ne!(
            HttpSqliteProcessAction::Indexed,
            HttpSqliteProcessAction::Deleted
        );
    }

    // ==================== HttpSqliteIndexerResult テスト ====================

    #[test]
    fn test_indexer_result_new() {
        let result = HttpSqliteIndexerResult::new();
        assert_eq!(result.success_count, 0);
        assert_eq!(result.failure_count, 0);
        assert_eq!(result.skip_count, 0);
    }

    #[test]
    fn test_indexer_result_default() {
        let result = HttpSqliteIndexerResult::default();
        assert_eq!(result.success_count, 0);
        assert_eq!(result.failure_count, 0);
        assert_eq!(result.skip_count, 0);
    }

    // ==================== エラー型テスト ====================

    #[test]
    fn test_error_display_missing_event_json() {
        let error = HttpSqliteIndexerProcessError::MissingEventJson("テスト".to_string());
        assert!(error.to_string().contains("event_json"));
        assert!(error.to_string().contains("欠損"));
    }

    #[test]
    fn test_error_display_missing_event_id() {
        let error = HttpSqliteIndexerProcessError::MissingEventId("テスト".to_string());
        assert!(error.to_string().contains("イベントID"));
        assert!(error.to_string().contains("欠損"));
    }

    #[test]
    fn test_error_display_deserialization() {
        let error = HttpSqliteIndexerProcessError::DeserializationError("テスト".to_string());
        assert!(error.to_string().contains("デシリアライズ"));
    }
}
