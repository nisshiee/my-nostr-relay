// HTTP SQLiteイベントリポジトリ設定
//
// EC2 HTTP APIサーバーへの接続設定を管理
// 要件: 5.1, 5.5

use thiserror::Error;

/// HTTP SQLite設定エラー
#[derive(Debug, Error)]
pub enum HttpSqliteConfigError {
    /// 必須の環境変数が設定されていない
    #[error("必須の環境変数が設定されていません: {0}")]
    MissingEnvVar(String),
}

/// HTTP SQLiteイベントリポジトリの設定
///
/// # フィールド
/// - `endpoint`: EC2 HTTP APIサーバーのベースURL (例: "https://xxx.relay.nostr.nisshiee.org")
/// - `api_token`: APIトークン（Authorizationヘッダーに使用）
///
/// # 要件
/// - 5.1: EC2エンドポイントへのHTTPS通信
/// - 5.5: Authorizationヘッダーにトークンを付与
#[derive(Debug, Clone)]
pub struct HttpSqliteConfig {
    endpoint: String,
    api_token: String,
}

impl HttpSqliteConfig {
    /// 新しい設定を作成
    ///
    /// # 引数
    /// - `endpoint`: EC2 HTTP APIサーバーのベースURL
    /// - `api_token`: APIトークン
    pub fn new(endpoint: impl Into<String>, api_token: impl Into<String>) -> Self {
        Self {
            endpoint: endpoint.into(),
            api_token: api_token.into(),
        }
    }

    /// 環境変数から設定を読み込み
    ///
    /// # 環境変数
    /// - `HTTP_SQLITE_ENDPOINT`: EC2 HTTP APIサーバーのベースURL（必須）
    /// - `HTTP_SQLITE_API_TOKEN`: APIトークン（必須）
    ///
    /// # 戻り値
    /// - `Ok(HttpSqliteConfig)`: 設定が正常に読み込まれた
    /// - `Err(HttpSqliteConfigError)`: 必須の環境変数が設定されていない
    pub fn from_env() -> Result<Self, HttpSqliteConfigError> {
        let endpoint = std::env::var("HTTP_SQLITE_ENDPOINT")
            .map_err(|_| HttpSqliteConfigError::MissingEnvVar("HTTP_SQLITE_ENDPOINT".to_string()))?;

        let api_token = std::env::var("HTTP_SQLITE_API_TOKEN")
            .map_err(|_| HttpSqliteConfigError::MissingEnvVar("HTTP_SQLITE_API_TOKEN".to_string()))?;

        Ok(Self { endpoint, api_token })
    }

    /// エンドポイントURLを取得
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// APIトークンを取得
    pub fn api_token(&self) -> &str {
        &self.api_token
    }

    /// 検索エンドポイントURLを構築
    ///
    /// # 戻り値
    /// 検索エンドポイントの完全なURL (例: "https://xxx.relay.nostr.nisshiee.org/events/search")
    pub fn search_url(&self) -> String {
        format!("{}/events/search", self.endpoint.trim_end_matches('/'))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    // ==================== HttpSqliteConfig テスト ====================

    #[test]
    fn test_new_creates_config() {
        let config = HttpSqliteConfig::new("https://example.com", "test-token");

        assert_eq!(config.endpoint(), "https://example.com");
        assert_eq!(config.api_token(), "test-token");
    }

    #[test]
    fn test_search_url_without_trailing_slash() {
        let config = HttpSqliteConfig::new("https://example.com", "token");

        assert_eq!(config.search_url(), "https://example.com/events/search");
    }

    #[test]
    fn test_search_url_with_trailing_slash() {
        let config = HttpSqliteConfig::new("https://example.com/", "token");

        assert_eq!(config.search_url(), "https://example.com/events/search");
    }

    #[test]
    #[serial]
    fn test_from_env_success() {
        // 環境変数を設定 (Rust 2024ではunsafe)
        unsafe {
            std::env::set_var("HTTP_SQLITE_ENDPOINT", "https://test.example.com");
            std::env::set_var("HTTP_SQLITE_API_TOKEN", "test-api-token");
        }

        let config = HttpSqliteConfig::from_env().expect("設定の読み込みに失敗");

        assert_eq!(config.endpoint(), "https://test.example.com");
        assert_eq!(config.api_token(), "test-api-token");

        // クリーンアップ
        unsafe {
            std::env::remove_var("HTTP_SQLITE_ENDPOINT");
            std::env::remove_var("HTTP_SQLITE_API_TOKEN");
        }
    }

    #[test]
    #[serial]
    fn test_from_env_missing_endpoint() {
        // HTTP_SQLITE_ENDPOINTを削除
        unsafe {
            std::env::remove_var("HTTP_SQLITE_ENDPOINT");
            std::env::set_var("HTTP_SQLITE_API_TOKEN", "token");
        }

        let result = HttpSqliteConfig::from_env();

        assert!(result.is_err());
        match result.unwrap_err() {
            HttpSqliteConfigError::MissingEnvVar(var) => {
                assert_eq!(var, "HTTP_SQLITE_ENDPOINT");
            }
        }

        // クリーンアップ
        unsafe {
            std::env::remove_var("HTTP_SQLITE_API_TOKEN");
        }
    }

    #[test]
    #[serial]
    fn test_from_env_missing_token() {
        // HTTP_SQLITE_API_TOKENを削除
        unsafe {
            std::env::set_var("HTTP_SQLITE_ENDPOINT", "https://example.com");
            std::env::remove_var("HTTP_SQLITE_API_TOKEN");
        }

        let result = HttpSqliteConfig::from_env();

        assert!(result.is_err());
        match result.unwrap_err() {
            HttpSqliteConfigError::MissingEnvVar(var) => {
                assert_eq!(var, "HTTP_SQLITE_API_TOKEN");
            }
        }

        // クリーンアップ
        unsafe {
            std::env::remove_var("HTTP_SQLITE_ENDPOINT");
        }
    }

    // ==================== HttpSqliteConfigError テスト ====================

    #[test]
    fn test_error_display() {
        let error = HttpSqliteConfigError::MissingEnvVar("TEST_VAR".to_string());
        assert!(error.to_string().contains("TEST_VAR"));
        assert!(error.to_string().contains("環境変数"));
    }
}
