// OpenSearchインデックス再構築
//
// DynamoDB Eventsテーブルの全イベントをスキャンし、
// OpenSearchにバルクインデックスする機能を提供する。
//
// 要件: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6

use super::client::OpenSearchClient;
use super::index_document::{DocumentBuildError, NostrEventDocument};
use aws_sdk_dynamodb::types::AttributeValue;
use aws_sdk_dynamodb::Client as DynamoDbClient;
use nostr::Event as NostrEvent;
use opensearch::http::request::JsonBody;
use opensearch::indices::IndicesDeleteParts;
use opensearch::BulkParts;
use serde_json::json;
use thiserror::Error;
use tracing::{debug, error, info, warn};

/// 再構築設定
///
/// 要件 10.5: バッチサイズを設定可能
/// 要件 10.6: Lambda関数またはローカルスクリプトとして実行可能な設計
#[derive(Debug, Clone)]
pub struct RebuildConfig {
    /// DynamoDBスキャンのバッチサイズ（1回のスキャンで取得するアイテム数）
    /// 要件 10.5: バッチサイズを設定可能
    pub batch_size: u32,

    /// 再構築前に既存インデックスを削除するかどうか
    /// 要件 10.3: 既存インデックスを削除してから再構築を開始するオプション
    pub delete_before_rebuild: bool,
}

impl Default for RebuildConfig {
    fn default() -> Self {
        Self {
            batch_size: 100,
            delete_before_rebuild: false,
        }
    }
}

impl RebuildConfig {
    /// 新しい設定を作成
    pub fn new(batch_size: u32, delete_before_rebuild: bool) -> Self {
        Self {
            batch_size,
            delete_before_rebuild,
        }
    }

    /// 環境変数から設定を読み込む
    ///
    /// 環境変数:
    /// - REBUILD_BATCH_SIZE: バッチサイズ（デフォルト: 100）
    /// - REBUILD_DELETE_INDEX: 既存インデックスを削除するか（"true"で有効）
    pub fn from_env() -> Result<Self, RebuildConfigError> {
        let batch_size = std::env::var("REBUILD_BATCH_SIZE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(100);

        let delete_before_rebuild = std::env::var("REBUILD_DELETE_INDEX")
            .map(|s| s.to_lowercase() == "true")
            .unwrap_or(false);

        if batch_size == 0 {
            return Err(RebuildConfigError::InvalidBatchSize);
        }

        Ok(Self {
            batch_size,
            delete_before_rebuild,
        })
    }
}

/// 再構築設定エラー
#[derive(Debug, Error, Clone, PartialEq)]
pub enum RebuildConfigError {
    /// バッチサイズが不正（0以下）
    #[error("バッチサイズは1以上である必要があります")]
    InvalidBatchSize,
}

/// 再構築エラー
#[derive(Debug, Error)]
pub enum RebuilderError {
    /// DynamoDBスキャンエラー
    #[error("DynamoDBスキャンエラー: {0}")]
    DynamoDbError(String),

    /// OpenSearchエラー
    #[error("OpenSearchエラー: {0}")]
    OpenSearchError(String),

    /// ドキュメント構築エラー
    #[error("ドキュメント構築エラー: {0}")]
    DocumentBuildError(#[from] DocumentBuildError),

    /// デシリアライズエラー
    #[error("デシリアライズエラー: {0}")]
    DeserializationError(String),

    /// インデックス削除エラー
    #[error("インデックス削除エラー: {0}")]
    IndexDeleteError(String),
}

/// 再構築結果
///
/// 要件 10.4: 進捗状況のログ出力
#[derive(Debug, Clone, Default)]
pub struct RebuildResult {
    /// スキャンしたイベント総数
    pub scanned_count: usize,
    /// 正常にインデックス化されたイベント数
    pub indexed_count: usize,
    /// スキップされたイベント数（event_json欠損等）
    pub skipped_count: usize,
    /// エラーが発生したイベント数
    pub error_count: usize,
}

impl RebuildResult {
    /// 新しい結果を作成
    pub fn new() -> Self {
        Self::default()
    }
}

/// OpenSearchインデックス再構築
///
/// DynamoDB Eventsテーブルの全イベントをスキャンし、
/// OpenSearchにバルクインデックスする。
///
/// 要件:
/// - 10.1: DynamoDB Eventsテーブルの全イベントをスキャン
/// - 10.2: スキャンしたイベントをOpenSearchにバルクインデックス
/// - 10.3: 既存インデックスを削除してから再構築を開始するオプション
/// - 10.4: 進捗状況のログ出力
/// - 10.5: バッチサイズを設定可能
/// - 10.6: Lambda関数またはローカルスクリプトとして実行可能な設計
pub struct Rebuilder {
    /// DynamoDBクライアント
    dynamodb_client: DynamoDbClient,
    /// OpenSearchクライアント
    opensearch_client: OpenSearchClient,
    /// DynamoDBテーブル名
    table_name: String,
    /// 再構築設定
    config: RebuildConfig,
}

impl Rebuilder {
    /// 新しいRebuilderを作成
    ///
    /// # 引数
    /// * `dynamodb_client` - DynamoDBクライアント
    /// * `opensearch_client` - OpenSearchクライアント
    /// * `table_name` - DynamoDB Eventsテーブル名
    /// * `config` - 再構築設定
    pub fn new(
        dynamodb_client: DynamoDbClient,
        opensearch_client: OpenSearchClient,
        table_name: String,
        config: RebuildConfig,
    ) -> Self {
        Self {
            dynamodb_client,
            opensearch_client,
            table_name,
            config,
        }
    }

