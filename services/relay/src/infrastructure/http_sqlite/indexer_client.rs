// IndexerClient - Indexer Lambda用HTTPクライアント
//
// EC2上のHTTP APIサーバーへのイベントインデックス作成・削除を行う。
// DynamoDB Streams経由のイベント変更をEC2 SQLiteに同期する。
//
// 要件: 5.3, 5.4, 5.5, 5.6

use super::config::HttpSqliteConfig;
use nostr::Event;
use reqwest::Client;
use reqwest_middleware::{ClientBuilder, ClientWithMiddleware};
use reqwest_retry::{policies::ExponentialBackoff, RetryTransientMiddleware};
use std::time::Duration;
use thiserror::Error;
use tracing::{debug, error, info, instrument, warn};

/// 最大再試行回数
const MAX_RETRIES: u32 = 3;

/// リクエストタイムアウト（秒）
const REQUEST_TIMEOUT_SECS: u64 = 30;

/// 接続タイムアウト（秒）
const CONNECT_TIMEOUT_SECS: u64 = 10;

/// HttpSqliteIndexerClient用エラー型
///
/// # エラー種別
/// - `HttpError`: HTTPリクエストのエラーレスポンス
/// - `NetworkError`: ネットワーク接続エラー
/// - `SerializationError`: シリアライズエラー
/// - `RetryExhausted`: 再試行回数超過
#[derive(Debug, Error)]
pub enum HttpSqliteIndexerError {
    /// HTTPエラー（ステータスコード付き）
    #[error("HTTPエラー: status={status}, message={message}")]
    HttpError {
        /// HTTPステータスコード
        status: u16,
        /// エラーメッセージ
        message: String,
    },

    /// ネットワークエラー
    #[error("ネットワークエラー: {0}")]
    NetworkError(String),

    /// シリアライズエラー
    #[error("シリアライズエラー: {0}")]
    SerializationError(String),

    /// 再試行回数超過エラー
    #[error("再試行回数超過: {0}")]
    RetryExhausted(String),
}

/// IndexerClient - EC2 HTTP APIクライアント
///
/// Indexer LambdaからEC2上のHTTP APIサーバーにイベントを登録・削除する。
/// 指数バックオフによる再試行機能を持つ。
///
/// # 要件
/// - 5.3: POST /eventsでイベントをインデックス化
/// - 5.4: DELETE /events/{id}でイベントを削除
/// - 5.5: Authorizationヘッダーにトークンを付与
/// - 5.6: 指数バックオフで最大3回再試行
#[derive(Clone)]
pub struct IndexerClient {
    /// HTTPクライアント（再試行ミドルウェア付き）
    client: ClientWithMiddleware,
    /// EC2エンドポイントURL
    endpoint: String,
    /// APIトークン
    api_token: String,
}

impl std::fmt::Debug for IndexerClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IndexerClient")
            .field("endpoint", &self.endpoint)
            .finish_non_exhaustive()
    }
}

impl IndexerClient {
    /// 設定からIndexerClientを作成
    ///
    /// # 引数
    /// * `config` - HTTP SQLite接続設定
    ///
    /// # 戻り値
    /// * `IndexerClient` - 初期化されたクライアント
    ///
    /// # 要件
    /// - 5.6: 指数バックオフで最大3回再試行（ExponentialBackoff）
    pub fn new(config: &HttpSqliteConfig) -> Self {
        info!(
            endpoint = config.endpoint(),
            "IndexerClientを初期化"
        );

        // 基本HTTPクライアントを作成
        let base_client = Client::builder()
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
            .build()
            .expect("HTTPクライアントの構築に失敗");

        // 指数バックオフ再試行ポリシー
        let retry_policy = ExponentialBackoff::builder()
            .build_with_max_retries(MAX_RETRIES);

        // 再試行ミドルウェア付きクライアントを構築
        let client = ClientBuilder::new(base_client)
            .with(RetryTransientMiddleware::new_with_policy(retry_policy))
            .build();

        Self {
            client,
            endpoint: config.endpoint().to_string(),
            api_token: config.api_token().to_string(),
        }
    }

