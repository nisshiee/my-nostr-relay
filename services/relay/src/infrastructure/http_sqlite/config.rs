// HTTP SQLiteイベントリポジトリ設定
//
// EC2 HTTP APIサーバーへの接続設定を管理
// 要件: 5.1, 5.5
//
// Task 3.6: 環境変数名の統一とSSMからのトークン取得
// - SQLITE_API_ENDPOINT: EC2 HTTP APIサーバーのエンドポイントURL
// - SQLITE_API_TOKEN_PARAM: Parameter Storeのパラメータパス

use aws_sdk_ssm::Client as SsmClient;
use thiserror::Error;
use tracing::{debug, info};

/// HTTP SQLite設定エラー
#[derive(Debug, Error)]
pub enum HttpSqliteConfigError {
    /// 必須の環境変数が設定されていない
    #[error("必須の環境変数が設定されていません: {0}")]
    MissingEnvVar(String),

    /// SSMパラメータの取得に失敗
    #[error("SSMパラメータの取得に失敗: {0}")]
    SsmError(String),
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

    /// 環境変数から設定を読み込み（同期版、テスト用）
    ///
    /// # 環境変数
    /// - `SQLITE_API_ENDPOINT`: EC2 HTTP APIサーバーのベースURL（必須）
    /// - `SQLITE_API_TOKEN`: APIトークン（必須、テスト用）
    ///
    /// # 戻り値
    /// - `Ok(HttpSqliteConfig)`: 設定が正常に読み込まれた
    /// - `Err(HttpSqliteConfigError)`: 必須の環境変数が設定されていない
    ///
    /// # 注意
    /// 本番環境では`from_env_with_ssm()`を使用してください。
    /// この関数はテストと後方互換性のために維持しています。
    pub fn from_env() -> Result<Self, HttpSqliteConfigError> {
        let endpoint = std::env::var("SQLITE_API_ENDPOINT")
            .map_err(|_| HttpSqliteConfigError::MissingEnvVar("SQLITE_API_ENDPOINT".to_string()))?;

        let api_token = std::env::var("SQLITE_API_TOKEN")
            .map_err(|_| HttpSqliteConfigError::MissingEnvVar("SQLITE_API_TOKEN".to_string()))?;

        Ok(Self { endpoint, api_token })
    }

    /// 環境変数とSSM Parameter Storeから設定を読み込み
    ///
    /// # 環境変数
    /// - `SQLITE_API_ENDPOINT`: EC2 HTTP APIサーバーのベースURL（必須）
    /// - `SQLITE_API_TOKEN_PARAM`: Parameter Storeのパラメータパス（必須）
    ///
    /// # 戻り値
    /// - `Ok(HttpSqliteConfig)`: 設定が正常に読み込まれた
    /// - `Err(HttpSqliteConfigError)`: 設定の読み込みに失敗
    ///
    /// # Task 3.6
    /// Lambda初期化時にParameter StoreからSecureStringを復号化して取得
    pub async fn from_env_with_ssm() -> Result<Self, HttpSqliteConfigError> {
        // エンドポイントURLを環境変数から取得
        let endpoint = std::env::var("SQLITE_API_ENDPOINT")
            .map_err(|_| HttpSqliteConfigError::MissingEnvVar("SQLITE_API_ENDPOINT".to_string()))?;

        // SSMパラメータパスを環境変数から取得
        let token_param_path = std::env::var("SQLITE_API_TOKEN_PARAM")
            .map_err(|_| HttpSqliteConfigError::MissingEnvVar("SQLITE_API_TOKEN_PARAM".to_string()))?;

        debug!(
            endpoint = %endpoint,
            token_param_path = %token_param_path,
            "SSMからAPIトークンを取得"
        );

        // AWS設定を読み込み
        let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
        let ssm_client = SsmClient::new(&aws_config);

        // SSMからSecureStringパラメータを取得
        let api_token = Self::get_ssm_parameter(&ssm_client, &token_param_path).await?;

        info!(
            endpoint = %endpoint,
            "HttpSqliteConfig初期化完了（トークンはSSMから取得）"
        );

        Ok(Self { endpoint, api_token })
    }