    /// インデックスを再構築
    ///
    /// # 処理フロー
    /// 1. delete_before_rebuildがtrueの場合、既存インデックスを削除
    /// 2. DynamoDBテーブルを全スキャン
    /// 3. バッチごとにOpenSearchにバルクインデックス
    /// 4. 進捗状況をログに出力
    ///
    /// # 戻り値
    /// * `Ok(RebuildResult)` - 再構築結果
    /// * `Err(RebuilderError)` - エラー
    pub async fn rebuild(&self) -> Result<RebuildResult, RebuilderError> {
        info!(
            table_name = %self.table_name,
            batch_size = self.config.batch_size,
            delete_before_rebuild = self.config.delete_before_rebuild,
            "インデックス再構築を開始"
        );

        // 要件 10.3: 既存インデックスを削除するオプション
        if self.config.delete_before_rebuild {
            self.delete_index().await?;
        }

        let mut result = RebuildResult::new();
        let mut last_evaluated_key = None;
        let mut batch_number = 0u32;

        // 要件 10.1: DynamoDB Eventsテーブルの全イベントをスキャン
        loop {
            batch_number += 1;

            // DynamoDBスキャン
            let (events, next_key) = self.scan_batch(&last_evaluated_key).await?;
            let batch_event_count = events.len();

            result.scanned_count += batch_event_count;

            // 要件 10.4: 進捗状況のログ出力
            info!(
                batch_number = batch_number,
                batch_event_count = batch_event_count,
                total_scanned = result.scanned_count,
                "バッチスキャン完了"
            );

            if !events.is_empty() {
                // 要件 10.2: OpenSearchにバルクインデックス
                let (indexed, skipped, errors) = self.bulk_index(&events).await?;
                result.indexed_count += indexed;
                result.skipped_count += skipped;
                result.error_count += errors;

                // 要件 10.4: 進捗状況のログ出力
                info!(
                    batch_number = batch_number,
                    indexed = indexed,
                    skipped = skipped,
                    errors = errors,
                    total_indexed = result.indexed_count,
                    "バッチインデックス完了"
                );
            }

            // 次のページがあるか確認
            match next_key {
                Some(key) => last_evaluated_key = Some(key),
                None => break,
            }
        }

        info!(
            scanned_count = result.scanned_count,
            indexed_count = result.indexed_count,
            skipped_count = result.skipped_count,
            error_count = result.error_count,
            "インデックス再構築完了"
        );

        Ok(result)
    }

    /// 既存インデックスを削除
    ///
    /// 要件 10.3: 既存インデックスを削除してから再構築を開始するオプション
    pub async fn delete_index(&self) -> Result<(), RebuilderError> {
        let index_name = self.opensearch_client.index_name();

        info!(index_name = %index_name, "インデックスを削除中");

        let response = self
            .opensearch_client
            .client()
            .indices()
            .delete(IndicesDeleteParts::Index(&[index_name]))
            .send()
            .await
            .map_err(|e| RebuilderError::IndexDeleteError(e.to_string()))?;

        let status = response.status_code().as_u16();

        // 404はインデックスが存在しない場合（削除済みとして扱う）
        if status >= 400 && status != 404 {
            let body = response.text().await.unwrap_or_default();
            return Err(RebuilderError::IndexDeleteError(format!(
                "ステータスコード {}: {}",
                status, body
            )));
        }

        info!(index_name = %index_name, "インデックス削除完了");

        Ok(())
    }

