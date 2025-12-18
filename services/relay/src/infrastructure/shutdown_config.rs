/// Shutdown Lambda設定
///
/// 予算超過時のサービス自動停止処理に必要な設定を管理する。
/// 環境変数から各種リソースID、SNSトピックARNを読み込む。
///
/// 要件: 3.1, 3.8
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Shutdown設定のエラー型
#[derive(Debug, Error)]
pub enum ShutdownConfigError {
    #[error("環境変数が設定されていません: {0}")]
    MissingEnvVar(String),
}

/// Shutdown Lambda設定
///
/// 以下の環境変数から読み込む:
/// - RELAY_LAMBDA_FUNCTION_NAMES: 停止対象Lambda関数名（カンマ区切り）
/// - EC2_INSTANCE_ID: sqlite-api EC2インスタンスID
/// - CLOUDFRONT_DISTRIBUTION_ID: CloudFrontディストリビューションID
/// - RESULT_SNS_TOPIC_ARN: 結果通知SNSトピックARN
/// - SQLITE_API_SYSTEMD_SERVICE: sqlite-apiのsystemdサービス名
#[derive(Debug, Clone)]
pub struct ShutdownConfig {
    /// 停止対象のrelay Lambda関数名リスト
    relay_lambda_function_names: Vec<String>,
    /// sqlite-api EC2インスタンスID
    ec2_instance_id: String,
    /// CloudFrontディストリビューションID
    cloudfront_distribution_id: String,
    /// 結果通知SNSトピックARN
    result_sns_topic_arn: String,
    /// sqlite-apiのsystemdサービス名
    sqlite_api_systemd_service: String,
}

impl ShutdownConfig {
    /// 環境変数から設定を読み込む
    ///
    /// # エラー
    /// 必要な環境変数が設定されていない場合はエラーを返す
    pub fn from_env() -> Result<Self, ShutdownConfigError> {
        let relay_lambda_function_names_str = std::env::var("RELAY_LAMBDA_FUNCTION_NAMES")
            .map_err(|_| {
                ShutdownConfigError::MissingEnvVar("RELAY_LAMBDA_FUNCTION_NAMES".to_string())
            })?;

        let relay_lambda_function_names: Vec<String> = relay_lambda_function_names_str
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        let ec2_instance_id = std::env::var("EC2_INSTANCE_ID")
            .map_err(|_| ShutdownConfigError::MissingEnvVar("EC2_INSTANCE_ID".to_string()))?;

        let cloudfront_distribution_id = std::env::var("CLOUDFRONT_DISTRIBUTION_ID").map_err(
            |_| ShutdownConfigError::MissingEnvVar("CLOUDFRONT_DISTRIBUTION_ID".to_string()),
        )?;

        let result_sns_topic_arn = std::env::var("RESULT_SNS_TOPIC_ARN")
            .map_err(|_| ShutdownConfigError::MissingEnvVar("RESULT_SNS_TOPIC_ARN".to_string()))?;

        let sqlite_api_systemd_service = std::env::var("SQLITE_API_SYSTEMD_SERVICE").map_err(
            |_| ShutdownConfigError::MissingEnvVar("SQLITE_API_SYSTEMD_SERVICE".to_string()),
        )?;

        Ok(Self {
            relay_lambda_function_names,
            ec2_instance_id,
            cloudfront_distribution_id,
            result_sns_topic_arn,
            sqlite_api_systemd_service,
        })
    }

    /// 明示的な値で設定を作成（テスト用）
    pub fn new(
        relay_lambda_function_names: Vec<String>,
        ec2_instance_id: String,
        cloudfront_distribution_id: String,
        result_sns_topic_arn: String,
        sqlite_api_systemd_service: String,
    ) -> Self {
        Self {
            relay_lambda_function_names,
            ec2_instance_id,
            cloudfront_distribution_id,
            result_sns_topic_arn,
            sqlite_api_systemd_service,
        }
    }

    /// 停止対象のrelay Lambda関数名リストを取得
    pub fn relay_lambda_function_names(&self) -> &[String] {
        &self.relay_lambda_function_names
    }

