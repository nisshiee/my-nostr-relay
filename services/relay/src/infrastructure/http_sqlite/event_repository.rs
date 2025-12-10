// HTTP SQLiteイベントリポジトリ - QueryRepository実装
//
// EC2上のHTTP APIサーバー（SQLite）に接続してクエリを実行する。
// Lambda関数からのREQクエリ処理に使用。
//
// 要件: 5.1, 5.2, 5.5

use super::config::HttpSqliteConfig;
use crate::infrastructure::event_repository::QueryRepositoryError;
use crate::infrastructure::QueryRepository;
use async_trait::async_trait;
use nostr::{Event, Filter};
use reqwest::Client;
use serde::Serialize;
use std::collections::HashMap;
use thiserror::Error;
use tracing::{debug, error, info, instrument};

/// デフォルトの取得件数制限
const DEFAULT_LIMIT: u32 = 100;

/// 最大取得件数制限
const MAX_LIMIT: u32 = 5000;

/// HttpSqliteEventRepository固有のエラー型
#[derive(Debug, Error)]
pub enum HttpSqliteEventRepositoryError {
    /// HTTPリクエストエラー
    #[error("HTTPリクエストエラー: {0}")]
    HttpError(String),

    /// 認証エラー（401）
    #[error("認証エラー: APIトークンが無効です")]
    AuthenticationError,

    /// サーバーエラー（5xx）
    #[error("サーバーエラー: {0}")]
    ServerError(String),

    /// レスポンスのデシリアライズエラー
    #[error("レスポンスのデシリアライズエラー: {0}")]
    DeserializationError(String),

    /// 接続エラー
    #[error("接続エラー: {0}")]
    ConnectionError(String),
}

impl From<HttpSqliteEventRepositoryError> for QueryRepositoryError {
    fn from(err: HttpSqliteEventRepositoryError) -> Self {
        match err {
            HttpSqliteEventRepositoryError::HttpError(msg) => QueryRepositoryError::QueryError(msg),
            HttpSqliteEventRepositoryError::AuthenticationError => {
                QueryRepositoryError::QueryError("認証エラー: APIトークンが無効です".to_string())
            }
            HttpSqliteEventRepositoryError::ServerError(msg) => QueryRepositoryError::QueryError(msg),
            HttpSqliteEventRepositoryError::DeserializationError(msg) => {
                QueryRepositoryError::DeserializationError(msg)
            }
            HttpSqliteEventRepositoryError::ConnectionError(msg) => {
                QueryRepositoryError::ConnectionError(msg)
            }
        }
    }
}

/// 検索フィルターリクエスト
///
/// EC2 HTTP APIサーバーに送信する検索フィルター形式
#[derive(Debug, Serialize)]
struct SearchFilter {
    #[serde(skip_serializing_if = "Option::is_none")]
    ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    authors: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    kinds: Option<Vec<u32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    since: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    until: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    limit: Option<u32>,
    #[serde(flatten)]
    tags: HashMap<String, Vec<String>>,
}

impl SearchFilter {
    /// nostr::Filterから変換
    fn from_nostr_filter(filter: &Filter, limit: u32) -> Self {
        let ids = filter
            .ids
            .as_ref()
            .map(|ids| ids.iter().map(|id| id.to_hex()).collect());

        let authors = filter
            .authors
            .as_ref()
            .map(|authors| authors.iter().map(|pk| pk.to_hex()).collect());

        let kinds = filter
            .kinds
            .as_ref()
            .map(|kinds| kinds.iter().map(|k| k.as_u16() as u32).collect());

        let since = filter.since.map(|t| t.as_secs());
        let until = filter.until.map(|t| t.as_secs());

        // タグフィルターを構築
        let mut tags = HashMap::new();
        for (tag, values) in &filter.generic_tags {
            let tag_name = format!("#{}", tag.as_char());
            let tag_values: Vec<String> = values.iter().map(|v| v.to_string()).collect();
            if !tag_values.is_empty() {
                tags.insert(tag_name, tag_values);
            }
        }

        Self {
            ids,
            authors,
            kinds,
            since,
            until,
            limit: Some(limit),
            tags,
        }
    }
}

/// 検索リクエストボディ
///
/// 複数フィルターをOR結合で送信する
#[derive(Debug, Serialize)]
struct SearchRequest {
    filters: Vec<SearchFilter>,
}

/// HTTP SQLiteイベントリポジトリ
///
/// EC2上のHTTP APIサーバーに接続してクエリを実行する。
/// QueryRepositoryトレイトを実装し、Lambda関数からのREQクエリ処理に使用。
///
/// # 要件
/// - 5.1: EC2エンドポイントへのHTTPS通信
/// - 5.2: QueryRepositoryトレイトを実装
/// - 5.5: Authorizationヘッダーにトークンを付与
#[derive(Clone)]
pub struct HttpSqliteEventRepository {
    /// HTTPクライアント
    client: Client,
    /// 設定
    config: HttpSqliteConfig,
}

