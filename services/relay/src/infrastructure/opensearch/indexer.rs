// OpenSearch Indexer - DynamoDB StreamsからOpenSearchへのインデックス処理
//
// DynamoDB Streamsイベントを受け取り、OpenSearchにインデックスを作成/削除する。
// INSERT/MODIFYイベントではNostrEventDocumentを使用してPUT、
// REMOVEイベントではDELETEを実行する。
//
// 要件: 3.1, 3.2, 3.3, 3.5, 3.6, 3.7, 8.4

use super::client::OpenSearchClient;
use super::index_document::{DocumentBuildError, NostrEventDocument};
use aws_lambda_events::event::dynamodb::{Event, EventRecord};
use nostr::Event as NostrEvent;
use opensearch::{DeleteParts, IndexParts};
use serde_dynamo::{AttributeValue, Item};
use serde_json::json;
use thiserror::Error;
use tracing::{debug, error, info, warn};

/// Indexerエラー型
#[derive(Debug, Error)]
pub enum IndexerError {
    /// イベントJSONの欠損
    #[error("event_jsonが欠損しています: {0}")]
    MissingEventJson(String),

    /// イベントのデシリアライズエラー
    #[error("イベントのデシリアライズに失敗: {0}")]
    DeserializationError(String),

    /// ドキュメント構築エラー
    #[error("ドキュメント構築に失敗: {0}")]
    DocumentBuildError(#[from] DocumentBuildError),

    /// OpenSearchエラー
    #[error("OpenSearchエラー: {0}")]
    OpenSearchError(String),
}

/// インデックス処理の結果
#[derive(Debug, Clone)]
pub struct IndexerResult {
    /// 処理に成功したレコード数
    pub success_count: usize,
    /// 処理に失敗したレコード数
    pub failure_count: usize,
    /// スキップしたレコード数（event_json欠損等）
    pub skip_count: usize,
}

impl IndexerResult {
    /// 新しいIndexerResultを作成
    pub fn new() -> Self {
        Self {
            success_count: 0,
            failure_count: 0,
            skip_count: 0,
        }
    }
}

impl Default for IndexerResult {
    fn default() -> Self {
        Self::new()
    }
}

/// DynamoDB Streams Indexer
///
/// DynamoDB StreamsイベントをOpenSearchにインデックス化する。
/// バッチ処理で複数のストリームレコードを効率的に処理する。
///
/// # 要件
/// - 3.1: INSERT/MODIFYイベントでインデックス化
/// - 3.2: REMOVEイベントでドキュメント削除
/// - 3.3: Replaceableイベントの置換対応（PUT = upsert）
/// - 3.5: 失敗時のリトライ対応（Lambda標準リトライに依存）
/// - 3.6: バッチ処理で複数レコードを効率的に処理
/// - 3.7: event_jsonをOpenSearchドキュメントに含める
/// - 8.4: インデックス処理の成功/失敗件数をログに記録
pub struct Indexer {
    /// OpenSearchクライアント
    client: OpenSearchClient,
}

impl Indexer {
    /// 新しいIndexerを作成
    pub fn new(client: OpenSearchClient) -> Self {
        Self { client }
    }