    /// EC2インスタンスIDを取得
    pub fn ec2_instance_id(&self) -> &str {
        &self.ec2_instance_id
    }

    /// CloudFrontディストリビューションIDを取得
    pub fn cloudfront_distribution_id(&self) -> &str {
        &self.cloudfront_distribution_id
    }

    /// 結果通知SNSトピックARNを取得
    pub fn result_sns_topic_arn(&self) -> &str {
        &self.result_sns_topic_arn
    }

    /// sqlite-apiのsystemdサービス名を取得
    pub fn sqlite_api_systemd_service(&self) -> &str {
        &self.sqlite_api_systemd_service
    }
}

/// 各フェーズの実行結果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhaseResult {
    /// フェーズ名
    pub phase: String,
    /// 成功したかどうか
    pub success: bool,
    /// 結果メッセージ
    pub message: String,
    /// 実行時間（ミリ秒）
    pub duration_ms: u64,
}

impl PhaseResult {
    /// 新しいPhaseResultを作成
    pub fn new(phase: impl Into<String>, success: bool, message: impl Into<String>, duration_ms: u64) -> Self {
        Self {
            phase: phase.into(),
            success,
            message: message.into(),
            duration_ms,
        }
    }

    /// 成功結果を作成
    pub fn success(phase: impl Into<String>, message: impl Into<String>, duration_ms: u64) -> Self {
        Self::new(phase, true, message, duration_ms)
    }

    /// 失敗結果を作成
    pub fn failure(phase: impl Into<String>, message: impl Into<String>, duration_ms: u64) -> Self {
        Self::new(phase, false, message, duration_ms)
    }
}

/// Shutdown Lambda全体の実行結果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShutdownResult {
    /// 結果タイプ
    #[serde(rename = "type")]
    pub result_type: String,
    /// タイムスタンプ（ISO 8601形式）
    pub timestamp: String,
    /// 各フェーズの結果
    pub phases: Vec<PhaseResult>,
    /// 全体の成功/失敗
    pub overall_success: bool,
    /// 合計実行時間（ミリ秒）
    pub total_duration_ms: u64,
}

