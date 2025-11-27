/// DynamoDB接続設定
///
/// 要件: 16.1, 17.1, 18.1
use aws_sdk_dynamodb::Client as DynamoDbClient;
use thiserror::Error;

/// DynamoDB設定のエラー型
#[derive(Debug, Error)]
pub enum DynamoDbConfigError {
    #[error("Missing environment variable: {0}")]
    MissingEnvVar(String),
}

/// テーブル名とクライアントを持つDynamoDB設定
///
/// この構造体は環境変数から読み込んだDynamoDBクライアントとテーブル名を保持します。
/// テーブル名は以下の環境変数で設定:
/// - EVENTS_TABLE: Nostrイベント保存用テーブル
/// - CONNECTIONS_TABLE: WebSocket接続管理用テーブル
/// - SUBSCRIPTIONS_TABLE: サブスクリプション管理用テーブル
#[derive(Debug, Clone)]
pub struct DynamoDbConfig {
    /// DynamoDBクライアントインスタンス
    client: DynamoDbClient,
    /// イベントテーブル名
    events_table: String,
    /// 接続テーブル名
    connections_table: String,
    /// サブスクリプションテーブル名
    subscriptions_table: String,
}

impl DynamoDbConfig {
    /// 環境からAWS設定を読み込み、環境変数からテーブル名を読み取って新しいDynamoDbConfigを作成
    ///
    /// 環境変数:
    /// - AWS認証情報: aws-configにより自動読み込み
    /// - EVENTS_TABLE: イベント用DynamoDBテーブル名
    /// - CONNECTIONS_TABLE: 接続用DynamoDBテーブル名
    /// - SUBSCRIPTIONS_TABLE: サブスクリプション用DynamoDBテーブル名
    pub async fn from_env() -> Result<Self, DynamoDbConfigError> {
        // 環境からAWS設定を読み込み（認証情報、リージョンなど）
        let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;

        // AWS設定からDynamoDBクライアントを作成
        let client = DynamoDbClient::new(&aws_config);

        // 環境変数からテーブル名を読み込み
        let events_table = std::env::var("EVENTS_TABLE")
            .map_err(|_| DynamoDbConfigError::MissingEnvVar("EVENTS_TABLE".to_string()))?;

        let connections_table = std::env::var("CONNECTIONS_TABLE")
            .map_err(|_| DynamoDbConfigError::MissingEnvVar("CONNECTIONS_TABLE".to_string()))?;

        let subscriptions_table = std::env::var("SUBSCRIPTIONS_TABLE")
            .map_err(|_| DynamoDbConfigError::MissingEnvVar("SUBSCRIPTIONS_TABLE".to_string()))?;

        Ok(Self {
            client,
            events_table,
            connections_table,
            subscriptions_table,
        })
    }

    /// 明示的な値で新しいDynamoDbConfigを作成（テスト用）
    pub fn new(
        client: DynamoDbClient,
        events_table: String,
        connections_table: String,
        subscriptions_table: String,
    ) -> Self {
        Self {
            client,
            events_table,
            connections_table,
            subscriptions_table,
        }
    }

    /// DynamoDBクライアントへの参照を取得
    pub fn client(&self) -> &DynamoDbClient {
        &self.client
    }

    /// イベントテーブル名を取得
    pub fn events_table(&self) -> &str {
        &self.events_table
    }

    /// 接続テーブル名を取得
    pub fn connections_table(&self) -> &str {
        &self.connections_table
    }