    /// DynamoDB Streamsイベントを処理
    ///
    /// # Arguments
    /// * `event` - DynamoDB Streamsイベント
    ///
    /// # Returns
    /// * `IndexerResult` - 処理結果（成功/失敗/スキップ件数）
    ///
    /// # 要件
    /// - 3.6: バッチ処理で複数レコードを効率的に処理
    /// - 8.4: インデックス処理の成功/失敗件数をログに記録
    pub async fn process_event(&self, event: Event) -> IndexerResult {
        let record_count = event.records.len();
        info!(record_count = record_count, "DynamoDB Streamsイベント処理開始");

        let mut result = IndexerResult::new();

        for record in event.records {
            match self.process_record(&record).await {
                Ok(ProcessAction::Indexed) => {
                    result.success_count += 1;
                }
                Ok(ProcessAction::Deleted) => {
                    result.success_count += 1;
                }
                Ok(ProcessAction::Skipped(reason)) => {
                    debug!(reason = %reason, "レコードをスキップ");
                    result.skip_count += 1;
                }
                Err(e) => {
                    error!(error = %e, "レコード処理に失敗");
                    result.failure_count += 1;
                }
            }
        }

        // 要件 8.4: 処理結果をログに記録
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
    /// * `Ok(ProcessAction)` - 処理アクション
    /// * `Err(IndexerError)` - 処理エラー
    async fn process_record(&self, record: &EventRecord) -> Result<ProcessAction, IndexerError> {
        let event_name = &record.event_name;

        match event_name.as_str() {
            "INSERT" | "MODIFY" => {
                // 要件 3.1, 3.3: INSERTまたはMODIFYでインデックス化
                // MODIFYも同様にPUT（upsert動作）
                self.index_record(record).await
            }
            "REMOVE" => {
                // 要件 3.2: REMOVEでドキュメント削除
                self.delete_record(record).await
            }
            _ => {
                warn!(event_name = event_name, "未知のイベントタイプ");
                Ok(ProcessAction::Skipped("未知のイベントタイプ".to_string()))
            }
        }
    }

    /// レコードをインデックス化（INSERT/MODIFY）
    ///
    /// # 要件
    /// - 3.1: INSERT/MODIFYイベントでインデックス化
    /// - 3.7: event_jsonをOpenSearchドキュメントに含める
    async fn index_record(&self, record: &EventRecord) -> Result<ProcessAction, IndexerError> {
        // NewImageからevent_jsonを取得
        let new_image = &record.change.new_image;
        if new_image.is_empty() {
            return Err(IndexerError::MissingEventJson(
                "NewImageがありません".to_string(),
            ));
        }

        let event_json = Self::extract_event_json(new_image)?;

        // NostrイベントをデシリアライズしてNostrEventDocumentを構築
        let nostr_event: NostrEvent = serde_json::from_str(&event_json).map_err(|e| {
            IndexerError::DeserializationError(format!("イベントのデシリアライズに失敗: {}", e))
        })?;

        let doc = NostrEventDocument::from_event(&nostr_event)?;

        // OpenSearchにインデックス
        let response = self
            .client
            .client()
            .index(IndexParts::IndexId(
                self.client.index_name(),
                doc.document_id(),
            ))
            .body(json!(doc))
            .send()
            .await
            .map_err(|e| {
                IndexerError::OpenSearchError(format!("インデックスリクエスト失敗: {}", e))
            })?;

        let status = response.status_code().as_u16();
        if status >= 400 {
            let body = response.text().await.unwrap_or_default();
            return Err(IndexerError::OpenSearchError(format!(
                "インデックス失敗 (status: {}): {}",
                status, body
            )));
        }

        debug!(
            event_id = doc.document_id(),
            kind = doc.kind,
            "イベントをインデックス化"
        );

        Ok(ProcessAction::Indexed)
    }

    /// レコードを削除（REMOVE）
    ///
    /// # 要件
    /// - 3.2: REMOVEイベントで対応するOpenSearchドキュメントを削除
    async fn delete_record(&self, record: &EventRecord) -> Result<ProcessAction, IndexerError> {
        // Keysまたは OldImageからイベントIDを取得
        let event_id = Self::extract_event_id(record)?;

        // OpenSearchからドキュメントを削除
        let response = self
            .client
            .client()
            .delete(DeleteParts::IndexId(self.client.index_name(), &event_id))
            .send()
            .await
            .map_err(|e| IndexerError::OpenSearchError(format!("削除リクエスト失敗: {}", e)))?;

        let status = response.status_code().as_u16();
        // 404はドキュメントが存在しない場合（既に削除済み）なので成功として扱う
        if status >= 400 && status != 404 {
            let body = response.text().await.unwrap_or_default();
            return Err(IndexerError::OpenSearchError(format!(
                "削除失敗 (status: {}): {}",
                status, body
            )));
        }

        debug!(event_id = event_id, "イベントを削除");

        Ok(ProcessAction::Deleted)
    }

    /// DynamoDB ItemからイベントIDを抽出
    fn extract_event_id(record: &EventRecord) -> Result<String, IndexerError> {
        // まずKeysから取得を試みる
        if let Some(AttributeValue::S(id)) = record.change.keys.get("id") {
            return Ok(id.clone());
        }

        // Keysにない場合はOldImageから取得
        if let Some(AttributeValue::S(id)) = record.change.old_image.get("id") {
            return Ok(id.clone());
        }

        Err(IndexerError::MissingEventJson(
            "イベントIDを取得できません".to_string(),
        ))
    }

    /// DynamoDB Itemからevent_jsonを抽出
    ///
    /// # 要件
    /// - 3.7: 完全なイベントJSON（event_json）をOpenSearchドキュメントに含める
    fn extract_event_json(image: &Item) -> Result<String, IndexerError> {
        let event_json_attr = image.get("event_json").ok_or_else(|| {
            IndexerError::MissingEventJson("event_jsonフィールドがありません".to_string())
        })?;

        // AttributeValueからString値を取得
        match event_json_attr {
            AttributeValue::S(s) => Ok(s.clone()),
            _ => Err(IndexerError::MissingEventJson(
                "event_jsonがString型ではありません".to_string(),
            )),
        }
    }
}

/// 処理アクション
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessAction {
    /// インデックス化した
    Indexed,
    /// 削除した
    Deleted,
    /// スキップした（理由を含む）
    Skipped(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_lambda_events::event::dynamodb::StreamRecord;
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

    // ==================== extract_event_json テスト ====================

    #[test]
    fn test_extract_event_json_success() {
        // 正常なevent_json抽出
        let event_json = create_test_event_json();
        let image = create_item(vec![
            ("id", string_attr("test_event_id")),
            ("event_json", string_attr(&event_json)),
        ]);

        let result = Indexer::extract_event_json(&image);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), event_json);
    }