impl std::fmt::Debug for HttpSqliteEventRepository {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpSqliteEventRepository")
            .field("endpoint", &self.config.endpoint())
            .finish_non_exhaustive()
    }
}

impl HttpSqliteEventRepository {
    /// 設定からHttpSqliteEventRepositoryを作成
    ///
    /// # 引数
    /// * `config` - HTTP SQLite接続設定
    ///
    /// # 戻り値
    /// * `HttpSqliteEventRepository` - 初期化されたリポジトリ
    pub fn new(config: HttpSqliteConfig) -> Self {
        info!(
            endpoint = config.endpoint(),
            "HttpSqliteEventRepositoryを初期化"
        );

        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("HTTPクライアントの構築に失敗");

        Self { client, config }
    }

    /// テスト用: カスタムHTTPクライアントを指定して作成
    #[cfg(test)]
    pub fn with_client(config: HttpSqliteConfig, client: Client) -> Self {
        Self { client, config }
    }

    /// 設定への参照を取得
    ///
    /// # 戻り値
    /// * `&HttpSqliteConfig` - 設定への参照
    pub fn config(&self) -> &HttpSqliteConfig {
        &self.config
    }

    /// limitを適用（default_limit、max_limit制約）
    ///
    /// # 引数
    /// * `limit` - クライアントから指定されたlimit（オプション）
    ///
    /// # 戻り値
    /// 適用後のlimit値
    fn apply_limit(limit: Option<u32>) -> u32 {
        match limit {
            Some(l) if l > MAX_LIMIT => MAX_LIMIT,
            Some(l) => l,
            None => DEFAULT_LIMIT,
        }
    }

    /// 検索リクエストを実行
    ///
    /// # 引数
    /// * `filters` - 検索フィルター配列
    /// * `limit` - 適用後のlimit値
    ///
    /// # 戻り値
    /// * `Ok(Vec<Event>)` - イベントの配列
    /// * `Err(HttpSqliteEventRepositoryError)` - エラー
    async fn execute_search(
        &self,
        filters: &[Filter],
        limit: u32,
    ) -> Result<Vec<Event>, HttpSqliteEventRepositoryError> {
        let search_url = self.config.search_url();

        // 検索リクエストを構築
        let search_filters: Vec<SearchFilter> = filters
            .iter()
            .map(|f| SearchFilter::from_nostr_filter(f, limit))
            .collect();

        let request_body = SearchRequest {
            filters: search_filters,
        };

        debug!(
            url = %search_url,
            filter_count = filters.len(),
            limit = limit,
            "検索リクエストを送信"
        );

        // HTTPリクエストを送信
        let response = self
            .client
            .post(&search_url)
            .header("Authorization", format!("Bearer {}", self.config.api_token()))
            .header("Content-Type", "application/json")
            .json(&request_body)
            .send()
            .await
            .map_err(|e| {
                error!(error = %e, "HTTPリクエスト送信に失敗");
                if e.is_connect() {
                    HttpSqliteEventRepositoryError::ConnectionError(e.to_string())
                } else {
                    HttpSqliteEventRepositoryError::HttpError(e.to_string())
                }
            })?;

        let status = response.status();

        // ステータスコードをチェック
        if status == reqwest::StatusCode::UNAUTHORIZED {
            error!("認証エラー: APIトークンが無効です");
            return Err(HttpSqliteEventRepositoryError::AuthenticationError);
        }

        if status.is_server_error() {
            let body = response.text().await.unwrap_or_default();
            error!(status = %status, body = %body, "サーバーエラー");
            return Err(HttpSqliteEventRepositoryError::ServerError(format!(
                "ステータス {}: {}",
                status, body
            )));
        }

        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            error!(status = %status, body = %body, "HTTPエラー");
            return Err(HttpSqliteEventRepositoryError::HttpError(format!(
                "ステータス {}: {}",
                status, body
            )));
        }

        // レスポンスをパース
        let events: Vec<Event> = response.json().await.map_err(|e| {
            error!(error = %e, "レスポンスのデシリアライズに失敗");
            HttpSqliteEventRepositoryError::DeserializationError(e.to_string())
        })?;

        info!(
            result_count = events.len(),
            filter_count = filters.len(),
            limit = limit,
            "検索が完了"
        );

        Ok(events)
    }
}

