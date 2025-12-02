// OpenSearchEventRepository - OpenSearchを使用したQueryRepository実装
//
// OpenSearchを使用してフィルターに合致するイベントをクエリする。
// クエリ専用のため、save/get_by_idは実装しない。
//
// 要件: 5.1-5.8, 6.1-6.5, 7.1-7.5

use super::client::{OpenSearchClient, OpenSearchClientError};
use super::config::OpenSearchConfig;
use super::filter_to_query_converter::FilterToQueryConverter;
use crate::infrastructure::event_repository::QueryRepositoryError;
use crate::infrastructure::QueryRepository;
use async_trait::async_trait;
use nostr::{Event, Filter};
use opensearch::SearchParts;
use serde_json::{json, Value};
use thiserror::Error;
use tracing::{debug, error, info, instrument};

/// デフォルトの取得件数制限
const DEFAULT_LIMIT: u32 = 100;

/// 最大取得件数制限
const MAX_LIMIT: u32 = 5000;

/// OpenSearchEventRepository固有のエラー型
#[derive(Debug, Error)]
pub enum OpenSearchEventRepositoryError {
    /// クライアント初期化エラー
    #[error("クライアント初期化エラー: {0}")]
    ClientError(#[from] OpenSearchClientError),

    /// クエリ実行エラー
    #[error("クエリエラー: {0}")]
    QueryError(String),

    /// クエリタイムアウト
    #[error("クエリタイムアウト: {0}")]
    Timeout(String),

    /// シリアライズ/デシリアライズエラー
    #[error("シリアライズエラー: {0}")]
    SerializationError(String),

    /// インデックスが存在しない
    #[error("インデックスが存在しません")]
    IndexNotFound,
}

impl From<OpenSearchEventRepositoryError> for QueryRepositoryError {
    fn from(err: OpenSearchEventRepositoryError) -> Self {
        match err {
            OpenSearchEventRepositoryError::ClientError(e) => {
                QueryRepositoryError::ConnectionError(e.to_string())
            }
            OpenSearchEventRepositoryError::QueryError(msg) => QueryRepositoryError::QueryError(msg),
            OpenSearchEventRepositoryError::Timeout(msg) => QueryRepositoryError::Timeout(msg),
            OpenSearchEventRepositoryError::SerializationError(msg) => {
                QueryRepositoryError::DeserializationError(msg)
            }
            OpenSearchEventRepositoryError::IndexNotFound => {
                QueryRepositoryError::IndexNotFound("インデックスが存在しません".to_string())
            }
        }
    }
}

/// OpenSearchを使用したQueryRepository実装
///
/// クエリ専用のため、save/get_by_idは実装しない。
/// FilterToQueryConverterを使用してNIP-01フィルターをOpenSearchクエリに変換し、
/// event_jsonフィールドからイベントをデシリアライズして返す。
///
/// # 要件
/// - 5.1: REQメッセージ受信時にOpenSearchを使用してイベントをクエリ
/// - 5.2: created_at降順でソート
/// - 5.3: _sourceからevent_jsonを取得
/// - 5.4-5.6: limit適用ロジック（default_limit、max_limit）
/// - 5.7: event_jsonをNostr Event形式にデシリアライズ
/// - 5.8: EVENTメッセージとEOSEを送信（呼び出し元で処理）
#[derive(Clone)]
pub struct OpenSearchEventRepository {
    /// OpenSearchクライアント
    client: OpenSearchClient,
}

impl std::fmt::Debug for OpenSearchEventRepository {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenSearchEventRepository")
            .field("index_name", &self.client.index_name())
            .finish_non_exhaustive()
    }
}

impl OpenSearchEventRepository {
    /// 設定からOpenSearchEventRepositoryを作成
    ///
    /// OpenSearchClientを使用してOpenSearch Serviceに接続する。
    ///
    /// # Arguments
    /// * `config` - OpenSearch接続設定
    ///
    /// # Returns
    /// * `Ok(OpenSearchEventRepository)` - 初期化されたリポジトリ
    /// * `Err(OpenSearchEventRepositoryError)` - 初期化に失敗
    pub async fn new(config: &OpenSearchConfig) -> Result<Self, OpenSearchEventRepositoryError> {
        info!(
            endpoint = config.endpoint(),
            index_name = config.index_name(),
            "OpenSearchEventRepositoryを初期化中"
        );

        let client = OpenSearchClient::new(config).await?;

        info!(
            endpoint = config.endpoint(),
            index_name = config.index_name(),
            "OpenSearchEventRepositoryの初期化が完了"
        );

        Ok(Self { client })
    }

