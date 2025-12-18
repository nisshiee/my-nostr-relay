/// ヘルスチェック操作モジュール
///
/// sqlite-apiの/healthエンドポイントに対するHTTPヘルスチェックを実行する。
/// リトライロジック（最大5回、5秒間隔）を実装し、Recovery Lambdaから利用される。
///
/// 要件: 4.5
use async_trait::async_trait;
use thiserror::Error;
use tracing::{info, warn};

/// ヘルスチェック操作のエラー型
#[derive(Debug, Error)]
pub enum HealthCheckError {
    /// HTTPリクエストエラー
    #[error("HTTPリクエスト失敗: {0}")]
    RequestFailed(String),

    /// タイムアウト
    #[error("ヘルスチェックタイムアウト")]
    Timeout,

    /// 非成功レスポンス
    #[error("ヘルスチェック失敗: ステータスコード {0}")]
    UnhealthyStatus(u16),

    /// 最大リトライ回数超過
    #[error("ヘルスチェック失敗: {max_retries}回のリトライ後も成功しませんでした")]
    MaxRetriesExceeded { max_retries: u32 },
}

/// ヘルスチェックの結果
#[derive(Debug, Clone)]
pub struct HealthCheckResult {
    /// ヘルスチェックが成功したかどうか
    pub healthy: bool,
    /// レスポンスステータスコード
    pub status_code: u16,
    /// 試行回数
    pub attempts: u32,
    /// 合計所要時間（ミリ秒）
    pub total_duration_ms: u64,
}

impl HealthCheckResult {
    /// 成功結果を作成
    pub fn success(status_code: u16, attempts: u32, total_duration_ms: u64) -> Self {
        Self {
            healthy: true,
            status_code,
            attempts,
            total_duration_ms,
        }
    }

    /// 結果メッセージを生成
    pub fn message(&self) -> String {
        format!(
            "sqlite-api healthy (status: {}, attempts: {})",
            self.status_code, self.attempts
        )
    }
}

/// ヘルスチェック操作トレイト
///
/// 抽象化によりテスト時にモック実装を注入可能にする
#[async_trait]
pub trait HealthCheckOps: Send + Sync {
    /// ヘルスチェックを実行（リトライ付き）
    ///
    /// # 引数
    /// * `endpoint` - ベースエンドポイントURL（例: "https://example.com"）
    /// * `max_retries` - 最大リトライ回数
    /// * `retry_interval_secs` - リトライ間隔（秒）
    ///
    /// # 戻り値
    /// * `Ok(HealthCheckResult)` - ヘルスチェック成功
    /// * `Err(HealthCheckError)` - ヘルスチェック失敗
    async fn check_health_with_retry(
        &self,
        endpoint: &str,
        max_retries: u32,
        retry_interval_secs: u64,
    ) -> Result<HealthCheckResult, HealthCheckError>;
}

/// reqwestを使用したHTTPヘルスチェック実装
pub struct HttpHealthCheck {
    client: reqwest::Client,
}

impl HttpHealthCheck {
    /// デフォルト設定で作成
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("HTTPクライアント作成失敗");

        Self { client }
    }

    /// カスタムクライアントで作成（テスト用）
    pub fn with_client(client: reqwest::Client) -> Self {
        Self { client }
    }
}