#[async_trait]
impl QueryRepository for HttpSqliteEventRepository {
    /// HTTP APIを使用してフィルターに合致するイベントをクエリ
    ///
    /// # 引数
    /// * `filters` - 検索条件のフィルター配列（OR結合）
    /// * `limit` - 取得する最大イベント数
    ///
    /// # 戻り値
    /// * `Ok(Vec<Event>)` - created_at降順でソートされたイベント
    /// * `Err(QueryRepositoryError)` - クエリ実行エラー
    ///
    /// # 要件
    /// - 5.1: EC2エンドポイントへのHTTPS通信
    /// - 5.2: QueryRepositoryトレイトを実装
    /// - 5.5: Authorizationヘッダーにトークンを付与
    #[instrument(skip(self), fields(endpoint = %self.config.endpoint(), filter_count = filters.len()))]
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

        self.execute_search(filters, applied_limit)
            .await
            .map_err(QueryRepositoryError::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventId, Kind, PublicKey, Timestamp};

    // ==================== limit適用テスト ====================

    #[test]
    fn test_apply_limit_with_specified_value() {
        assert_eq!(HttpSqliteEventRepository::apply_limit(Some(50)), 50);
        assert_eq!(HttpSqliteEventRepository::apply_limit(Some(1)), 1);
        assert_eq!(HttpSqliteEventRepository::apply_limit(Some(100)), 100);
    }

    #[test]
    fn test_apply_limit_default_when_none() {
        assert_eq!(HttpSqliteEventRepository::apply_limit(None), DEFAULT_LIMIT);
    }

    #[test]
    fn test_apply_limit_clamped_to_max() {
        assert_eq!(
            HttpSqliteEventRepository::apply_limit(Some(10000)),
            MAX_LIMIT
        );
        assert_eq!(
            HttpSqliteEventRepository::apply_limit(Some(MAX_LIMIT + 1)),
            MAX_LIMIT
        );
    }

    #[test]
    fn test_apply_limit_at_max() {
        assert_eq!(
            HttpSqliteEventRepository::apply_limit(Some(MAX_LIMIT)),
            MAX_LIMIT
        );
    }

    // ==================== SearchFilter変換テスト ====================

    #[test]
    fn test_search_filter_from_empty_filter() {
        let filter = Filter::new();
        let search_filter = SearchFilter::from_nostr_filter(&filter, 100);

        assert!(search_filter.ids.is_none());
        assert!(search_filter.authors.is_none());
        assert!(search_filter.kinds.is_none());
        assert!(search_filter.since.is_none());
        assert!(search_filter.until.is_none());
        assert_eq!(search_filter.limit, Some(100));
        assert!(search_filter.tags.is_empty());
    }

    #[test]
    fn test_search_filter_with_kind() {
        let filter = Filter::new().kind(Kind::TextNote);
        let search_filter = SearchFilter::from_nostr_filter(&filter, 50);

        assert!(search_filter.ids.is_none());
        assert!(search_filter.authors.is_none());
        assert_eq!(search_filter.kinds, Some(vec![1]));
        assert_eq!(search_filter.limit, Some(50));
    }

    #[test]
    fn test_search_filter_with_multiple_kinds() {
        let filter = Filter::new().kinds([Kind::TextNote, Kind::Metadata]);
        let search_filter = SearchFilter::from_nostr_filter(&filter, 100);

        let kinds = search_filter.kinds.unwrap();
        assert_eq!(kinds.len(), 2);
        assert!(kinds.contains(&1)); // TextNote
        assert!(kinds.contains(&0)); // Metadata
    }

    #[test]
    fn test_search_filter_with_author() {
        let pubkey_hex = "a".repeat(64);
        let pubkey = PublicKey::from_hex(&pubkey_hex).unwrap();
        let filter = Filter::new().author(pubkey);
        let search_filter = SearchFilter::from_nostr_filter(&filter, 100);

        assert_eq!(search_filter.authors, Some(vec![pubkey_hex]));
    }

    #[test]
    fn test_search_filter_with_ids() {
        let id_hex = "b".repeat(64);
        let event_id = EventId::from_hex(&id_hex).unwrap();
        let filter = Filter::new().id(event_id);
        let search_filter = SearchFilter::from_nostr_filter(&filter, 100);

        assert_eq!(search_filter.ids, Some(vec![id_hex]));
    }

    #[test]
    fn test_search_filter_with_time_range() {
        let filter = Filter::new()
            .since(Timestamp::from_secs(1700000000))
            .until(Timestamp::from_secs(1800000000));
        let search_filter = SearchFilter::from_nostr_filter(&filter, 100);

        assert_eq!(search_filter.since, Some(1700000000));
        assert_eq!(search_filter.until, Some(1800000000));
    }

    #[test]
    fn test_search_filter_with_tag() {
        let filter = Filter::new().custom_tag(
            nostr::SingleLetterTag::lowercase(nostr::Alphabet::E),
            "c".repeat(64),
        );
        let search_filter = SearchFilter::from_nostr_filter(&filter, 100);

        assert!(search_filter.tags.contains_key("#e"));
        let e_tags = search_filter.tags.get("#e").unwrap();
        assert_eq!(e_tags.len(), 1);
        assert_eq!(e_tags[0], "c".repeat(64));
    }