    /// limitを適用（default_limit、max_limit制約）
    ///
    /// # Arguments
    /// * `limit` - クライアントから指定されたlimit（オプション）
    ///
    /// # Returns
    /// 適用後のlimit値
    ///
    /// # 要件
    /// - 5.4: limitが指定された場合はその値を使用
    /// - 5.5: limit未指定の場合はDEFAULT_LIMITを適用
    /// - 5.6: limitがMAX_LIMITを超える場合はMAX_LIMITにクランプ
    fn apply_limit(limit: Option<u32>) -> u32 {
        match limit {
            Some(l) if l > MAX_LIMIT => MAX_LIMIT,
            Some(l) => l,
            None => DEFAULT_LIMIT,
        }
    }

    /// クエリボディを構築
    ///
    /// # Arguments
    /// * `filters` - NIP-01フィルター配列
    /// * `limit` - 取得件数制限
    ///
    /// # Returns
    /// OpenSearch検索クエリボディ
    ///
    /// # 要件
    /// - _source: ["event_json"]でevent_jsonフィールドのみを取得 (5.3)
    /// - created_at降順、id昇順でソート (5.2)
    fn build_query_body(filters: &[Filter], limit: u32) -> Value {
        let query = FilterToQueryConverter::convert(filters);

        json!({
            "query": query,
            "sort": [
                { "created_at": { "order": "desc" } },
                { "id": { "order": "asc" } }
            ],
            "size": limit,
            "_source": ["event_json"]
        })
    }

    /// 検索レスポンスからイベントを抽出
    ///
    /// # Arguments
    /// * `response` - OpenSearch検索レスポンス
    ///
    /// # Returns
    /// イベントのベクター
    ///
    /// # 要件
    /// - 5.7: event_jsonをNostr Event形式にデシリアライズ
    fn extract_events_from_response(
        response: Value,
    ) -> Result<Vec<Event>, OpenSearchEventRepositoryError> {
        let hits = response
            .get("hits")
            .and_then(|h| h.get("hits"))
            .and_then(|h| h.as_array())
            .ok_or_else(|| {
                OpenSearchEventRepositoryError::QueryError(
                    "レスポンスにhitsフィールドがありません".to_string(),
                )
            })?;

        let mut events = Vec::with_capacity(hits.len());

        for hit in hits {
            let event_json = hit
                .get("_source")
                .and_then(|s| s.get("event_json"))
                .and_then(|e| e.as_str())
                .ok_or_else(|| {
                    OpenSearchEventRepositoryError::SerializationError(
                        "event_jsonフィールドがありません".to_string(),
                    )
                })?;

            let event: Event = serde_json::from_str(event_json).map_err(|e| {
                error!(error = %e, event_json = %event_json, "イベントのデシリアライズに失敗");
                OpenSearchEventRepositoryError::SerializationError(format!(
                    "イベントのデシリアライズに失敗: {}",
                    e
                ))
            })?;

            events.push(event);
        }

        Ok(events)
    }

    /// HTTPエラーステータスコードを対応するエラー型に変換
    ///
    /// # Arguments
    /// * `status` - HTTPステータスコード
    /// * `body` - レスポンスボディ
    ///
    /// # Returns
    /// 対応するエラー型
    ///
    /// # 要件
    /// - 7.1: クエリタイムアウト時のエラー処理
    /// - 7.2: 一時的サービス利用不能時のエラー処理
    /// - 7.4: インデックス不存在時のエラー処理
    fn parse_error_status(status: u16, body: &str) -> OpenSearchEventRepositoryError {
        // インデックス不存在（404）の場合 (要件 7.4)
        if status == 404 {
            error!(status = status, body = %body, "インデックスが存在しません");
            return OpenSearchEventRepositoryError::IndexNotFound;
        }

        // タイムアウト (要件 7.1)
        if status == 408 || status == 504 {
            let error_msg = "クエリがタイムアウトしました";
            error!(status = status, body = %body, "{}", error_msg);
            return OpenSearchEventRepositoryError::Timeout(error_msg.to_string());
        }

        // サービス利用不能 (要件 7.2)
        if status == 503 {
            let error_msg = "サービスが一時的に利用できません";
            error!(status = status, body = %body, "{}", error_msg);
            return OpenSearchEventRepositoryError::QueryError(error_msg.to_string());
        }

        // その他のエラー
        error!(status = status, body = %body, "OpenSearchクエリエラー");
        OpenSearchEventRepositoryError::QueryError(format!(
            "OpenSearchエラー (status: {}): {}",
            status, body
        ))
    }
}