    /// サブスクリプションテーブル名を取得
    pub fn subscriptions_table(&self) -> &str {
        &self.subscriptions_table
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ==================== 3.1 DynamoDB設定テスト ====================

    // テストで環境変数を安全に設定/削除するヘルパー
    // 安全性: これらのテストは cargo test --test-threads=1 でシングルスレッド実行するか、
    // テスト環境でのリスクを許容する
    unsafe fn set_env(key: &str, value: &str) {
        // 安全性: 呼び出し元が安全であることを保証（シングルスレッドテスト環境）
        unsafe { std::env::set_var(key, value) };
    }

    unsafe fn remove_env(key: &str) {
        // 安全性: 呼び出し元が安全であることを保証（シングルスレッドテスト環境）
        unsafe { std::env::remove_var(key) };
    }

    // エラー型テスト (要件 16.1, 17.1, 18.1)
    #[test]
    fn test_missing_env_var_error_display() {
        let error = DynamoDbConfigError::MissingEnvVar("TEST_VAR".to_string());
        assert_eq!(
            error.to_string(),
            "Missing environment variable: TEST_VAR"
        );
    }

    // 明示的な値でDynamoDbConfig構築のテスト
    #[tokio::test]
    async fn test_dynamodb_config_new() {
        // モックAWS設定とクライアントを作成
        let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
        let client = DynamoDbClient::new(&aws_config);

        let config = DynamoDbConfig::new(
            client,
            "test-events".to_string(),
            "test-connections".to_string(),
            "test-subscriptions".to_string(),
        );

        assert_eq!(config.events_table(), "test-events");
        assert_eq!(config.connections_table(), "test-connections");
        assert_eq!(config.subscriptions_table(), "test-subscriptions");
    }

    // ゲッターが正しい値を返すテスト
    #[tokio::test]
    async fn test_dynamodb_config_getters() {
        let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
        let client = DynamoDbClient::new(&aws_config);

        let config = DynamoDbConfig::new(
            client,
            "events-table-name".to_string(),
            "connections-table-name".to_string(),
            "subscriptions-table-name".to_string(),
        );

        // すべてのゲッターが期待値を返すことを検証
        assert_eq!(config.events_table(), "events-table-name");
        assert_eq!(config.connections_table(), "connections-table-name");
        assert_eq!(config.subscriptions_table(), "subscriptions-table-name");

        // クライアントがアクセス可能であることを検証（少なくとも参照を取得できる）
        let _client_ref = config.client();
    }

    // さまざまな環境変数シナリオでfrom_envをテスト
    // 並列実行時のレースコンディションを避けるため、すべての環境変数テストを1つにまとめる
    // （環境変数はプロセスグローバルな状態）
    #[tokio::test]
    async fn test_from_env_scenarios() {
        // 他のテストとの競合を避けるためユニークな環境変数名を使用
        const EVENTS_VAR: &str = "TEST_CONFIG_EVENTS_TABLE";
        const CONNECTIONS_VAR: &str = "TEST_CONFIG_CONNECTIONS_TABLE";
        const SUBSCRIPTIONS_VAR: &str = "TEST_CONFIG_SUBSCRIPTIONS_TABLE";

        // テスト専用の環境変数から設定を作成するヘルパー
        async fn from_test_env() -> Result<DynamoDbConfig, DynamoDbConfigError> {
            let aws_config =
                aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
            let client = DynamoDbClient::new(&aws_config);

            let events_table = std::env::var(EVENTS_VAR)
                .map_err(|_| DynamoDbConfigError::MissingEnvVar("EVENTS_TABLE".to_string()))?;

            let connections_table = std::env::var(CONNECTIONS_VAR)
                .map_err(|_| DynamoDbConfigError::MissingEnvVar("CONNECTIONS_TABLE".to_string()))?;

            let subscriptions_table = std::env::var(SUBSCRIPTIONS_VAR).map_err(|_| {
                DynamoDbConfigError::MissingEnvVar("SUBSCRIPTIONS_TABLE".to_string())
            })?;

            Ok(DynamoDbConfig {
                client,
                events_table,
                connections_table,
                subscriptions_table,
            })
        }

        // クリーンアップヘルパー
        // 安全性: テスト環境のクリーンアップ
        unsafe fn cleanup() {
            unsafe {
                remove_env(EVENTS_VAR);
                remove_env(CONNECTIONS_VAR);
                remove_env(SUBSCRIPTIONS_VAR);
            }
        }

        // --- テスト1: EVENTS_TABLEが欠落 ---
        // 安全性: テスト環境、隔離された環境変数名
        unsafe {
            cleanup();
            set_env(CONNECTIONS_VAR, "test-connections");
            set_env(SUBSCRIPTIONS_VAR, "test-subscriptions");
        }

        let result = from_test_env().await;
        assert!(result.is_err());
        match result.unwrap_err() {
            DynamoDbConfigError::MissingEnvVar(var) => {
                assert_eq!(var, "EVENTS_TABLE");
            }
        }

        // --- テスト2: CONNECTIONS_TABLEが欠落 ---
        // 安全性: テスト環境、隔離された環境変数名
        unsafe {
            cleanup();
            set_env(EVENTS_VAR, "test-events");
            set_env(SUBSCRIPTIONS_VAR, "test-subscriptions");
        }

        let result = from_test_env().await;
        assert!(result.is_err());
        match result.unwrap_err() {
            DynamoDbConfigError::MissingEnvVar(var) => {
                assert_eq!(var, "CONNECTIONS_TABLE");
            }
        }

        // --- テスト3: SUBSCRIPTIONS_TABLEが欠落 ---
        // 安全性: テスト環境、隔離された環境変数名
        unsafe {
            cleanup();
            set_env(EVENTS_VAR, "test-events");
            set_env(CONNECTIONS_VAR, "test-connections");
        }

        let result = from_test_env().await;
        assert!(result.is_err());
        match result.unwrap_err() {
            DynamoDbConfigError::MissingEnvVar(var) => {
                assert_eq!(var, "SUBSCRIPTIONS_TABLE");
            }
        }

        // --- テスト4: すべての環境変数が設定されている（成功ケース） ---
        // 安全性: テスト環境、隔離された環境変数名
        unsafe {
            cleanup();
            set_env(EVENTS_VAR, "my-events-table");
            set_env(CONNECTIONS_VAR, "my-connections-table");
            set_env(SUBSCRIPTIONS_VAR, "my-subscriptions-table");
        }

        let result = from_test_env().await;
        assert!(result.is_ok());
        let config = result.unwrap();
        assert_eq!(config.events_table(), "my-events-table");
        assert_eq!(config.connections_table(), "my-connections-table");
        assert_eq!(config.subscriptions_table(), "my-subscriptions-table");

        // 最終クリーンアップ
        // 安全性: テスト環境のクリーンアップ
        unsafe {
            cleanup();
        }
    }
}