impl ShutdownResult {
    /// 新しいShutdownResultを作成
    pub fn new(timestamp: String, phases: Vec<PhaseResult>) -> Self {
        let overall_success = phases.iter().all(|p| p.success);
        let total_duration_ms = phases.iter().map(|p| p.duration_ms).sum();

        Self {
            result_type: "shutdown-result".to_string(),
            timestamp,
            phases,
            overall_success,
            total_duration_ms,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    // テストで環境変数を安全に設定/削除するヘルパー
    // 安全性: シングルスレッドテスト環境でのみ使用
    unsafe fn set_env(key: &str, value: &str) {
        unsafe { std::env::set_var(key, value) };
    }

    unsafe fn remove_env(key: &str) {
        unsafe { std::env::remove_var(key) };
    }

    // ==================== ShutdownConfigError テスト ====================

    #[test]
    fn test_shutdown_config_error_display() {
        let error = ShutdownConfigError::MissingEnvVar("TEST_VAR".to_string());
        assert_eq!(
            error.to_string(),
            "環境変数が設定されていません: TEST_VAR"
        );
    }

    // ==================== ShutdownConfig テスト ====================

    #[test]
    fn test_shutdown_config_new() {
        let config = ShutdownConfig::new(
            vec!["func1".to_string(), "func2".to_string()],
            "i-1234567890abcdef0".to_string(),
            "E1234567890ABC".to_string(),
            "arn:aws:sns:ap-northeast-1:123456789012:test-topic".to_string(),
            "nostr-api".to_string(),
        );

        assert_eq!(
            config.relay_lambda_function_names(),
            &["func1".to_string(), "func2".to_string()]
        );
        assert_eq!(config.ec2_instance_id(), "i-1234567890abcdef0");
        assert_eq!(config.cloudfront_distribution_id(), "E1234567890ABC");
        assert_eq!(
            config.result_sns_topic_arn(),
            "arn:aws:sns:ap-northeast-1:123456789012:test-topic"
        );
        assert_eq!(config.sqlite_api_systemd_service(), "nostr-api");
    }

    #[test]
    #[serial]
    fn test_shutdown_config_from_env_success() {
        // テスト用のユニークな環境変数名
        const LAMBDA_VAR: &str = "TEST_SHUTDOWN_RELAY_LAMBDA_FUNCTION_NAMES";
        const EC2_VAR: &str = "TEST_SHUTDOWN_EC2_INSTANCE_ID";
        const CF_VAR: &str = "TEST_SHUTDOWN_CLOUDFRONT_DISTRIBUTION_ID";
        const SNS_VAR: &str = "TEST_SHUTDOWN_RESULT_SNS_TOPIC_ARN";
        const SYSTEMD_VAR: &str = "TEST_SHUTDOWN_SQLITE_API_SYSTEMD_SERVICE";

        // テスト用のfrom_env（テスト用環境変数を使用）
        fn from_test_env() -> Result<ShutdownConfig, ShutdownConfigError> {
            let relay_lambda_function_names_str = std::env::var(LAMBDA_VAR)
                .map_err(|_| ShutdownConfigError::MissingEnvVar("RELAY_LAMBDA_FUNCTION_NAMES".to_string()))?;

            let relay_lambda_function_names: Vec<String> = relay_lambda_function_names_str
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();

            let ec2_instance_id = std::env::var(EC2_VAR)
                .map_err(|_| ShutdownConfigError::MissingEnvVar("EC2_INSTANCE_ID".to_string()))?;

            let cloudfront_distribution_id = std::env::var(CF_VAR)
                .map_err(|_| ShutdownConfigError::MissingEnvVar("CLOUDFRONT_DISTRIBUTION_ID".to_string()))?;

            let result_sns_topic_arn = std::env::var(SNS_VAR)
                .map_err(|_| ShutdownConfigError::MissingEnvVar("RESULT_SNS_TOPIC_ARN".to_string()))?;

            let sqlite_api_systemd_service = std::env::var(SYSTEMD_VAR)
                .map_err(|_| ShutdownConfigError::MissingEnvVar("SQLITE_API_SYSTEMD_SERVICE".to_string()))?;

            Ok(ShutdownConfig {
                relay_lambda_function_names,
                ec2_instance_id,
                cloudfront_distribution_id,
                result_sns_topic_arn,
                sqlite_api_systemd_service,
            })
        }

        // クリーンアップヘルパー
        unsafe fn cleanup() {
            unsafe {
                remove_env(LAMBDA_VAR);
                remove_env(EC2_VAR);
                remove_env(CF_VAR);
                remove_env(SNS_VAR);
                remove_env(SYSTEMD_VAR);
            }
        }

        // 環境変数を設定
        unsafe {
            cleanup();
            set_env(LAMBDA_VAR, "connect,disconnect,default");
            set_env(EC2_VAR, "i-0123456789abcdef0");
            set_env(CF_VAR, "E1234567890ABC");
            set_env(SNS_VAR, "arn:aws:sns:ap-northeast-1:123456789012:budget-result");
            set_env(SYSTEMD_VAR, "nostr-api");
        }

        let result = from_test_env();
        assert!(result.is_ok());
        let config = result.unwrap();

        assert_eq!(
            config.relay_lambda_function_names(),
            &["connect".to_string(), "disconnect".to_string(), "default".to_string()]
        );
        assert_eq!(config.ec2_instance_id(), "i-0123456789abcdef0");
        assert_eq!(config.cloudfront_distribution_id(), "E1234567890ABC");
        assert_eq!(
            config.result_sns_topic_arn(),
            "arn:aws:sns:ap-northeast-1:123456789012:budget-result"
        );
        assert_eq!(config.sqlite_api_systemd_service(), "nostr-api");

        // クリーンアップ
        unsafe { cleanup() };
    }

    #[test]
    #[serial]
    fn test_shutdown_config_from_env_missing_vars() {
        const EC2_VAR: &str = "TEST_SHUTDOWN_MISSING_EC2_INSTANCE_ID";

        // クリーンアップ
        unsafe fn cleanup() {
            unsafe { remove_env(EC2_VAR) };
        }

        // テスト: EC2_INSTANCE_IDが欠落
        fn from_test_env() -> Result<String, ShutdownConfigError> {
            std::env::var(EC2_VAR)
                .map_err(|_| ShutdownConfigError::MissingEnvVar("EC2_INSTANCE_ID".to_string()))
        }

        unsafe { cleanup() };
        let result = from_test_env();
        assert!(result.is_err());
        match result.unwrap_err() {
            ShutdownConfigError::MissingEnvVar(var) => {
                assert_eq!(var, "EC2_INSTANCE_ID");
            }
        }

        unsafe { cleanup() };
    }

    #[test]
    fn test_lambda_function_names_parsing() {
        // カンマ区切りのパース
        let input = "func1, func2,  func3";
        let result: Vec<String> = input
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        assert_eq!(result, vec!["func1", "func2", "func3"]);

        // 空文字列のフィルタリング
        let input = "func1,,func2,";
        let result: Vec<String> = input
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        assert_eq!(result, vec!["func1", "func2"]);
    }

    // ==================== PhaseResult テスト ====================

    #[test]
    fn test_phase_result_new() {
        let result = PhaseResult::new("lambda-disable", true, "3 functions disabled", 1500);

        assert_eq!(result.phase, "lambda-disable");
        assert!(result.success);
        assert_eq!(result.message, "3 functions disabled");
        assert_eq!(result.duration_ms, 1500);
    }

    #[test]
    fn test_phase_result_success() {
        let result = PhaseResult::success("ec2-stop", "instance stopped", 5000);

        assert_eq!(result.phase, "ec2-stop");
        assert!(result.success);
        assert_eq!(result.message, "instance stopped");
        assert_eq!(result.duration_ms, 5000);
    }

    #[test]
    fn test_phase_result_failure() {
        let result = PhaseResult::failure("cloudfront-disable", "API call failed", 2000);

        assert_eq!(result.phase, "cloudfront-disable");
        assert!(!result.success);
        assert_eq!(result.message, "API call failed");
        assert_eq!(result.duration_ms, 2000);
    }

    #[test]
    fn test_phase_result_serialize() {
        let result = PhaseResult::success("test-phase", "test message", 100);
        let json = serde_json::to_string(&result).unwrap();

        assert!(json.contains("\"phase\":\"test-phase\""));
        assert!(json.contains("\"success\":true"));
        assert!(json.contains("\"message\":\"test message\""));
        assert!(json.contains("\"duration_ms\":100"));
    }

    // ==================== ShutdownResult テスト ====================

    #[test]
    fn test_shutdown_result_new_all_success() {
        let phases = vec![
            PhaseResult::success("phase1", "ok", 100),
            PhaseResult::success("phase2", "ok", 200),
        ];

        let result = ShutdownResult::new("2025-01-15T10:30:00Z".to_string(), phases);

        assert_eq!(result.result_type, "shutdown-result");
        assert_eq!(result.timestamp, "2025-01-15T10:30:00Z");
        assert!(result.overall_success);
        assert_eq!(result.total_duration_ms, 300);
        assert_eq!(result.phases.len(), 2);
    }

    #[test]
    fn test_shutdown_result_new_with_failure() {
        let phases = vec![
            PhaseResult::success("phase1", "ok", 100),
            PhaseResult::failure("phase2", "failed", 200),
            PhaseResult::success("phase3", "ok", 300),
        ];

        let result = ShutdownResult::new("2025-01-15T10:30:00Z".to_string(), phases);

        assert!(!result.overall_success);
        assert_eq!(result.total_duration_ms, 600);
    }

    #[test]
    fn test_shutdown_result_serialize() {
        let phases = vec![
            PhaseResult::success("lambda-disable", "3 functions disabled", 1500),
        ];

        let result = ShutdownResult::new("2025-01-15T10:30:00Z".to_string(), phases);
        let json = serde_json::to_string_pretty(&result).unwrap();

        assert!(json.contains("\"type\": \"shutdown-result\""));
        assert!(json.contains("\"timestamp\": \"2025-01-15T10:30:00Z\""));
        assert!(json.contains("\"overall_success\": true"));
        assert!(json.contains("\"total_duration_ms\": 1500"));
    }
}
