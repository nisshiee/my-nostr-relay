// HTTP SQLiteインデックス再構築
//
// DynamoDB Eventsテーブルの全イベントをスキャンし、
// EC2 HTTP APIにバッチでPOSTする機能を提供する。
//
// 要件: 6.1, 6.2, 6.3, 6.4, 6.5
//
// Task 4.1: RebuilderToolのHTTP API対応
// Task 4.2: 進捗ログとリカバリー機能

use super::indexer_client::{HttpSqliteIndexerError, IndexerClient};
use aws_sdk_dynamodb::types::AttributeValue;
use aws_sdk_dynamodb::Client as DynamoDbClient;
use nostr::Event as NostrEvent;
use std::collections::HashMap;
use thiserror::Error;
use tracing::{debug, error, info, warn};

/// 再構築設定
///
/// # 要件
/// - 6.2: バッチ処理でインデックス化
/// - 6.5: 初回構築および障害復旧時に実行可能
#[derive(Debug, Clone)]
pub struct HttpSqliteRebuildConfig {
    /// DynamoDBスキャンのバッチサイズ（1回のスキャンで取得するアイテム数）
    pub batch_size: u32,
}

impl Default for HttpSqliteRebuildConfig {
    fn default() -> Self {
        Self { batch_size: 100 }
    }
}

impl HttpSqliteRebuildConfig {
    /// 新しい設定を作成
    pub fn new(batch_size: u32) -> Self {
        Self { batch_size }
    }

    /// 環境変数から設定を読み込む
    ///
    /// # 環境変数
    /// - REBUILD_BATCH_SIZE: バッチサイズ（デフォルト: 100）
    pub fn from_env() -> Result<Self, HttpSqliteRebuildConfigError> {
        let batch_size = std::env::var("REBUILD_BATCH_SIZE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(100);

        if batch_size == 0 {
            return Err(HttpSqliteRebuildConfigError::InvalidBatchSize);
        }

        Ok(Self { batch_size })
    }
}

/// 再構築設定エラー
#[derive(Debug, Error, Clone, PartialEq)]
pub enum HttpSqliteRebuildConfigError {
    /// バッチサイズが不正（0以下）
    #[error("バッチサイズは1以上である必要があります")]
    InvalidBatchSize,
}

/// 再構築エラー
#[derive(Debug, Error)]
pub enum HttpSqliteRebuilderError {
    /// DynamoDBスキャンエラー
    #[error("DynamoDBスキャンエラー: {0}")]
    DynamoDbError(String),

    /// HTTP APIエラー
    #[error("HTTP APIエラー: {0}")]
    HttpApiError(#[from] HttpSqliteIndexerError),

    /// デシリアライズエラー
    #[error("デシリアライズエラー: {0}")]
    DeserializationError(String),
}

/// 再構築結果
///
/// # 要件
/// - 6.3: 進捗状況のログ出力
#[derive(Debug, Clone, Default)]
pub struct HttpSqliteRebuildResult {
    /// スキャンしたイベント総数
    pub scanned_count: usize,
    /// 正常にインデックス化されたイベント数
    pub indexed_count: usize,
    /// スキップされたイベント数（既存イベントまたはevent_json欠損）
    pub skipped_count: usize,
    /// エラーが発生したイベント数
    pub error_count: usize,
    /// 最後に処理したキー（リカバリー用）
    pub last_evaluated_key: Option<HashMap<String, AttributeValue>>,
}

impl HttpSqliteRebuildResult {
    /// 新しい結果を作成
    pub fn new() -> Self {
        Self::default()
    }
}

/// HTTP SQLiteインデックス再構築
///
/// DynamoDB Eventsテーブルの全イベントをスキャンし、
/// EC2 HTTP APIにバッチでPOSTする。
///
/// # 要件
/// - 6.1: DynamoDBから既存のすべてのイベントを読み取る
/// - 6.2: イベントをバッチでSQLiteデータベースに挿入
/// - 6.3: 進捗状況のログ出力（バッチごとにイベント数）
/// - 6.4: 既存イベントのスキップ（409を無視）
/// - 6.5: 初回構築および障害復旧時に実行可能
pub struct HttpSqliteRebuilder {
    /// DynamoDBクライアント
    dynamodb_client: DynamoDbClient,
    /// IndexerClient（HTTP API用）
    indexer_client: IndexerClient,
    /// DynamoDBテーブル名
    table_name: String,
    /// 再構築設定
    config: HttpSqliteRebuildConfig,
}

impl HttpSqliteRebuilder {
    /// 新しいHttpSqliteRebuilderを作成
    ///
    /// # 引数
    /// * `dynamodb_client` - DynamoDBクライアント
    /// * `indexer_client` - EC2 HTTP APIクライアント
    /// * `table_name` - DynamoDB Eventsテーブル名
    /// * `config` - 再構築設定
    pub fn new(
        dynamodb_client: DynamoDbClient,
        indexer_client: IndexerClient,
        table_name: String,
        config: HttpSqliteRebuildConfig,
    ) -> Self {
        Self {
            dynamodb_client,
            indexer_client,
            table_name,
            config,
        }
    }