    #[test]
    fn test_extract_event_json_missing_field() {
        // event_jsonフィールドがない場合
        let image = create_item(vec![("id", string_attr("test_id"))]);

        let result = Indexer::extract_event_json(&image);
        assert!(result.is_err());
        match result.unwrap_err() {
            IndexerError::MissingEventJson(msg) => {
                assert!(msg.contains("event_json"));
            }
            other => panic!("予期しないエラー型: {:?}", other),
        }
    }

    #[test]
    fn test_extract_event_json_wrong_type() {
        // event_jsonが文字列型でない場合
        let image = create_item(vec![("event_json", AttributeValue::N("123".to_string()))]);

        let result = Indexer::extract_event_json(&image);
        assert!(result.is_err());
        match result.unwrap_err() {
            IndexerError::MissingEventJson(msg) => {
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

        let result = Indexer::extract_event_id(&record);
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

        let result = Indexer::extract_event_id(&record);
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

        let result = Indexer::extract_event_id(&record);
        assert!(result.is_err());
    }

    // ==================== ProcessAction テスト ====================

    #[test]
    fn test_process_action_equality() {
        assert_eq!(ProcessAction::Indexed, ProcessAction::Indexed);
        assert_eq!(ProcessAction::Deleted, ProcessAction::Deleted);
        assert_eq!(
            ProcessAction::Skipped("reason".to_string()),
            ProcessAction::Skipped("reason".to_string())
        );
        assert_ne!(ProcessAction::Indexed, ProcessAction::Deleted);
    }

    // ==================== IndexerResult テスト ====================

    #[test]
    fn test_indexer_result_new() {
        let result = IndexerResult::new();
        assert_eq!(result.success_count, 0);
        assert_eq!(result.failure_count, 0);
        assert_eq!(result.skip_count, 0);
    }

    #[test]
    fn test_indexer_result_default() {
        let result = IndexerResult::default();
        assert_eq!(result.success_count, 0);
        assert_eq!(result.failure_count, 0);
        assert_eq!(result.skip_count, 0);
    }

    // ==================== エラー型テスト ====================

    #[test]
    fn test_indexer_error_display_missing_event_json() {
        let error = IndexerError::MissingEventJson("テスト".to_string());
        assert!(error.to_string().contains("event_json"));
        assert!(error.to_string().contains("欠損"));
    }

    #[test]
    fn test_indexer_error_display_deserialization() {
        let error = IndexerError::DeserializationError("テスト".to_string());
        assert!(error.to_string().contains("デシリアライズ"));
    }

    #[test]
    fn test_indexer_error_display_opensearch() {
        let error = IndexerError::OpenSearchError("テスト".to_string());
        assert!(error.to_string().contains("OpenSearch"));
    }

    // ==================== ヘルパー関数（テスト用デフォルト構造体作成） ====================

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

    // ==================== 統合テスト用モック（コメント） ====================
    //
    // 注意: 実際のOpenSearch接続を必要とするテストは統合テストで実行
    // - process_event: DynamoDB Streams -> OpenSearch フロー
    // - index_record: INSERT/MODIFY処理
    // - delete_record: REMOVE処理
    // これらのテストはローカルOpenSearchコンテナまたは実環境で実行
}