impl Default for HttpHealthCheck {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl HealthCheckOps for HttpHealthCheck {
    async fn check_health_with_retry(
        &self,
        endpoint: &str,
        max_retries: u32,
        retry_interval_secs: u64,
    ) -> Result<HealthCheckResult, HealthCheckError> {
        let health_url = format!("{}/health", endpoint.trim_end_matches('/'));
        let start_time = std::time::Instant::now();
        let mut last_error: Option<HealthCheckError> = None;

        for attempt in 1..=max_retries {
            info!(
                attempt = attempt,
                max_retries = max_retries,
                url = %health_url,
                "ヘルスチェック試行"
            );

            match self.client.get(&health_url).send().await {
                Ok(response) => {
                    let status = response.status();
                    let status_code = status.as_u16();

                    if status.is_success() {
                        let total_duration_ms = start_time.elapsed().as_millis() as u64;

                        info!(
                            status_code = status_code,
                            attempts = attempt,
                            duration_ms = total_duration_ms,
                            "ヘルスチェック成功"
                        );

                        return Ok(HealthCheckResult::success(
                            status_code,
                            attempt,
                            total_duration_ms,
                        ));
                    }

                    warn!(
                        status_code = status_code,
                        attempt = attempt,
                        "ヘルスチェック失敗: 非成功ステータス"
                    );

                    last_error = Some(HealthCheckError::UnhealthyStatus(status_code));
                }
                Err(err) => {
                    let error_msg = if err.is_timeout() {
                        "タイムアウト".to_string()
                    } else if err.is_connect() {
                        "接続失敗".to_string()
                    } else {
                        err.to_string()
                    };

                    warn!(
                        error = %error_msg,
                        attempt = attempt,
                        "ヘルスチェック失敗: HTTPリクエストエラー"
                    );

                    last_error = Some(HealthCheckError::RequestFailed(error_msg));
                }
            }

            // 最後の試行でなければ待機
            if attempt < max_retries {
                info!(interval_secs = retry_interval_secs, "リトライ待機");
                tokio::time::sleep(std::time::Duration::from_secs(retry_interval_secs)).await;
            }
        }

        // 全リトライ失敗
        warn!(
            max_retries = max_retries,
            last_error = ?last_error,
            "ヘルスチェック失敗: 最大リトライ回数超過"
        );

        Err(HealthCheckError::MaxRetriesExceeded { max_retries })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ==================== HealthCheckError テスト ====================

    #[test]
    fn test_health_check_error_request_failed_display() {
        let error = HealthCheckError::RequestFailed("connection refused".to_string());
        assert_eq!(error.to_string(), "HTTPリクエスト失敗: connection refused");
    }

    #[test]
    fn test_health_check_error_timeout_display() {
        let error = HealthCheckError::Timeout;
        assert_eq!(error.to_string(), "ヘルスチェックタイムアウト");
    }

    #[test]
    fn test_health_check_error_unhealthy_status_display() {
        let error = HealthCheckError::UnhealthyStatus(503);
        assert_eq!(
            error.to_string(),
            "ヘルスチェック失敗: ステータスコード 503"
        );
    }

    #[test]
    fn test_health_check_error_max_retries_exceeded_display() {
        let error = HealthCheckError::MaxRetriesExceeded { max_retries: 5 };
        assert_eq!(
            error.to_string(),
            "ヘルスチェック失敗: 5回のリトライ後も成功しませんでした"
        );
    }

    // ==================== HealthCheckResult テスト ====================

    #[test]
    fn test_health_check_result_success() {
        let result = HealthCheckResult::success(200, 1, 150);

        assert!(result.healthy);
        assert_eq!(result.status_code, 200);
        assert_eq!(result.attempts, 1);
        assert_eq!(result.total_duration_ms, 150);
    }

    #[test]
    fn test_health_check_result_message() {
        let result = HealthCheckResult::success(200, 3, 5000);
        let message = result.message();

        assert_eq!(message, "sqlite-api healthy (status: 200, attempts: 3)");
    }

    #[test]
    fn test_health_check_result_message_with_different_values() {
        let result = HealthCheckResult::success(204, 1, 100);
        let message = result.message();

        assert_eq!(message, "sqlite-api healthy (status: 204, attempts: 1)");
    }

    // ==================== HttpHealthCheck テスト ====================

    #[test]
    fn test_http_health_check_new() {
        let checker = HttpHealthCheck::new();
        // クライアントが作成されていることを確認（パニックしないこと）
        drop(checker);
    }

    #[test]
    fn test_http_health_check_default() {
        let checker = HttpHealthCheck::default();
        drop(checker);
    }

    #[test]
    fn test_http_health_check_with_custom_client() {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();

        let checker = HttpHealthCheck::with_client(client);
        drop(checker);
    }

    // ==================== ヘルスチェック統合テスト ====================
    // 注意: これらのテストは実際のHTTPサーバーが必要なため、
    // 実環境テストまたはモックサーバーを使用したテストで実行する

    /// モック可能なヘルスチェッカー（テスト用）
    pub struct MockHealthCheck {
        /// 成功を返すかどうか
        pub should_succeed: bool,
        /// 何回目の試行で成功するか（1から始まる）
        pub succeed_on_attempt: Option<u32>,
        /// 返すステータスコード
        pub status_code: u16,
        /// 現在の試行回数
        attempt_count: std::sync::atomic::AtomicU32,
    }

    impl MockHealthCheck {
        /// 常に成功するモックを作成
        pub fn always_success() -> Self {
            Self {
                should_succeed: true,
                succeed_on_attempt: None,
                status_code: 200,
                attempt_count: std::sync::atomic::AtomicU32::new(0),
            }
        }

        /// 常に失敗するモックを作成
        pub fn always_fail() -> Self {
            Self {
                should_succeed: false,
                succeed_on_attempt: None,
                status_code: 503,
                attempt_count: std::sync::atomic::AtomicU32::new(0),
            }
        }

        /// N回目の試行で成功するモックを作成
        pub fn succeed_after(attempts: u32) -> Self {
            Self {
                should_succeed: true,
                succeed_on_attempt: Some(attempts),
                status_code: 200,
                attempt_count: std::sync::atomic::AtomicU32::new(0),
            }
        }
    }

    #[async_trait]
    impl HealthCheckOps for MockHealthCheck {
        async fn check_health_with_retry(
            &self,
            _endpoint: &str,
            max_retries: u32,
            _retry_interval_secs: u64,
        ) -> Result<HealthCheckResult, HealthCheckError> {
            let start_time = std::time::Instant::now();

            for attempt in 1..=max_retries {
                self.attempt_count
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);

                let should_succeed = match self.succeed_on_attempt {
                    Some(n) if attempt >= n => true,
                    Some(_) => false,
                    None => self.should_succeed,
                };

                if should_succeed {
                    let total_duration_ms = start_time.elapsed().as_millis() as u64;
                    return Ok(HealthCheckResult::success(
                        self.status_code,
                        attempt,
                        total_duration_ms,
                    ));
                }

                // モックでは待機しない
            }

            Err(HealthCheckError::MaxRetriesExceeded { max_retries })
        }
    }