    /// インデックスを再構築
    ///
    /// # 引数
    /// * `start_key` - リカバリー用の開始キー（Noneの場合は最初から）
    ///
    /// # 処理フロー
    /// 1. DynamoDBテーブルを全スキャン（start_keyから開始）
    /// 2. バッチごとにEC2 HTTP APIにPOST
    /// 3. 進捗状況をログに出力
    /// 4. 既存イベント（409）はスキップ
    ///
    /// # 戻り値
    /// * `Ok(HttpSqliteRebuildResult)` - 再構築結果（last_evaluated_keyを含む）
    /// * `Err(HttpSqliteRebuilderError)` - エラー
    ///
    /// # 要件
    /// - 6.3: バッチ処理ごとにイベント数をログ出力
    /// - 6.5: 障害復旧時の再開をサポート（start_key引数）
    pub async fn rebuild(
        &self,
        start_key: Option<HashMap<String, AttributeValue>>,
    ) -> Result<HttpSqliteRebuildResult, HttpSqliteRebuilderError> {
        info!(
            table_name = %self.table_name,
            batch_size = self.config.batch_size,
            has_start_key = start_key.is_some(),
            "HTTP SQLiteインデックス再構築を開始"
        );

        let mut result = HttpSqliteRebuildResult::new();
        let mut last_evaluated_key = start_key;
        let mut batch_number = 0u32;

        // 要件 6.1: DynamoDB Eventsテーブルの全イベントをスキャン
        loop {
            batch_number += 1;

            // DynamoDBスキャン
            let (events, next_key) = self.scan_batch(&last_evaluated_key).await?;
            let batch_event_count = events.len();

            result.scanned_count += batch_event_count;

            // 要件 6.3: 進捗ログ（バッチ処理ごとにイベント数）
            info!(
                batch_number = batch_number,
                batch_event_count = batch_event_count,
                total_scanned = result.scanned_count,
                "バッチスキャン完了"
            );

            // 要件 6.5: 中断時のLastEvaluatedKeyをログ出力
            if let Some(ref key) = next_key {
                // キーをログに出力（リカバリー用）
                let key_str = format_last_evaluated_key(key);
                debug!(
                    last_evaluated_key = %key_str,
                    "次のスキャン位置"
                );
            }

            if !events.is_empty() {
                // 要件 6.2, 6.4: バッチ単位でEC2 HTTP APIにPOST（既存スキップ）
                let (indexed, skipped, errors) = self.index_batch(&events).await;
                result.indexed_count += indexed;
                result.skipped_count += skipped;
                result.error_count += errors;

                // 要件 6.3: 進捗ログ
                info!(
                    batch_number = batch_number,
                    indexed = indexed,
                    skipped = skipped,
                    errors = errors,
                    total_indexed = result.indexed_count,
                    total_skipped = result.skipped_count,
                    total_errors = result.error_count,
                    "バッチインデックス完了"
                );
            }

            // リカバリー用に最後のキーを保存
            result.last_evaluated_key = next_key.clone();

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
            "HTTP SQLiteインデックス再構築完了"
        );

        Ok(result)
    }

