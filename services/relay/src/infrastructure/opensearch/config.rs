// OpenSearch接続設定
//
// 環境変数からOpenSearchエンドポイントとインデックス名を読み取る。
// AWS Lambda環境でOpenSearch Serviceに接続するための設定を提供。
//
// 要件: 6.4

use thiserror::Error;
use url::Url;

/// OpenSearch設定のエラー型
#[derive(Debug, Error)]
pub enum OpenSearchConfigError {
    /// 環境変数が欠落
    #[error("環境変数が設定されていません: {0}")]
    MissingEnvVar(String),

    /// エンドポイントURLが無効
    #[error("無効なエンドポイントURL: {0}")]
    InvalidEndpoint(String),
}

/// OpenSearch接続設定
///
/// この構造体は環境変数から読み込んだOpenSearch接続設定を保持します。
/// 環境変数:
/// - OPENSEARCH_ENDPOINT: OpenSearchドメインエンドポイントURL
/// - OPENSEARCH_INDEX: インデックス名（デフォルト: nostr_events）
#[derive(Debug, Clone)]
pub struct OpenSearchConfig {
    /// エンドポイントURL
    endpoint: String,
    /// インデックス名
    index_name: String,
}

impl OpenSearchConfig {
    /// デフォルトのインデックス名
    pub const DEFAULT_INDEX_NAME: &'static str = "nostr_events";

    /// 環境変数から設定を読み込む
    ///
    /// # 環境変数
    /// - OPENSEARCH_ENDPOINT: OpenSearchドメインエンドポイントURL（必須）
    /// - OPENSEARCH_INDEX: インデックス名（オプション、デフォルト: nostr_events）
    ///
    /// # エラー
    /// - `MissingEnvVar`: OPENSEARCH_ENDPOINTが設定されていない
    /// - `InvalidEndpoint`: エンドポイントURLが無効
    pub fn from_env() -> Result<Self, OpenSearchConfigError> {
        let endpoint = std::env::var("OPENSEARCH_ENDPOINT")
            .map_err(|_| OpenSearchConfigError::MissingEnvVar("OPENSEARCH_ENDPOINT".to_string()))?;

        // エンドポイントURLのバリデーション
        Self::validate_endpoint(&endpoint)?;

        let index_name = std::env::var("OPENSEARCH_INDEX")
            .unwrap_or_else(|_| Self::DEFAULT_INDEX_NAME.to_string());

        Ok(Self {
            endpoint,
            index_name,
        })
    }

    /// 明示的な値で新しいOpenSearchConfigを作成（テスト用）
    ///
    /// # Arguments
    /// * `endpoint` - OpenSearchドメインエンドポイントURL
    /// * `index_name` - インデックス名
    ///
    /// # エラー
    /// - `InvalidEndpoint`: エンドポイントURLが無効
    pub fn new(endpoint: String, index_name: String) -> Result<Self, OpenSearchConfigError> {
        Self::validate_endpoint(&endpoint)?;
        Ok(Self {
            endpoint,
            index_name,
        })
    }

    /// エンドポイントURLのバリデーション
    fn validate_endpoint(endpoint: &str) -> Result<(), OpenSearchConfigError> {
        // URLとして有効かチェック
        Url::parse(endpoint)
            .map_err(|e| OpenSearchConfigError::InvalidEndpoint(format!("{}: {}", endpoint, e)))?;

        // HTTPSスキームであることを確認
        let url = Url::parse(endpoint).unwrap();
        if url.scheme() != "https" && url.scheme() != "http" {
            return Err(OpenSearchConfigError::InvalidEndpoint(format!(
                "{}: スキームはhttpまたはhttpsである必要があります",
                endpoint
            )));
        }

        Ok(())
    }