    /// 既存のSSMクライアントを使用して設定を読み込み
    ///
    /// # 引数
    /// - `ssm_client`: SSMクライアント
    ///
    /// # 戻り値
    /// - `Ok(HttpSqliteConfig)`: 設定が正常に読み込まれた
    /// - `Err(HttpSqliteConfigError)`: 設定の読み込みに失敗
    ///
    /// # 用途
    /// テストや再利用可能なSSMクライアントを使用する場合
    pub async fn from_env_with_ssm_client(ssm_client: &SsmClient) -> Result<Self, HttpSqliteConfigError> {
        // エンドポイントURLを環境変数から取得
        let endpoint = std::env::var("SQLITE_API_ENDPOINT")
            .map_err(|_| HttpSqliteConfigError::MissingEnvVar("SQLITE_API_ENDPOINT".to_string()))?;

        // SSMパラメータパスを環境変数から取得
        let token_param_path = std::env::var("SQLITE_API_TOKEN_PARAM")
            .map_err(|_| HttpSqliteConfigError::MissingEnvVar("SQLITE_API_TOKEN_PARAM".to_string()))?;

        debug!(
            endpoint = %endpoint,
            token_param_path = %token_param_path,
            "SSMからAPIトークンを取得"
        );

        // SSMからSecureStringパラメータを取得
        let api_token = Self::get_ssm_parameter(ssm_client, &token_param_path).await?;

        info!(
            endpoint = %endpoint,
            "HttpSqliteConfig初期化完了（トークンはSSMから取得）"
        );

        Ok(Self { endpoint, api_token })
    }