    /// DynamoDBから1バッチ分のイベントをスキャン
    ///
    /// # 要件
    /// - 6.1: DynamoDB Eventsテーブルの全イベントをスキャン
    async fn scan_batch(
        &self,
        exclusive_start_key: &Option<HashMap<String, AttributeValue>>,
    ) -> Result<(Vec<NostrEvent>, Option<HashMap<String, AttributeValue>>), HttpSqliteRebuilderError>
    {
        let mut scan_builder = self
            .dynamodb_client
            .scan()
            .table_name(&self.table_name)
            .limit(self.config.batch_size as i32);

        if let Some(key) = exclusive_start_key {
            scan_builder = scan_builder.set_exclusive_start_key(Some(key.clone()));
        }

        let response = scan_builder.send().await.map_err(|e| {
            HttpSqliteRebuilderError::DynamoDbError(e.into_service_error().to_string())
        })?;

        let mut events = Vec::new();

        if let Some(items) = response.items {
            for item in items {
                // event_jsonを取得
                if let Some(event_json_attr) = item.get("event_json") {
                    if let Ok(event_json) = event_json_attr.as_s() {
                        match serde_json::from_str::<NostrEvent>(event_json) {
                            Ok(event) => events.push(event),
                            Err(e) => {
                                warn!(
                                    error = %e,
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

        Ok((events, response.last_evaluated_key))
    }

    /// イベントをEC2 HTTP APIにインデックス化
    ///
    /// # 要件
    /// - 6.2: イベントをバッチでインデックス化
    /// - 6.4: 既存イベントのスキップ（200 OKは既存として扱う）
    ///
    /// # 戻り値
    /// (indexed_count, skipped_count, error_count)
    async fn index_batch(&self, events: &[NostrEvent]) -> (usize, usize, usize) {
        let mut indexed_count = 0usize;
        let mut skipped_count = 0usize;
        let mut error_count = 0usize;

        for event in events {
            match self.indexer_client.index_event(event).await {
                Ok(()) => {
                    // 201 Createdまたは200 OK（既存）
                    // IndexerClientは両方ともOk(())を返すため、
                    // 詳細なステータスは区別できないが、両方とも成功として扱う
                    indexed_count += 1;
                    debug!(event_id = %event.id.to_hex(), "イベントインデックス成功");
                }
                Err(HttpSqliteIndexerError::HttpError { status: 409, .. }) => {
                    // 要件 6.4: 409 Conflictは既存イベントとしてスキップ
                    skipped_count += 1;
                    debug!(
                        event_id = %event.id.to_hex(),
                        "イベントは既に存在するためスキップ"
                    );
                }
                Err(e) => {
                    // その他のエラー
                    error_count += 1;
                    error!(
                        error = %e,
                        event_id = %event.id.to_hex(),
                        "イベントインデックスエラー"
                    );
                }
            }
        }

        (indexed_count, skipped_count, error_count)
    }
}

/// LastEvaluatedKeyを文字列形式にフォーマット（ログ出力用）
///
/// # 要件
/// - 6.5: 障害復旧時の再開をサポート（LastEvaluatedKeyをログ出力）
fn format_last_evaluated_key(key: &HashMap<String, AttributeValue>) -> String {
    key.iter()
        .map(|(k, v)| {
            let value = if let Ok(s) = v.as_s() {
                s.to_string()
            } else if let Ok(n) = v.as_n() {
                n.to_string()
            } else {
                format!("{:?}", v)
            };
            format!("{}={}", k, value)
        })
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    // ==================== HttpSqliteRebuildConfig テスト ====================

    #[test]
    fn test_rebuild_config_default() {
        // デフォルト設定のテスト
        let config = HttpSqliteRebuildConfig::default();

        assert_eq!(config.batch_size, 100);
    }

    #[test]
    fn test_rebuild_config_new() {
        // カスタム設定のテスト
        let config = HttpSqliteRebuildConfig::new(50);

        assert_eq!(config.batch_size, 50);
    }

    #[test]
    #[serial]
    fn test_rebuild_config_from_env_default() {
        // 環境変数未設定時のデフォルト値テスト
        // 安全性: テスト環境でのみ使用
        unsafe {
            std::env::remove_var("REBUILD_BATCH_SIZE");
        }

        let config = HttpSqliteRebuildConfig::from_env().expect("設定読み込みに失敗");

        assert_eq!(config.batch_size, 100);
    }

    #[test]
    #[serial]
    fn test_rebuild_config_from_env_custom() {
        // 環境変数設定時のテスト
        unsafe {
            std::env::set_var("REBUILD_BATCH_SIZE", "200");
        }

        let config = HttpSqliteRebuildConfig::from_env().expect("設定読み込みに失敗");

        assert_eq!(config.batch_size, 200);

        // クリーンアップ
        unsafe {
            std::env::remove_var("REBUILD_BATCH_SIZE");
        }
    }

    #[test]
    #[serial]
    fn test_rebuild_config_from_env_invalid_batch_size() {
        // バッチサイズが0の場合のエラーテスト
        unsafe {
            std::env::set_var("REBUILD_BATCH_SIZE", "0");
        }

        let result = HttpSqliteRebuildConfig::from_env();

        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            HttpSqliteRebuildConfigError::InvalidBatchSize
        );

        // クリーンアップ
        unsafe {
            std::env::remove_var("REBUILD_BATCH_SIZE");
        }
    }

    // ==================== HttpSqliteRebuildConfigError テスト ====================

    #[test]
    fn test_rebuild_config_error_display() {
        let error = HttpSqliteRebuildConfigError::InvalidBatchSize;
        assert!(error.to_string().contains("バッチサイズ"));
    }

    // ==================== HttpSqliteRebuilderError テスト ====================

    #[test]
    fn test_rebuilder_error_display_dynamodb() {
        let error = HttpSqliteRebuilderError::DynamoDbError("接続失敗".to_string());
        assert!(error.to_string().contains("DynamoDB"));
        assert!(error.to_string().contains("接続失敗"));
    }

    #[test]
    fn test_rebuilder_error_display_http_api() {
        let inner_error = HttpSqliteIndexerError::NetworkError("timeout".to_string());
        let error = HttpSqliteRebuilderError::HttpApiError(inner_error);
        assert!(error.to_string().contains("HTTP API"));
    }

    #[test]
    fn test_rebuilder_error_display_deserialization() {
        let error = HttpSqliteRebuilderError::DeserializationError("JSONパースエラー".to_string());
        assert!(error.to_string().contains("デシリアライズ"));
    }

    // ==================== HttpSqliteRebuildResult テスト ====================

    #[test]
    fn test_rebuild_result_new() {
        let result = HttpSqliteRebuildResult::new();

        assert_eq!(result.scanned_count, 0);
        assert_eq!(result.indexed_count, 0);
        assert_eq!(result.skipped_count, 0);
        assert_eq!(result.error_count, 0);
        assert!(result.last_evaluated_key.is_none());
    }

    #[test]
    fn test_rebuild_result_default() {
        let result = HttpSqliteRebuildResult::default();

        assert_eq!(result.scanned_count, 0);
        assert_eq!(result.indexed_count, 0);
        assert_eq!(result.skipped_count, 0);
        assert_eq!(result.error_count, 0);
        assert!(result.last_evaluated_key.is_none());
    }

    // ==================== format_last_evaluated_key テスト ====================

    #[test]
    fn test_format_last_evaluated_key_string() {
        let mut key = HashMap::new();
        key.insert("id".to_string(), AttributeValue::S("abc123".to_string()));

        let formatted = format_last_evaluated_key(&key);
        assert!(formatted.contains("id=abc123"));
    }

    #[test]
    fn test_format_last_evaluated_key_number() {
        let mut key = HashMap::new();
        key.insert("sort_key".to_string(), AttributeValue::N("12345".to_string()));

        let formatted = format_last_evaluated_key(&key);
        assert!(formatted.contains("sort_key=12345"));
    }

    #[test]
    fn test_format_last_evaluated_key_multiple() {
        let mut key = HashMap::new();
        key.insert("pk".to_string(), AttributeValue::S("pk_value".to_string()));
        key.insert("sk".to_string(), AttributeValue::N("100".to_string()));

        let formatted = format_last_evaluated_key(&key);
        // 順序は保証されないので、両方含まれていることを確認
        assert!(formatted.contains("pk=pk_value"));
        assert!(formatted.contains("sk=100"));
    }

    // ==================== 統合テスト用コメント ====================
    //
    // 注意: 実際のDynamoDB/EC2 HTTP API接続を必要とするテストは統合テストで実行
    // - rebuild(): フルフローテスト
    // - scan_batch(): DynamoDBスキャンテスト
    // - index_batch(): HTTP APIインデックステスト
    //
    // これらのテストはローカルDynamoDB Local、モックサーバー、
    // または実環境で実行する
}