    // ==================== エラー型テスト ====================

    #[test]
    fn test_error_display_http_error() {
        let error = HttpSqliteEventRepositoryError::HttpError("接続失敗".to_string());
        assert!(error.to_string().contains("HTTPリクエストエラー"));
        assert!(error.to_string().contains("接続失敗"));
    }

    #[test]
    fn test_error_display_authentication_error() {
        let error = HttpSqliteEventRepositoryError::AuthenticationError;
        assert!(error.to_string().contains("認証エラー"));
    }

    #[test]
    fn test_error_display_server_error() {
        let error = HttpSqliteEventRepositoryError::ServerError("500 Internal Server Error".to_string());
        assert!(error.to_string().contains("サーバーエラー"));
    }

    #[test]
    fn test_error_display_deserialization_error() {
        let error = HttpSqliteEventRepositoryError::DeserializationError("invalid json".to_string());
        assert!(error.to_string().contains("デシリアライズエラー"));
    }

    #[test]
    fn test_error_display_connection_error() {
        let error = HttpSqliteEventRepositoryError::ConnectionError("timeout".to_string());
        assert!(error.to_string().contains("接続エラー"));
    }

    // ==================== エラー型変換テスト ====================

    #[test]
    fn test_error_conversion_http_error() {
        let error = HttpSqliteEventRepositoryError::HttpError("test".to_string());
        let query_error: QueryRepositoryError = error.into();

        match query_error {
            QueryRepositoryError::QueryError(msg) => {
                assert_eq!(msg, "test");
            }
            _ => panic!("予期しないエラー型"),
        }
    }

    #[test]
    fn test_error_conversion_authentication_error() {
        let error = HttpSqliteEventRepositoryError::AuthenticationError;
        let query_error: QueryRepositoryError = error.into();

        match query_error {
            QueryRepositoryError::QueryError(msg) => {
                assert!(msg.contains("認証エラー"));
            }
            _ => panic!("予期しないエラー型"),
        }
    }

    #[test]
    fn test_error_conversion_connection_error() {
        let error = HttpSqliteEventRepositoryError::ConnectionError("test".to_string());
        let query_error: QueryRepositoryError = error.into();

        match query_error {
            QueryRepositoryError::ConnectionError(msg) => {
                assert_eq!(msg, "test");
            }
            _ => panic!("予期しないエラー型"),
        }
    }

    #[test]
    fn test_error_conversion_deserialization_error() {
        let error = HttpSqliteEventRepositoryError::DeserializationError("test".to_string());
        let query_error: QueryRepositoryError = error.into();

        match query_error {
            QueryRepositoryError::DeserializationError(msg) => {
                assert_eq!(msg, "test");
            }
            _ => panic!("予期しないエラー型"),
        }
    }

    // ==================== リポジトリ作成テスト ====================

    #[test]
    fn test_new_creates_repository() {
        let config = HttpSqliteConfig::new("https://example.com", "test-token");
        let repo = HttpSqliteEventRepository::new(config);

        // Debugが正しく実装されていることを確認
        let debug_str = format!("{:?}", repo);
        assert!(debug_str.contains("HttpSqliteEventRepository"));
        assert!(debug_str.contains("https://example.com"));
    }

    // ==================== SearchRequest構造体テスト ====================

    #[test]
    fn test_search_request_serialization() {
        let filter = Filter::new().kind(Kind::TextNote);
        let search_filter = SearchFilter::from_nostr_filter(&filter, 100);
        let request = SearchRequest {
            filters: vec![search_filter],
        };

        let json = serde_json::to_string(&request).expect("シリアライズに失敗");
        assert!(json.contains("filters"));
        assert!(json.contains("kinds"));
        assert!(json.contains("limit"));
    }

    #[test]
    fn test_search_filter_skips_none_fields() {
        let filter = Filter::new().kind(Kind::TextNote);
        let search_filter = SearchFilter::from_nostr_filter(&filter, 100);

        let json = serde_json::to_string(&search_filter).expect("シリアライズに失敗");
        // None値はスキップされる
        assert!(!json.contains("ids"));
        assert!(!json.contains("authors"));
        assert!(!json.contains("since"));
        assert!(!json.contains("until"));
        // 設定された値は含まれる
        assert!(json.contains("kinds"));
        assert!(json.contains("limit"));
    }

    // ==================== 定数値テスト ====================

    #[test]
    fn test_default_limit_value() {
        assert_eq!(DEFAULT_LIMIT, 100);
    }

    #[test]
    fn test_max_limit_value() {
        assert_eq!(MAX_LIMIT, 5000);
    }
}