    /// SSM Parameter Storeからパラメータ値を取得
    ///
    /// # 引数
    /// - `client`: SSMクライアント
    /// - `parameter_name`: パラメータ名（パス）
    ///
    /// # 戻り値
    /// - `Ok(String)`: パラメータ値
    /// - `Err(HttpSqliteConfigError)`: 取得に失敗
    async fn get_ssm_parameter(
        client: &SsmClient,
        parameter_name: &str,
    ) -> Result<String, HttpSqliteConfigError> {
        let result = client
            .get_parameter()
            .name(parameter_name)
            .with_decryption(true) // SecureStringを復号化
            .send()
            .await
            .map_err(|e| {
                HttpSqliteConfigError::SsmError(format!(
                    "パラメータ '{}' の取得に失敗: {}",
                    parameter_name, e
                ))
            })?;

        let parameter = result.parameter.ok_or_else(|| {
            HttpSqliteConfigError::SsmError(format!(
                "パラメータ '{}' が存在しません",
                parameter_name
            ))
        })?;

        parameter.value.ok_or_else(|| {
            HttpSqliteConfigError::SsmError(format!(
                "パラメータ '{}' に値がありません",
                parameter_name
            ))
        })
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

    // Task 3.6: 新しい環境変数名(SQLITE_API_*)を使用するテスト

    #[test]
    #[serial]
    fn test_from_env_success() {
        // 環境変数を設定 (Rust 2024ではunsafe)
        unsafe {
            std::env::set_var("SQLITE_API_ENDPOINT", "https://test.example.com");
            std::env::set_var("SQLITE_API_TOKEN", "test-api-token");
        }

        let config = HttpSqliteConfig::from_env().expect("設定の読み込みに失敗");

        assert_eq!(config.endpoint(), "https://test.example.com");
        assert_eq!(config.api_token(), "test-api-token");

        // クリーンアップ
        unsafe {
            std::env::remove_var("SQLITE_API_ENDPOINT");
            std::env::remove_var("SQLITE_API_TOKEN");
        }
    }

    #[test]
    #[serial]
    fn test_from_env_missing_endpoint() {
        // SQLITE_API_ENDPOINTを削除
        unsafe {
            std::env::remove_var("SQLITE_API_ENDPOINT");
            std::env::set_var("SQLITE_API_TOKEN", "token");
        }

        let result = HttpSqliteConfig::from_env();

        assert!(result.is_err());
        match result.unwrap_err() {
            HttpSqliteConfigError::MissingEnvVar(var) => {
                assert_eq!(var, "SQLITE_API_ENDPOINT");
            }
            _ => panic!("予期しないエラー型"),
        }

        // クリーンアップ
        unsafe {
            std::env::remove_var("SQLITE_API_TOKEN");
        }
    }

    #[test]
    #[serial]
    fn test_from_env_missing_token() {
        // SQLITE_API_TOKENを削除
        unsafe {
            std::env::set_var("SQLITE_API_ENDPOINT", "https://example.com");
            std::env::remove_var("SQLITE_API_TOKEN");
        }

        let result = HttpSqliteConfig::from_env();

        assert!(result.is_err());
        match result.unwrap_err() {
            HttpSqliteConfigError::MissingEnvVar(var) => {
                assert_eq!(var, "SQLITE_API_TOKEN");
            }
            _ => panic!("予期しないエラー型"),
        }

        // クリーンアップ
        unsafe {
            std::env::remove_var("SQLITE_API_ENDPOINT");
        }
    }

    // ==================== SSM関連テスト ====================

    #[test]
    #[serial]
    fn test_from_env_with_ssm_missing_endpoint() {
        // SQLITE_API_ENDPOINTを削除、他は設定
        unsafe {
            std::env::remove_var("SQLITE_API_ENDPOINT");
            std::env::set_var("SQLITE_API_TOKEN_PARAM", "/nostr/api-token");
        }

        // 非同期テストのブロック
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let result = runtime.block_on(HttpSqliteConfig::from_env_with_ssm());

        assert!(result.is_err());
        match result.unwrap_err() {
            HttpSqliteConfigError::MissingEnvVar(var) => {
                assert_eq!(var, "SQLITE_API_ENDPOINT");
            }
            _ => panic!("予期しないエラー型"),
        }

        // クリーンアップ
        unsafe {
            std::env::remove_var("SQLITE_API_TOKEN_PARAM");
        }
    }

    #[test]
    #[serial]
    fn test_from_env_with_ssm_missing_token_param() {
        // SQLITE_API_TOKEN_PARAMを削除
        unsafe {
            std::env::set_var("SQLITE_API_ENDPOINT", "https://example.com");
            std::env::remove_var("SQLITE_API_TOKEN_PARAM");
        }

        let runtime = tokio::runtime::Runtime::new().unwrap();
        let result = runtime.block_on(HttpSqliteConfig::from_env_with_ssm());

        assert!(result.is_err());
        match result.unwrap_err() {
            HttpSqliteConfigError::MissingEnvVar(var) => {
                assert_eq!(var, "SQLITE_API_TOKEN_PARAM");
            }
            _ => panic!("予期しないエラー型"),
        }

        // クリーンアップ
        unsafe {
            std::env::remove_var("SQLITE_API_ENDPOINT");
        }
    }

    // ==================== HttpSqliteConfigError テスト ====================

    #[test]
    fn test_error_display_missing_env_var() {
        let error = HttpSqliteConfigError::MissingEnvVar("TEST_VAR".to_string());
        assert!(error.to_string().contains("TEST_VAR"));
        assert!(error.to_string().contains("環境変数"));
    }

    #[test]
    fn test_error_display_ssm_error() {
        let error = HttpSqliteConfigError::SsmError("接続失敗".to_string());
        assert!(error.to_string().contains("SSM"));
        assert!(error.to_string().contains("接続失敗"));
    }
}