    #[tokio::test]
    async fn test_mock_health_check_always_success() {
        let mock = MockHealthCheck::always_success();
        let result = mock
            .check_health_with_retry("https://example.com", 5, 1)
            .await;

        assert!(result.is_ok());
        let result = result.unwrap();
        assert!(result.healthy);
        assert_eq!(result.status_code, 200);
        assert_eq!(result.attempts, 1);
    }

    #[tokio::test]
    async fn test_mock_health_check_always_fail() {
        let mock = MockHealthCheck::always_fail();
        let result = mock
            .check_health_with_retry("https://example.com", 5, 1)
            .await;

        assert!(result.is_err());
        match result.unwrap_err() {
            HealthCheckError::MaxRetriesExceeded { max_retries } => {
                assert_eq!(max_retries, 5);
            }
            _ => panic!("Expected MaxRetriesExceeded error"),
        }
    }

    #[tokio::test]
    async fn test_mock_health_check_succeed_after_3_attempts() {
        let mock = MockHealthCheck::succeed_after(3);
        let result = mock
            .check_health_with_retry("https://example.com", 5, 1)
            .await;

        assert!(result.is_ok());
        let result = result.unwrap();
        assert!(result.healthy);
        assert_eq!(result.attempts, 3);
    }

    #[tokio::test]
    async fn test_mock_health_check_exceed_max_retries() {
        let mock = MockHealthCheck::succeed_after(10);
        let result = mock
            .check_health_with_retry("https://example.com", 5, 1)
            .await;

        assert!(result.is_err());
        match result.unwrap_err() {
            HealthCheckError::MaxRetriesExceeded { max_retries } => {
                assert_eq!(max_retries, 5);
            }
            _ => panic!("Expected MaxRetriesExceeded error"),
        }
    }
}