    /// イベント登録エンドポイントURLを構築
    fn events_url(&self) -> String {
        format!("{}/events", self.endpoint.trim_end_matches('/'))
    }

    /// イベント削除エンドポイントURLを構築
    fn delete_url(&self, event_id: &str) -> String {
        format!("{}/events/{}", self.endpoint.trim_end_matches('/'), event_id)
    }

    /// イベントをインデックス化（POST /events）
    ///
    /// # 引数
    /// * `event` - インデックス化するNostrイベント
    ///
    /// # 戻り値
    /// * `Ok(())` - インデックス化成功（201 Createdまたは200 OK）
    /// * `Err(HttpSqliteIndexerError)` - エラー
    ///
    /// # 要件
    /// - 5.3: POST /eventsでイベントをインデックス化
    /// - 5.5: Authorizationヘッダーにトークンを付与
    /// - 5.6: エラー時のログ記録と再試行
    #[instrument(skip(self, event), fields(event_id = %event.id))]
    pub async fn index_event(&self, event: &Event) -> Result<(), HttpSqliteIndexerError> {
        let url = self.events_url();
        debug!(url = %url, "イベントをインデックス化");

        // イベントをJSONにシリアライズ
        let body = serde_json::to_string(&event).map_err(|e| {
            error!(error = %e, "イベントのシリアライズに失敗");
            HttpSqliteIndexerError::SerializationError(e.to_string())
        })?;

        let response = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.api_token))
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .await
            .map_err(|e| {
                error!(error = %e, "イベントインデックスリクエスト失敗");
                if e.is_timeout() || e.is_connect() {
                    HttpSqliteIndexerError::NetworkError(e.to_string())
                } else {
                    HttpSqliteIndexerError::RetryExhausted(e.to_string())
                }
            })?;

        let status = response.status();

        // 201 Createdまたは200 OK（既存）は成功
        if status.is_success() {
            info!(
                event_id = %event.id,
                status = %status,
                "イベントのインデックス化に成功"
            );
            return Ok(());
        }

        // エラーレスポンスを処理
        let body = response.text().await.unwrap_or_default();
        error!(
            status = %status,
            body = %body,
            event_id = %event.id,
            "イベントインデックスエラー"
        );

        Err(HttpSqliteIndexerError::HttpError {
            status: status.as_u16(),
            message: body,
        })
    }

    /// イベントを削除（DELETE /events/{id}）
    ///
    /// # 引数
    /// * `event_id` - 削除するイベントID（64文字hex）
    ///
    /// # 戻り値
    /// * `Ok(())` - 削除成功（204 No Contentまたは404 Not Found）
    /// * `Err(HttpSqliteIndexerError)` - エラー
    ///
    /// # 注意
    /// 404 Not Foundは成功として扱う（べき等性の確保）
    ///
    /// # 要件
    /// - 5.4: DELETE /events/{id}でイベントを削除
    /// - 5.5: Authorizationヘッダーにトークンを付与
    /// - 5.6: エラー時のログ記録と再試行
    #[instrument(skip(self), fields(event_id = %event_id))]
    pub async fn delete_event(&self, event_id: &str) -> Result<(), HttpSqliteIndexerError> {
        let url = self.delete_url(event_id);
        debug!(url = %url, "イベントを削除");

        let response = self
            .client
            .delete(&url)
            .header("Authorization", format!("Bearer {}", self.api_token))
            .send()
            .await
            .map_err(|e| {
                error!(error = %e, "イベント削除リクエスト失敗");
                if e.is_timeout() || e.is_connect() {
                    HttpSqliteIndexerError::NetworkError(e.to_string())
                } else {
                    HttpSqliteIndexerError::RetryExhausted(e.to_string())
                }
            })?;

        let status = response.status();

        // 204 No Contentは成功
        if status == reqwest::StatusCode::NO_CONTENT {
            info!(event_id = %event_id, "イベント削除成功");
            return Ok(());
        }

        // 404 Not Foundは成功として扱う（べき等性）
        if status == reqwest::StatusCode::NOT_FOUND {
            warn!(event_id = %event_id, "イベントが既に存在しない（削除成功として扱う）");
            return Ok(());
        }

        // その他の成功ステータスも成功として扱う
        if status.is_success() {
            info!(event_id = %event_id, status = %status, "イベント削除成功");
            return Ok(());
        }

        // エラーレスポンスを処理
        let body = response.text().await.unwrap_or_default();
        error!(
            status = %status,
            body = %body,
            event_id = %event_id,
            "イベント削除エラー"
        );

        Err(HttpSqliteIndexerError::HttpError {
            status: status.as_u16(),
            message: body,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ==================== HttpSqliteIndexerError テスト ====================

    #[test]
    fn test_error_display_http_error() {
        let error = HttpSqliteIndexerError::HttpError {
            status: 500,
            message: "Internal Server Error".to_string(),
        };
        let display = error.to_string();
        assert!(display.contains("HTTPエラー"));
        assert!(display.contains("500"));
        assert!(display.contains("Internal Server Error"));
    }

    #[test]
    fn test_error_display_network_error() {
        let error = HttpSqliteIndexerError::NetworkError("connection refused".to_string());
        let display = error.to_string();
        assert!(display.contains("ネットワークエラー"));
        assert!(display.contains("connection refused"));
    }

    #[test]
    fn test_error_display_serialization_error() {
        let error = HttpSqliteIndexerError::SerializationError("invalid JSON".to_string());
        let display = error.to_string();
        assert!(display.contains("シリアライズエラー"));
        assert!(display.contains("invalid JSON"));
    }

    #[test]
    fn test_error_display_retry_exhausted() {
        let error = HttpSqliteIndexerError::RetryExhausted("max retries exceeded".to_string());
        let display = error.to_string();
        assert!(display.contains("再試行回数超過"));
        assert!(display.contains("max retries exceeded"));
    }

    // ==================== URL構築テスト ====================

    #[test]
    fn test_events_url_without_trailing_slash() {
        let config = HttpSqliteConfig::new("https://example.com", "token");
        let client = IndexerClient::new(&config);
        assert_eq!(client.events_url(), "https://example.com/events");
    }

    #[test]
    fn test_events_url_with_trailing_slash() {
        let config = HttpSqliteConfig::new("https://example.com/", "token");
        let client = IndexerClient::new(&config);
        assert_eq!(client.events_url(), "https://example.com/events");
    }

    #[test]
    fn test_delete_url_without_trailing_slash() {
        let config = HttpSqliteConfig::new("https://example.com", "token");
        let client = IndexerClient::new(&config);
        let event_id = "a".repeat(64);
        assert_eq!(
            client.delete_url(&event_id),
            format!("https://example.com/events/{}", event_id)
        );
    }

    #[test]
    fn test_delete_url_with_trailing_slash() {
        let config = HttpSqliteConfig::new("https://example.com/", "token");
        let client = IndexerClient::new(&config);
        let event_id = "b".repeat(64);
        assert_eq!(
            client.delete_url(&event_id),
            format!("https://example.com/events/{}", event_id)
        );
    }

    // ==================== クライアント作成テスト ====================

    #[test]
    fn test_new_creates_client() {
        let config = HttpSqliteConfig::new("https://example.com", "test-token");
        let client = IndexerClient::new(&config);

        // Debugが正しく実装されていることを確認
        let debug_str = format!("{:?}", client);
        assert!(debug_str.contains("IndexerClient"));
        assert!(debug_str.contains("https://example.com"));
    }

    #[test]
    fn test_client_is_clone() {
        let config = HttpSqliteConfig::new("https://example.com", "test-token");
        let client = IndexerClient::new(&config);
        let _cloned = client.clone();
    }

    // ==================== 定数値テスト ====================

    #[test]
    fn test_max_retries() {
        assert_eq!(MAX_RETRIES, 3);
    }

    #[test]
    fn test_request_timeout() {
        assert_eq!(REQUEST_TIMEOUT_SECS, 30);
    }

    #[test]
    fn test_connect_timeout() {
        assert_eq!(CONNECT_TIMEOUT_SECS, 10);
    }
}