    /// DynamoDBから1バッチ分のイベントをスキャン
    ///
    /// 要件 10.1: DynamoDB Eventsテーブルの全イベントをスキャン
    /// 要件 10.5: バッチサイズを設定可能
    async fn scan_batch(
        &self,
        exclusive_start_key: &Option<std::collections::HashMap<String, AttributeValue>>,
    ) -> Result<
        (
            Vec<NostrEvent>,
            Option<std::collections::HashMap<String, AttributeValue>>,
        ),
        RebuilderError,
    > {
        let mut scan_builder = self
            .dynamodb_client
            .scan()
            .table_name(&self.table_name)
            .limit(self.config.batch_size as i32);

        if let Some(key) = exclusive_start_key {
            scan_builder = scan_builder.set_exclusive_start_key(Some(key.clone()));
        }

        let result = scan_builder.send().await.map_err(|e| {
            RebuilderError::DynamoDbError(e.into_service_error().to_string())
        })?;

        let mut events = Vec::new();

        if let Some(items) = result.items {
            for item in items {
                // event_jsonを取得
                if let Some(event_json_attr) = item.get("event_json") {
                    if let Ok(event_json) = event_json_attr.as_s() {
                        match serde_json::from_str::<NostrEvent>(event_json) {
                            Ok(event) => events.push(event),
                            Err(e) => {
                                warn!(
                                    error = %e,
                                    event_json = %event_json,
                                    "イベントのデシリアライズに失敗、スキップ"
                                );
                            }
                        }
                    } else {
                        warn!("event_jsonがString型ではありません、スキップ");
                    }
                } else {
                    warn!("event_jsonフィールドがありません、スキップ");
                }
            }
        }

        Ok((events, result.last_evaluated_key))
    }

    /// イベントをOpenSearchにバルクインデックス
    ///
    /// 要件 10.2: スキャンしたイベントをOpenSearchにバルクインデックス
    ///
    /// # 戻り値
    /// (indexed_count, skipped_count, error_count)
    async fn bulk_index(&self, events: &[NostrEvent]) -> Result<(usize, usize, usize), RebuilderError> {
        if events.is_empty() {
            return Ok((0, 0, 0));
        }

        let mut body: Vec<JsonBody<_>> = Vec::with_capacity(events.len() * 2);
        let mut skipped_count = 0usize;

        for event in events {
            match NostrEventDocument::from_event(event) {
                Ok(doc) => {
                    // バルクAPIのアクション行
                    body.push(
                        json!({
                            "index": {
                                "_index": self.opensearch_client.index_name(),
                                "_id": doc.document_id()
                            }
                        })
                        .into(),
                    );
                    // ドキュメント行
                    body.push(json!(doc).into());
                }
                Err(e) => {
                    debug!(
                        error = %e,
                        event_id = %event.id.to_hex(),
                        "ドキュメント構築に失敗、スキップ"
                    );
                    skipped_count += 1;
                }
            }
        }

        if body.is_empty() {
            return Ok((0, skipped_count, 0));
        }

        // バルクリクエストを送信
        let response = self
            .opensearch_client
            .client()
            .bulk(BulkParts::None)
            .body(body)
            .send()
            .await
            .map_err(|e| RebuilderError::OpenSearchError(e.to_string()))?;

        let status = response.status_code().as_u16();
        if status >= 400 {
            let body_text = response.text().await.unwrap_or_default();
            return Err(RebuilderError::OpenSearchError(format!(
                "バルクインデックス失敗 (status: {}): {}",
                status, body_text
            )));
        }

        // レスポンスを解析してエラー数をカウント
        let response_body = response.json::<serde_json::Value>().await.map_err(|e| {
            RebuilderError::OpenSearchError(format!("レスポンスの解析に失敗: {}", e))
        })?;

        let mut indexed_count = 0usize;
        let mut error_count = 0usize;

        if let Some(items) = response_body.get("items").and_then(|v| v.as_array()) {
            for item in items {
                if let Some(index_result) = item.get("index") {
                    if let Some(error) = index_result.get("error") {
                        error!(
                            error = %error,
                            "バルクインデックスでエラー発生"
                        );
                        error_count += 1;
                    } else {
                        indexed_count += 1;
                    }
                }
            }
        }

        Ok((indexed_count, skipped_count, error_count))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    // ==================== RebuildConfig テスト ====================

    #[test]
    fn test_rebuild_config_default() {
        // デフォルト設定のテスト
        let config = RebuildConfig::default();

        assert_eq!(config.batch_size, 100);
        assert!(!config.delete_before_rebuild);
    }

    #[test]
    fn test_rebuild_config_new() {
        // カスタム設定のテスト
        let config = RebuildConfig::new(50, true);

        assert_eq!(config.batch_size, 50);
        assert!(config.delete_before_rebuild);
    }

    #[test]
    #[serial]
    fn test_rebuild_config_from_env_default() {
        // 環境変数未設定時のデフォルト値テスト
        // 安全性: テスト環境でのみ使用
        unsafe {
            std::env::remove_var("REBUILD_BATCH_SIZE");
            std::env::remove_var("REBUILD_DELETE_INDEX");
        }

        let config = RebuildConfig::from_env().expect("設定読み込みに失敗");

        assert_eq!(config.batch_size, 100);
        assert!(!config.delete_before_rebuild);
    }

    #[test]
    #[serial]
    fn test_rebuild_config_from_env_custom() {
        // 環境変数設定時のテスト
        unsafe {
            std::env::set_var("REBUILD_BATCH_SIZE", "200");
            std::env::set_var("REBUILD_DELETE_INDEX", "true");
        }

        let config = RebuildConfig::from_env().expect("設定読み込みに失敗");

        assert_eq!(config.batch_size, 200);
        assert!(config.delete_before_rebuild);

        // クリーンアップ
        unsafe {
            std::env::remove_var("REBUILD_BATCH_SIZE");
            std::env::remove_var("REBUILD_DELETE_INDEX");
        }
    }

    #[test]
    #[serial]
    fn test_rebuild_config_from_env_invalid_batch_size() {
        // バッチサイズが0の場合のエラーテスト
        unsafe {
            std::env::remove_var("REBUILD_DELETE_INDEX");
            std::env::set_var("REBUILD_BATCH_SIZE", "0");
        }

        let result = RebuildConfig::from_env();

        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), RebuildConfigError::InvalidBatchSize);