#[async_trait]
impl QueryRepository for OpenSearchEventRepository {
    /// OpenSearchを使用してフィルターに合致するイベントをクエリ
    ///
    /// # Arguments
    /// * `filters` - 検索条件のフィルター配列（OR結合）
    /// * `limit` - 取得する最大イベント数
    ///
    /// # Returns
    /// * `Ok(Vec<Event>)` - created_at降順でソートされたイベント
    /// * `Err(QueryRepositoryError)` - クエリ実行エラー
    ///
    /// # 要件
    /// - 5.1: REQメッセージ受信時にOpenSearchを使用してイベントをクエリ
    /// - 5.2: created_at降順でソート
    /// - 5.3: _sourceからevent_jsonを取得
    /// - 5.4-5.6: limit適用ロジック
    /// - 5.7: event_jsonをNostr Event形式にデシリアライズ
    #[instrument(skip(self), fields(index = %self.client.index_name(), filter_count = filters.len()))]
    async fn query(
        &self,
        filters: &[Filter],
        limit: Option<u32>,
    ) -> Result<Vec<Event>, QueryRepositoryError> {
        let applied_limit = Self::apply_limit(limit);
        debug!(
            original_limit = ?limit,
            applied_limit = applied_limit,
            "クエリを実行"
        );

        let query_body = Self::build_query_body(filters, applied_limit);
        debug!(query_body = %query_body, "クエリボディを構築");

        // OpenSearch検索を実行
        let index_name = self.client.index_name();
        let response = self
            .client
            .client()
            .search(SearchParts::Index(&[index_name]))
            .body(query_body)
            .send()
            .await
            .map_err(|e| {
                error!(error = %e, "OpenSearch検索リクエストに失敗");
                QueryRepositoryError::ConnectionError(format!("検索リクエストエラー: {}", e))
            })?;

        let status = response.status_code().as_u16();

        // レスポンスボディを取得
        let response_body = response.text().await.map_err(|e| {
            error!(error = %e, "レスポンスボディの取得に失敗");
            QueryRepositoryError::QueryError(format!("レスポンス取得エラー: {}", e))
        })?;

        // ステータスコードのチェック
        if status >= 400 {
            return Err(Self::parse_error_status(status, &response_body).into());
        }

        // レスポンスをパース
        let response_json: Value = serde_json::from_str(&response_body).map_err(|e| {
            error!(error = %e, body = %response_body, "レスポンスのパースに失敗");
            QueryRepositoryError::DeserializationError(format!("レスポンスパースエラー: {}", e))
        })?;

        // イベントを抽出
        let events =
            Self::extract_events_from_response(response_json).map_err(QueryRepositoryError::from)?;

        info!(
            result_count = events.len(),
            filter_count = filters.len(),
            applied_limit = applied_limit,
            "クエリが完了"
        );

        Ok(events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventId, Kind, PublicKey, Timestamp};

    // ==================== Task 6.1: クエリ構築とlimit適用テスト ====================

    // --- limit適用テスト (要件 5.4, 5.5, 5.6) ---

    #[test]
    fn test_apply_limit_with_specified_value() {
        // 要件 5.4: limitが指定された場合はその値を使用
        assert_eq!(OpenSearchEventRepository::apply_limit(Some(50)), 50);
        assert_eq!(OpenSearchEventRepository::apply_limit(Some(1)), 1);
        assert_eq!(OpenSearchEventRepository::apply_limit(Some(100)), 100);
    }

    #[test]
    fn test_apply_limit_default_when_none() {
        // 要件 5.5: limit未指定の場合はDEFAULT_LIMITを適用
        assert_eq!(OpenSearchEventRepository::apply_limit(None), DEFAULT_LIMIT);
    }

    #[test]
    fn test_apply_limit_clamped_to_max() {
        // 要件 5.6: limitがMAX_LIMITを超える場合はMAX_LIMITにクランプ
        assert_eq!(
            OpenSearchEventRepository::apply_limit(Some(10000)),
            MAX_LIMIT
        );
        assert_eq!(
            OpenSearchEventRepository::apply_limit(Some(MAX_LIMIT + 1)),
            MAX_LIMIT
        );
    }

    #[test]
    fn test_apply_limit_at_max() {
        // MAX_LIMITちょうどの場合はそのまま
        assert_eq!(
            OpenSearchEventRepository::apply_limit(Some(MAX_LIMIT)),
            MAX_LIMIT
        );
    }

    // --- クエリボディ構築テスト (要件 5.2, 5.3) ---

    #[test]
    fn test_build_query_body_with_empty_filters() {
        // 空のフィルターの場合
        let body = OpenSearchEventRepository::build_query_body(&[], 100);

        // match_allクエリが生成されること
        assert!(body["query"]["match_all"].is_object());

        // ソート順序: created_at降順、id昇順 (要件 5.2)
        let sort = body["sort"].as_array().unwrap();
        assert_eq!(sort.len(), 2);
        assert_eq!(sort[0]["created_at"]["order"].as_str().unwrap(), "desc");
        assert_eq!(sort[1]["id"]["order"].as_str().unwrap(), "asc");

        // size設定
        assert_eq!(body["size"].as_u64().unwrap(), 100);

        // _source設定（event_jsonのみ取得）(要件 5.3)
        let source = body["_source"].as_array().unwrap();
        assert_eq!(source.len(), 1);
        assert_eq!(source[0].as_str().unwrap(), "event_json");
    }

    #[test]
    fn test_build_query_body_with_kind_filter() {
        // kindフィルターの場合
        let filter = Filter::new().kind(Kind::TextNote);
        let body = OpenSearchEventRepository::build_query_body(&[filter], 50);

        // bool.filterクエリが生成されること
        assert!(body["query"]["bool"]["filter"].is_array());

        // sizeが指定値であること
        assert_eq!(body["size"].as_u64().unwrap(), 50);
    }

    #[test]
    fn test_build_query_body_with_multiple_filters() {
        // 複数フィルター（OR結合）の場合
        let filter1 = Filter::new().kind(Kind::TextNote);
        let filter2 = Filter::new().kind(Kind::Metadata);
        let body = OpenSearchEventRepository::build_query_body(&[filter1, filter2], 100);

        // bool.shouldクエリが生成されること
        let should = &body["query"]["bool"]["should"];
        assert!(should.is_array());
        assert_eq!(should.as_array().unwrap().len(), 2);
    }

    #[test]
    fn test_build_query_body_sort_order() {
        // ソート順序の詳細確認 (要件 5.2)
        let body = OpenSearchEventRepository::build_query_body(&[], 100);

        let sort = body["sort"].as_array().unwrap();

        // 第1ソートキー: created_at降順
        let first_sort = &sort[0];
        assert!(first_sort["created_at"].is_object());
        assert_eq!(first_sort["created_at"]["order"].as_str().unwrap(), "desc");

        // 第2ソートキー: id昇順（同一タイムスタンプでの決定論的順序）
        let second_sort = &sort[1];
        assert!(second_sort["id"].is_object());
        assert_eq!(second_sort["id"]["order"].as_str().unwrap(), "asc");
    }

    // ==================== Task 6.2: エラーハンドリングテスト ====================

    #[test]
    fn test_parse_error_status_index_not_found() {
        // 要件 7.4: インデックス不存在時はIndexNotFoundエラーを返す
        let error = OpenSearchEventRepository::parse_error_status(
            404,
            r#"{"error":{"type":"index_not_found_exception"}}"#,
        );

        match error {
            OpenSearchEventRepositoryError::IndexNotFound => {}
            _ => panic!("予期しないエラー型: {:?}", error),
        }
    }

    #[test]
    fn test_parse_error_status_timeout() {
        // 要件 7.1: クエリタイムアウト時のエラー処理
        let error = OpenSearchEventRepository::parse_error_status(
            408,
            r#"{"error":"request timeout"}"#,
        );

        match error {
            OpenSearchEventRepositoryError::Timeout(msg) => {
                assert!(msg.contains("タイムアウト"));
            }
            _ => panic!("予期しないエラー型: {:?}", error),
        }
    }

    #[test]
    fn test_parse_error_status_service_unavailable() {
        // 要件 7.2: 一時的サービス利用不能時のエラー処理
        let error = OpenSearchEventRepository::parse_error_status(
            503,
            r#"{"error":"service unavailable"}"#,
        );

        match error {
            OpenSearchEventRepositoryError::QueryError(msg) => {
                assert!(msg.contains("利用できません"));
            }
            _ => panic!("予期しないエラー型"),
        }
    }

    #[test]
    fn test_parse_error_status_gateway_timeout() {
        // 504 Gateway Timeoutもタイムアウトとして扱う
        let error = OpenSearchEventRepository::parse_error_status(
            504,
            r#"{"error":"gateway timeout"}"#,
        );

        match error {
            OpenSearchEventRepositoryError::Timeout(msg) => {
                assert!(msg.contains("タイムアウト"));
            }
            _ => panic!("予期しないエラー型: {:?}", error),
        }
    }

    #[test]
    fn test_parse_error_status_other_error() {
        // その他のエラー（400 Bad Request等）
        let error = OpenSearchEventRepository::parse_error_status(
            400,
            r#"{"error":"bad request"}"#,
        );

        match error {
            OpenSearchEventRepositoryError::QueryError(msg) => {
                assert!(msg.contains("400"));
            }
            _ => panic!("予期しないエラー型"),
        }
    }

    // --- エラー型変換テスト ---

    #[test]
    fn test_error_conversion_client_error() {
        let client_error = OpenSearchClientError::TransportBuildError("接続失敗".to_string());
        let error = OpenSearchEventRepositoryError::ClientError(client_error);
        let query_error: QueryRepositoryError = error.into();

        match query_error {
            QueryRepositoryError::ConnectionError(msg) => {
                assert!(msg.contains("接続失敗"));
            }
            _ => panic!("予期しないエラー型"),
        }
    }

    #[test]
    fn test_error_conversion_query() {
        let error = OpenSearchEventRepositoryError::QueryError("クエリ失敗".to_string());
        let query_error: QueryRepositoryError = error.into();

        match query_error {
            QueryRepositoryError::QueryError(msg) => {
                assert_eq!(msg, "クエリ失敗");
            }
            _ => panic!("予期しないエラー型"),
        }
    }

    #[test]
    fn test_error_conversion_serialization() {
        let error =
            OpenSearchEventRepositoryError::SerializationError("シリアライズ失敗".to_string());
        let query_error: QueryRepositoryError = error.into();

        match query_error {
            QueryRepositoryError::DeserializationError(msg) => {
                assert_eq!(msg, "シリアライズ失敗");
            }
            _ => panic!("予期しないエラー型"),
        }
    }

    #[test]
    fn test_error_conversion_index_not_found() {
        let error = OpenSearchEventRepositoryError::IndexNotFound;
        let query_error: QueryRepositoryError = error.into();

        match query_error {
            QueryRepositoryError::IndexNotFound(msg) => {
                assert!(msg.contains("インデックス"));
            }
            _ => panic!("予期しないエラー型: {:?}", query_error),
        }
    }

    #[test]
    fn test_error_conversion_timeout() {
        let error = OpenSearchEventRepositoryError::Timeout("タイムアウトしました".to_string());
        let query_error: QueryRepositoryError = error.into();

        match query_error {
            QueryRepositoryError::Timeout(msg) => {
                assert_eq!(msg, "タイムアウトしました");
            }
            _ => panic!("予期しないエラー型: {:?}", query_error),
        }
    }

    // --- エラー表示テスト ---

    #[test]
    fn test_error_display_client_error() {
        let client_error = OpenSearchClientError::TransportBuildError("test".to_string());
        let error = OpenSearchEventRepositoryError::ClientError(client_error);
        assert!(error.to_string().contains("クライアント初期化エラー"));
    }

    #[test]
    fn test_error_display_query() {
        let error = OpenSearchEventRepositoryError::QueryError("test".to_string());
        assert!(error.to_string().contains("クエリエラー"));
    }

    #[test]
    fn test_error_display_timeout() {
        let error = OpenSearchEventRepositoryError::Timeout("test".to_string());
        assert!(error.to_string().contains("クエリタイムアウト"));
    }

    #[test]
    fn test_error_display_serialization() {
        let error = OpenSearchEventRepositoryError::SerializationError("test".to_string());
        assert!(error.to_string().contains("シリアライズエラー"));
    }

    #[test]
    fn test_error_display_index_not_found() {
        let error = OpenSearchEventRepositoryError::IndexNotFound;
        assert!(error.to_string().contains("インデックスが存在しません"));
    }

    // ==================== Task 6.3: イベント抽出テスト ====================

    /// テスト用イベントを作成するヘルパー
    fn create_test_event_json(content: &str) -> String {
        use nostr::{EventBuilder, Keys};

        let keys = Keys::generate();
        let event = EventBuilder::text_note(content)
            .sign_with_keys(&keys)
            .expect("イベント署名に失敗");

        serde_json::to_string(&event).expect("イベントシリアライズに失敗")
    }

    #[test]
    fn test_extract_events_from_valid_response() {
        // 有効なレスポンスからイベントを抽出
        let event_json1 = create_test_event_json("test1");
        let event_json2 = create_test_event_json("test2");

        let response = json!({
            "hits": {
                "total": { "value": 2 },
                "hits": [
                    {
                        "_id": "abc123",
                        "_source": {
                            "event_json": event_json1
                        }
                    },
                    {
                        "_id": "def456",
                        "_source": {
                            "event_json": event_json2
                        }
                    }
                ]
            }
        });

        let events = OpenSearchEventRepository::extract_events_from_response(response)
            .expect("イベント抽出に失敗");

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].content, "test1");
        assert_eq!(events[1].content, "test2");
    }

    #[test]
    fn test_extract_events_from_empty_response() {
        // 空の検索結果
        let response = json!({
            "hits": {
                "total": { "value": 0 },
                "hits": []
            }
        });

        let events = OpenSearchEventRepository::extract_events_from_response(response)
            .expect("イベント抽出に失敗");

        assert_eq!(events.len(), 0);
    }

    #[test]
    fn test_extract_events_from_invalid_response_no_hits() {
        // hitsフィールドがないレスポンス
        let response = json!({
            "error": "something went wrong"
        });

        let result = OpenSearchEventRepository::extract_events_from_response(response);
        assert!(result.is_err());
    }

    #[test]
    fn test_extract_events_from_invalid_event_json() {
        // 無効なevent_json
        let response = json!({
            "hits": {
                "total": { "value": 1 },
                "hits": [
                    {
                        "_id": "abc123",
                        "_source": {
                            "event_json": "not valid json"
                        }
                    }
                ]
            }
        });

        let result = OpenSearchEventRepository::extract_events_from_response(response);
        assert!(result.is_err());
        match result.unwrap_err() {
            OpenSearchEventRepositoryError::SerializationError(msg) => {
                assert!(msg.contains("デシリアライズ"));
            }
            _ => panic!("予期しないエラー型"),
        }
    }

    #[test]
    fn test_extract_events_missing_event_json_field() {
        // event_jsonフィールドがない
        let response = json!({
            "hits": {
                "total": { "value": 1 },
                "hits": [
                    {
                        "_id": "abc123",
                        "_source": {
                            "other_field": "value"
                        }
                    }
                ]
            }
        });

        let result = OpenSearchEventRepository::extract_events_from_response(response);
        assert!(result.is_err());
        match result.unwrap_err() {
            OpenSearchEventRepositoryError::SerializationError(msg) => {
                assert!(msg.contains("event_json"));
            }
            _ => panic!("予期しないエラー型"),
        }
    }

    // --- 定数値テスト ---

    #[test]
    fn test_default_limit_value() {
        assert_eq!(DEFAULT_LIMIT, 100);
    }

    #[test]
    fn test_max_limit_value() {
        assert_eq!(MAX_LIMIT, 5000);
    }

    // ==================== フィルター変換統合テスト ====================

    #[test]
    fn test_query_body_with_all_filter_types() {
        // 全てのフィルタータイプを含むテスト
        let id_hex = "a".repeat(64);
        let pubkey_hex = "b".repeat(64);

        let filter = Filter::new()
            .id(EventId::from_hex(&id_hex).unwrap())
            .author(PublicKey::from_hex(&pubkey_hex).unwrap())
            .kind(Kind::TextNote)
            .since(Timestamp::from_secs(1700000000))
            .until(Timestamp::from_secs(1800000000))
            .custom_tag(
                nostr::SingleLetterTag::lowercase(nostr::Alphabet::E),
                "c".repeat(64),
            );

        let body = OpenSearchEventRepository::build_query_body(&[filter], 100);

        // クエリが正しく構築されていることを確認
        assert!(body["query"]["bool"]["filter"].is_array());
        assert_eq!(body["size"].as_u64().unwrap(), 100);
    }
}
