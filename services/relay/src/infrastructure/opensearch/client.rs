// OpenSearchクライアント
//
// AWS SigV4認証を使用してOpenSearch Serviceに接続するクライアント。
// Lambda実行環境のIAMロールを使用して自動的に認証する。
//
// 要件: 6.1, 6.2, 6.3, 6.5

use super::config::OpenSearchConfig;
use opensearch::http::transport::{SingleNodeConnectionPool, TransportBuilder};
use opensearch::OpenSearch;
use thiserror::Error;
use tracing::{error, info};
use url::Url;

/// OpenSearchクライアントエラー
#[derive(Debug, Error)]
pub enum OpenSearchClientError {
    /// エンドポイントURLのパースに失敗
    #[error("エンドポイントURLのパースに失敗: {0}")]
    UrlParseError(#[from] url::ParseError),

    /// トランスポート構築に失敗
    #[error("トランスポート構築に失敗: {0}")]
    TransportBuildError(String),

    /// AWS認証エラー
    #[error("AWS認証エラー: {0}")]
    AwsAuthError(String),
}

/// OpenSearchクライアント
///
/// AWS SigV4認証を使用してOpenSearch Serviceに接続するクライアント。
/// コネクションプーリングを活用して接続を再利用する。
///
/// # 要件
/// - 6.1: AWS SigV4認証を使用
/// - 6.2: Lambda実行環境のIAMロールを使用して認証
/// - 6.3: コネクションプーリングを活用して接続を再利用
/// - 6.5: 接続失敗時のエラーログ記録
#[derive(Debug, Clone)]
pub struct OpenSearchClient {
    /// OpenSearchクライアントインスタンス
    client: OpenSearch,
    /// インデックス名
    index_name: String,
}

impl OpenSearchClient {
    /// 設定からOpenSearchクライアントを作成
    ///
    /// AWS SigV4認証を使用してOpenSearch Serviceに接続するクライアントを初期化する。
    /// aws-configからAWS認証情報を自動的に取得する（Lambda環境ではIAMロールを使用）。
    ///
    /// # Arguments
    /// * `config` - OpenSearch接続設定
    ///
    /// # Returns
    /// * `Ok(OpenSearchClient)` - 初期化されたクライアント
    /// * `Err(OpenSearchClientError)` - 初期化に失敗
    ///
    /// # 要件
    /// - 6.1: AWS SigV4認証を使用
    /// - 6.2: Lambda実行環境のIAMロールを使用
    /// - 6.3: SingleNodeConnectionPoolでコネクションプーリング
    pub async fn new(config: &OpenSearchConfig) -> Result<Self, OpenSearchClientError> {
        info!(
            endpoint = config.endpoint(),
            index_name = config.index_name(),
            "OpenSearchクライアントを初期化中"
        );

        // エンドポイントURLをパース
        let url = Url::parse(config.endpoint())?;

        // シングルノード接続プール（要件 6.3）
        let conn_pool = SingleNodeConnectionPool::new(url);

        // AWS設定を読み込み（Lambda環境ではIAMロールから自動取得）（要件 6.2）
        let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;

        // AWS SigV4認証付きトランスポートを構築（要件 6.1）
        let transport = TransportBuilder::new(conn_pool)
            .auth(
                aws_config
                    .clone()
                    .try_into()
                    .map_err(|e| OpenSearchClientError::AwsAuthError(format!("{:?}", e)))?,
            )
            .service_name("es")
            .build()
            .map_err(|e| {
                // 要件 6.5: 接続失敗時のエラーログ記録
                error!(error = %e, "OpenSearchトランスポート構築に失敗");
                OpenSearchClientError::TransportBuildError(e.to_string())
            })?;

        let client = OpenSearch::new(transport);

        info!(
            endpoint = config.endpoint(),
            index_name = config.index_name(),
            "OpenSearchクライアントの初期化が完了"
        );

        Ok(Self {
            client,
            index_name: config.index_name().to_string(),
        })
    }

    /// 内部OpenSearchクライアントへの参照を取得
    ///
    /// クエリ実行やインデックス操作に使用する。
    pub fn client(&self) -> &OpenSearch {
        &self.client
    }

    /// インデックス名を取得
    pub fn index_name(&self) -> &str {
        &self.index_name
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // テストで環境変数を安全に削除するヘルパー
    // 安全性: テスト環境でのみ使用
    unsafe fn remove_env(key: &str) {
        unsafe { std::env::remove_var(key) };
    }

    #[test]
    fn test_error_display_url_parse() {
        let error = OpenSearchClientError::UrlParseError(
            url::Url::parse("not-a-url").unwrap_err()
        );
        assert!(error.to_string().contains("エンドポイントURLのパースに失敗"));
    }

    #[test]
    fn test_error_display_transport_build() {
        let error = OpenSearchClientError::TransportBuildError("接続エラー".to_string());
        assert!(error.to_string().contains("トランスポート構築に失敗"));
    }

    #[test]
    fn test_error_display_aws_auth() {
        let error = OpenSearchClientError::AwsAuthError("認証エラー".to_string());
        assert!(error.to_string().contains("AWS認証エラー"));
    }

    // 注意: OpenSearchClient::new()の完全なテストは統合テストで行う
    // （実際のAWS認証とOpenSearch接続が必要なため）
    // ローカル環境ではAWS認証情報がないためIMDSタイムアウトが発生する

    #[tokio::test]
    #[ignore = "AWS認証情報が必要なため統合テストで実行"]
    async fn test_client_new_with_valid_config() {
        // AWS認証情報がなくてもクライアントは作成される
        // （実際の接続時に認証が行われる）
        const ENDPOINT_VAR: &str = "TEST_OS_CLIENT_ENDPOINT";
        const INDEX_VAR: &str = "TEST_OS_CLIENT_INDEX";

        unsafe fn cleanup() {
            unsafe {
                remove_env(ENDPOINT_VAR);
                remove_env(INDEX_VAR);
            }
        }

        // テスト前のクリーンアップ
        unsafe { cleanup() };

        // 有効な設定でクライアントを作成
        let config = OpenSearchConfig::new(
            "https://search-test.us-east-1.es.amazonaws.com".to_string(),
            "test_index".to_string(),
        )
        .expect("設定の作成に失敗");

        let result = OpenSearchClient::new(&config).await;

        // クライアント作成自体は成功する（実際の接続は行わない）
        assert!(result.is_ok());

        let client = result.unwrap();
        assert_eq!(client.index_name(), "test_index");

        // クリーンアップ
        unsafe { cleanup() };
    }

    #[tokio::test]
    #[ignore = "AWS認証情報が必要なため統合テストで実行"]
    async fn test_client_index_name_accessor() {
        let config = OpenSearchConfig::new(
            "https://search-test.us-east-1.es.amazonaws.com".to_string(),
            "my_custom_index".to_string(),
        )
        .expect("設定の作成に失敗");

        let client = OpenSearchClient::new(&config)
            .await
            .expect("クライアント作成に失敗");

        assert_eq!(client.index_name(), "my_custom_index");
    }

    #[tokio::test]
    #[ignore = "AWS認証情報が必要なため統合テストで実行"]
    async fn test_client_accessor() {
        let config = OpenSearchConfig::new(
            "https://search-test.us-east-1.es.amazonaws.com".to_string(),
            "test_index".to_string(),
        )
        .expect("設定の作成に失敗");

        let os_client = OpenSearchClient::new(&config)
            .await
            .expect("クライアント作成に失敗");

        // client()メソッドがOpenSearchへの参照を返すことを確認
        let _inner_client: &OpenSearch = os_client.client();
    }
}