        // クリーンアップ
        unsafe {
            std::env::remove_var("REBUILD_BATCH_SIZE");
        }
    }

    #[test]
    #[serial]
    fn test_rebuild_config_from_env_delete_index_variations() {
        // delete_before_rebuildの各種値テスト
        let test_cases = [
            ("true", true),
            ("True", true),
            ("TRUE", true),
            ("false", false),
            ("False", false),
            ("other", false),
        ];

        // バッチサイズをクリア
        unsafe {
            std::env::remove_var("REBUILD_BATCH_SIZE");
        }

        for (env_value, expected) in test_cases {
            unsafe {
                std::env::set_var("REBUILD_DELETE_INDEX", env_value);
            }

            let config = RebuildConfig::from_env().expect("設定読み込みに失敗");
            assert_eq!(
                config.delete_before_rebuild, expected,
                "env_value: {}",
                env_value
            );
        }

        // クリーンアップ
        unsafe {
            std::env::remove_var("REBUILD_DELETE_INDEX");
        }
    }

    // ==================== RebuildConfigError テスト ====================

    #[test]
    fn test_rebuild_config_error_display() {
        let error = RebuildConfigError::InvalidBatchSize;
        assert!(error.to_string().contains("バッチサイズ"));
    }

    // ==================== RebuilderError テスト ====================

    #[test]
    fn test_rebuilder_error_display_dynamodb() {
        let error = RebuilderError::DynamoDbError("接続失敗".to_string());
        assert!(error.to_string().contains("DynamoDB"));
        assert!(error.to_string().contains("接続失敗"));
    }

    #[test]
    fn test_rebuilder_error_display_opensearch() {
        let error = RebuilderError::OpenSearchError("インデックス失敗".to_string());
        assert!(error.to_string().contains("OpenSearch"));
        assert!(error.to_string().contains("インデックス失敗"));
    }

    #[test]
    fn test_rebuilder_error_display_deserialization() {
        let error = RebuilderError::DeserializationError("JSONパースエラー".to_string());
        assert!(error.to_string().contains("デシリアライズ"));
    }

    #[test]
    fn test_rebuilder_error_display_index_delete() {
        let error = RebuilderError::IndexDeleteError("削除失敗".to_string());
        assert!(error.to_string().contains("インデックス削除"));
    }

    // ==================== RebuildResult テスト ====================

    #[test]
    fn test_rebuild_result_new() {
        let result = RebuildResult::new();

        assert_eq!(result.scanned_count, 0);
        assert_eq!(result.indexed_count, 0);
        assert_eq!(result.skipped_count, 0);
        assert_eq!(result.error_count, 0);
    }

    #[test]
    fn test_rebuild_result_default() {
        let result = RebuildResult::default();

        assert_eq!(result.scanned_count, 0);
        assert_eq!(result.indexed_count, 0);
        assert_eq!(result.skipped_count, 0);
        assert_eq!(result.error_count, 0);
    }

    // ==================== 統合テスト用コメント ====================
    //
    // 注意: 実際のDynamoDB/OpenSearch接続を必要とするテストは統合テストで実行
    // - rebuild(): フルフローテスト
    // - delete_index(): インデックス削除テスト
    // - scan_batch(): DynamoDBスキャンテスト
    // - bulk_index(): バルクインデックステスト
    //
    // これらのテストはローカルDynamoDB Local、OpenSearchコンテナ、
    // または実環境で実行する
}