    /// エンドポイントURLを取得
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// インデックス名を取得
    pub fn index_name(&self) -> &str {
        &self.index_name
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // テストで環境変数を安全に設定/削除するヘルパー
    // 安全性: テスト環境でのみ使用
    unsafe fn set_env(key: &str, value: &str) {
        unsafe { std::env::set_var(key, value) };
    }

    unsafe fn remove_env(key: &str) {
        unsafe { std::env::remove_var(key) };
    }

    #[test]
    fn test_new_with_valid_endpoint() {
        let config = OpenSearchConfig::new(
            "https://search-example.us-east-1.es.amazonaws.com".to_string(),
            "test_index".to_string(),
        )
        .expect("設定の作成に失敗");

        assert_eq!(
            config.endpoint(),
            "https://search-example.us-east-1.es.amazonaws.com"
        );
        assert_eq!(config.index_name(), "test_index");
    }

    #[test]
    fn test_new_with_invalid_endpoint() {
        let result = OpenSearchConfig::new(
            "not-a-valid-url".to_string(),
            "test_index".to_string(),
        );

        assert!(result.is_err());
        match result.unwrap_err() {
            OpenSearchConfigError::InvalidEndpoint(_) => {}
            other => panic!("予期しないエラー型: {:?}", other),
        }
    }

    #[test]
    fn test_error_display_missing_env_var() {
        let error = OpenSearchConfigError::MissingEnvVar("TEST_VAR".to_string());
        assert_eq!(error.to_string(), "環境変数が設定されていません: TEST_VAR");
    }

    #[test]
    fn test_error_display_invalid_endpoint() {
        let error = OpenSearchConfigError::InvalidEndpoint("invalid-url: 理由".to_string());
        assert_eq!(error.to_string(), "無効なエンドポイントURL: invalid-url: 理由");
    }

    #[test]
    fn test_default_index_name() {
        assert_eq!(OpenSearchConfig::DEFAULT_INDEX_NAME, "nostr_events");
    }

    // 環境変数テスト（serial_testは使用せず、独自の環境変数名を使用）
    #[test]
    fn test_from_env_scenarios() {
        const ENDPOINT_VAR: &str = "TEST_OPENSEARCH_ENDPOINT";
        const INDEX_VAR: &str = "TEST_OPENSEARCH_INDEX";

        // テスト専用の環境変数から設定を作成するヘルパー
        fn from_test_env() -> Result<OpenSearchConfig, OpenSearchConfigError> {
            let endpoint = std::env::var(ENDPOINT_VAR)
                .map_err(|_| OpenSearchConfigError::MissingEnvVar("OPENSEARCH_ENDPOINT".to_string()))?;

            OpenSearchConfig::validate_endpoint(&endpoint)?;

            let index_name = std::env::var(INDEX_VAR)
                .unwrap_or_else(|_| OpenSearchConfig::DEFAULT_INDEX_NAME.to_string());

            Ok(OpenSearchConfig {
                endpoint,
                index_name,
            })
        }

        // クリーンアップヘルパー
        unsafe fn cleanup() {
            unsafe {
                remove_env(ENDPOINT_VAR);
                remove_env(INDEX_VAR);
            }
        }

        // --- テスト1: エンドポイントが欠落 ---
        unsafe {
            cleanup();
            set_env(INDEX_VAR, "custom_index");
        }

        let result = from_test_env();
        assert!(result.is_err());
        match result.unwrap_err() {
            OpenSearchConfigError::MissingEnvVar(var) => {
                assert_eq!(var, "OPENSEARCH_ENDPOINT");
            }
            other => panic!("予期しないエラー型: {:?}", other),
        }

        // --- テスト2: インデックス名が欠落（デフォルト値を使用） ---
        unsafe {
            cleanup();
            set_env(ENDPOINT_VAR, "https://search-example.us-east-1.es.amazonaws.com");
        }

        let result = from_test_env();
        assert!(result.is_ok());
        let config = result.unwrap();
        assert_eq!(
            config.endpoint(),
            "https://search-example.us-east-1.es.amazonaws.com"
        );
        assert_eq!(config.index_name(), "nostr_events"); // デフォルト値

        // --- テスト3: 両方設定されている ---
        unsafe {
            cleanup();
            set_env(ENDPOINT_VAR, "https://custom-search.us-west-2.es.amazonaws.com");
            set_env(INDEX_VAR, "my_custom_index");
        }

        let result = from_test_env();
        assert!(result.is_ok());
        let config = result.unwrap();
        assert_eq!(
            config.endpoint(),
            "https://custom-search.us-west-2.es.amazonaws.com"
        );
        assert_eq!(config.index_name(), "my_custom_index");

        // --- テスト4: 無効なエンドポイント ---
        unsafe {
            cleanup();
            set_env(ENDPOINT_VAR, "not-valid-url");
        }

        let result = from_test_env();
        assert!(result.is_err());
        match result.unwrap_err() {
            OpenSearchConfigError::InvalidEndpoint(_) => {}
            other => panic!("予期しないエラー型: {:?}", other),
        }

        // 最終クリーンアップ
        unsafe {
            cleanup();
        }
    }

    #[test]
    fn test_validate_endpoint_with_http() {
        // HTTPも許可（開発環境用）
        let config = OpenSearchConfig::new(
            "http://localhost:9200".to_string(),
            "test_index".to_string(),
        );
        assert!(config.is_ok());
    }

    #[test]
    fn test_validate_endpoint_with_port() {
        let config = OpenSearchConfig::new(
            "https://search-example.us-east-1.es.amazonaws.com:443".to_string(),
            "test_index".to_string(),
        );
        assert!(config.is_ok());
    }
}
