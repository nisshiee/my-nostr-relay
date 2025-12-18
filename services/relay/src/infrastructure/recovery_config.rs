/// Recovery Lambda設定
///
/// 月初の自動復旧または手動復旧時のサービス復旧処理に必要な設定を管理する。
/// 環境変数から各種リソースID、SNSトピックARN、sqlite-apiエンドポイントを読み込む。
///
/// 要件: 4.3
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Recovery設定のエラー型
#[derive(Debug, Error)]
pub enum RecoveryConfigError {
    #[error("環境変数が設定されていません: {0}")]
    MissingEnvVar(String),
}

/// Recovery Lambda設定
///
/// 以下の環境変数から読み込む:
/// - RELAY_LAMBDA_FUNCTION_NAMES: 有効化対象Lambda関数名（カンマ区切り）
/// - EC2_INSTANCE_ID: sqlite-api EC2インスタンスID
/// - CLOUDFRONT_DISTRIBUTION_ID: CloudFrontディストリビューションID
/// - RESULT_SNS_TOPIC_ARN: 結果通知SNSトピックARN
/// - SQLITE_API_ENDPOINT: sqlite-apiヘルスチェックエンドポイントURL
#[derive(Debug, Clone)]
pub struct RecoveryConfig {
    /// 有効化対象のrelay Lambda関数名リスト
    relay_lambda_function_names: Vec<String>,
    /// sqlite-api EC2インスタンスID
    ec2_instance_id: String,
    /// CloudFrontディストリビューションID
    cloudfront_distribution_id: String,
    /// 結果通知SNSトピックARN
    result_sns_topic_arn: String,
    /// sqlite-apiヘルスチェックエンドポイントURL
    sqlite_api_endpoint: String,
}

impl RecoveryConfig {
    /// 環境変数から設定を読み込む
    ///
    /// # エラー
    /// 必要な環境変数が設定されていない場合はエラーを返す
    pub fn from_env() -> Result<Self, RecoveryConfigError> {
        let relay_lambda_function_names_str = std::env::var("RELAY_LAMBDA_FUNCTION_NAMES")
            .map_err(|_| {
                RecoveryConfigError::MissingEnvVar("RELAY_LAMBDA_FUNCTION_NAMES".to_string())
            })?;

        let relay_lambda_function_names: Vec<String> = relay_lambda_function_names_str
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        let ec2_instance_id = std::env::var("EC2_INSTANCE_ID")
            .map_err(|_| RecoveryConfigError::MissingEnvVar("EC2_INSTANCE_ID".to_string()))?;

        let cloudfront_distribution_id = std::env::var("CLOUDFRONT_DISTRIBUTION_ID").map_err(
            |_| RecoveryConfigError::MissingEnvVar("CLOUDFRONT_DISTRIBUTION_ID".to_string()),
        )?;

        let result_sns_topic_arn = std::env::var("RESULT_SNS_TOPIC_ARN")
            .map_err(|_| RecoveryConfigError::MissingEnvVar("RESULT_SNS_TOPIC_ARN".to_string()))?;

        let sqlite_api_endpoint = std::env::var("SQLITE_API_ENDPOINT")
            .map_err(|_| RecoveryConfigError::MissingEnvVar("SQLITE_API_ENDPOINT".to_string()))?;

        Ok(Self {
            relay_lambda_function_names,
            ec2_instance_id,
            cloudfront_distribution_id,
            result_sns_topic_arn,
            sqlite_api_endpoint,
        })
    }

    /// 明示的な値で設定を作成（テスト用）
    pub fn new(
        relay_lambda_function_names: Vec<String>,
        ec2_instance_id: String,
        cloudfront_distribution_id: String,
        result_sns_topic_arn: String,
        sqlite_api_endpoint: String,
    ) -> Self {
        Self {
            relay_lambda_function_names,
            ec2_instance_id,
            cloudfront_distribution_id,
            result_sns_topic_arn,
            sqlite_api_endpoint,
        }
    }

    /// 有効化対象のrelay Lambda関数名リストを取得
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

    /// sqlite-apiヘルスチェックエンドポイントURLを取得
    pub fn sqlite_api_endpoint(&self) -> &str {
        &self.sqlite_api_endpoint
    }
}

/// 各ステップの実行結果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepResult {
    /// ステップ名
    pub step: String,
    /// 成功したかどうか
    pub success: bool,
    /// 結果メッセージ
    pub message: String,
    /// 実行時間（ミリ秒）
    pub duration_ms: u64,
}

impl StepResult {
    /// 新しいStepResultを作成
    pub fn new(step: impl Into<String>, success: bool, message: impl Into<String>, duration_ms: u64) -> Self {
        Self {
            step: step.into(),
            success,
            message: message.into(),
            duration_ms,
        }
    }

    /// 成功結果を作成
    pub fn success(step: impl Into<String>, message: impl Into<String>, duration_ms: u64) -> Self {
        Self::new(step, true, message, duration_ms)
    }

    /// 失敗結果を作成
    pub fn failure(step: impl Into<String>, message: impl Into<String>, duration_ms: u64) -> Self {
        Self::new(step, false, message, duration_ms)
    }
}

/// Recovery Lambda全体の実行結果
///
/// 成功時とエラー時で構造が異なる:
/// - 成功時/スキップ時: stepsにすべてのステップ結果を格納
/// - エラー時: error_stepとerror_messageでエラー情報、completed_stepsに完了分を格納
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryResult {
    /// 結果タイプ
    #[serde(rename = "type")]
    pub result_type: String,
    /// タイムスタンプ（ISO 8601形式）
    pub timestamp: String,
    /// スキップしたかどうか
    pub skipped: bool,
    /// スキップ理由（スキップ時のみ）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_reason: Option<String>,
    /// 全体の成功/失敗
    pub overall_success: bool,
    /// 各ステップの結果（成功時/スキップ時）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steps: Option<Vec<StepResult>>,
    /// エラーが発生したステップ（エラー時）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_step: Option<String>,
    /// エラーメッセージ（エラー時）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    /// 完了したステップ（エラー時）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_steps: Option<Vec<StepResult>>,
    /// 合計実行時間（ミリ秒）
    pub total_duration_ms: u64,
}

impl RecoveryResult {
    /// 成功時の結果を作成
    pub fn success(timestamp: String, steps: Vec<StepResult>) -> Self {
        let total_duration_ms = steps.iter().map(|s| s.duration_ms).sum();

        Self {
            result_type: "recovery-result".to_string(),
            timestamp,
            skipped: false,
            skip_reason: None,
            overall_success: true,
            steps: Some(steps),
            error_step: None,
            error_message: None,
            completed_steps: None,
            total_duration_ms,
        }
    }

    /// スキップ時の結果を作成
    pub fn skipped(timestamp: String, skip_reason: String) -> Self {
        Self {
            result_type: "recovery-result".to_string(),
            timestamp,
            skipped: true,
            skip_reason: Some(skip_reason),
            overall_success: true,
            steps: None,
            error_step: None,
            error_message: None,
            completed_steps: None,
            total_duration_ms: 0,
        }
    }

    /// エラー時の結果を作成
    pub fn error(
        timestamp: String,
        error_step: String,
        error_message: String,
        completed_steps: Vec<StepResult>,
    ) -> Self {
        let total_duration_ms = completed_steps.iter().map(|s| s.duration_ms).sum();

        Self {
            result_type: "recovery-result".to_string(),
            timestamp,
            skipped: false,
            skip_reason: None,
            overall_success: false,
            steps: None,
            error_step: Some(error_step),
            error_message: Some(error_message),
            completed_steps: Some(completed_steps),
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

    // ==================== RecoveryConfigError テスト ====================

    #[test]
    fn test_recovery_config_error_display() {
        let error = RecoveryConfigError::MissingEnvVar("TEST_VAR".to_string());
        assert_eq!(
            error.to_string(),
            "環境変数が設定されていません: TEST_VAR"
        );
    }

    // ==================== RecoveryConfig テスト ====================

    #[test]
    fn test_recovery_config_new() {
        let config = RecoveryConfig::new(
            vec!["func1".to_string(), "func2".to_string()],
            "i-1234567890abcdef0".to_string(),
            "E1234567890ABC".to_string(),
            "arn:aws:sns:ap-northeast-1:123456789012:test-topic".to_string(),
            "https://sqlite-api.example.com".to_string(),
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
        assert_eq!(config.sqlite_api_endpoint(), "https://sqlite-api.example.com");
    }

    #[test]
    #[serial]
    fn test_recovery_config_from_env_success() {
        // テスト用のユニークな環境変数名
        const LAMBDA_VAR: &str = "TEST_RECOVERY_RELAY_LAMBDA_FUNCTION_NAMES";
        const EC2_VAR: &str = "TEST_RECOVERY_EC2_INSTANCE_ID";
        const CF_VAR: &str = "TEST_RECOVERY_CLOUDFRONT_DISTRIBUTION_ID";
        const SNS_VAR: &str = "TEST_RECOVERY_RESULT_SNS_TOPIC_ARN";
        const ENDPOINT_VAR: &str = "TEST_RECOVERY_SQLITE_API_ENDPOINT";

        // テスト用のfrom_env（テスト用環境変数を使用）
        fn from_test_env() -> Result<RecoveryConfig, RecoveryConfigError> {
            let relay_lambda_function_names_str = std::env::var(LAMBDA_VAR)
                .map_err(|_| RecoveryConfigError::MissingEnvVar("RELAY_LAMBDA_FUNCTION_NAMES".to_string()))?;

            let relay_lambda_function_names: Vec<String> = relay_lambda_function_names_str
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();

            let ec2_instance_id = std::env::var(EC2_VAR)
                .map_err(|_| RecoveryConfigError::MissingEnvVar("EC2_INSTANCE_ID".to_string()))?;

            let cloudfront_distribution_id = std::env::var(CF_VAR)
                .map_err(|_| RecoveryConfigError::MissingEnvVar("CLOUDFRONT_DISTRIBUTION_ID".to_string()))?;

            let result_sns_topic_arn = std::env::var(SNS_VAR)
                .map_err(|_| RecoveryConfigError::MissingEnvVar("RESULT_SNS_TOPIC_ARN".to_string()))?;

            let sqlite_api_endpoint = std::env::var(ENDPOINT_VAR)
                .map_err(|_| RecoveryConfigError::MissingEnvVar("SQLITE_API_ENDPOINT".to_string()))?;

            Ok(RecoveryConfig {
                relay_lambda_function_names,
                ec2_instance_id,
                cloudfront_distribution_id,
                result_sns_topic_arn,
                sqlite_api_endpoint,
            })
        }

        // クリーンアップヘルパー
        unsafe fn cleanup() {
            unsafe {
                remove_env(LAMBDA_VAR);
                remove_env(EC2_VAR);
                remove_env(CF_VAR);
                remove_env(SNS_VAR);
                remove_env(ENDPOINT_VAR);
            }
        }

        // 環境変数を設定
        unsafe {
            cleanup();
            set_env(LAMBDA_VAR, "connect,disconnect,default");
            set_env(EC2_VAR, "i-0123456789abcdef0");
            set_env(CF_VAR, "E1234567890ABC");
            set_env(SNS_VAR, "arn:aws:sns:ap-northeast-1:123456789012:budget-result");
            set_env(ENDPOINT_VAR, "https://sqlite-api.relay.nostr.example.org");
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
        assert_eq!(
            config.sqlite_api_endpoint(),
            "https://sqlite-api.relay.nostr.example.org"
        );

        // クリーンアップ
        unsafe { cleanup() };
    }

    #[test]
    #[serial]
    fn test_recovery_config_from_env_missing_vars() {
        const ENDPOINT_VAR: &str = "TEST_RECOVERY_MISSING_SQLITE_API_ENDPOINT";

        // クリーンアップ
        unsafe fn cleanup() {
            unsafe { remove_env(ENDPOINT_VAR) };
        }

        // テスト: SQLITE_API_ENDPOINTが欠落
        fn from_test_env() -> Result<String, RecoveryConfigError> {
            std::env::var(ENDPOINT_VAR)
                .map_err(|_| RecoveryConfigError::MissingEnvVar("SQLITE_API_ENDPOINT".to_string()))
        }

        unsafe { cleanup() };
        let result = from_test_env();
        assert!(result.is_err());
        match result.unwrap_err() {
            RecoveryConfigError::MissingEnvVar(var) => {
                assert_eq!(var, "SQLITE_API_ENDPOINT");
            }
        }

        unsafe { cleanup() };
    }

    // ==================== StepResult テスト ====================

    #[test]
    fn test_step_result_new() {
        let result = StepResult::new("ec2-start", true, "instance started", 5000);

        assert_eq!(result.step, "ec2-start");
        assert!(result.success);
        assert_eq!(result.message, "instance started");
        assert_eq!(result.duration_ms, 5000);
    }

    #[test]
    fn test_step_result_success() {
        let result = StepResult::success("health-check", "sqlite-api healthy", 1500);

        assert_eq!(result.step, "health-check");
        assert!(result.success);
        assert_eq!(result.message, "sqlite-api healthy");
        assert_eq!(result.duration_ms, 1500);
    }

    #[test]
    fn test_step_result_failure() {
        let result = StepResult::failure("lambda-enable", "API call failed", 2000);

        assert_eq!(result.step, "lambda-enable");
        assert!(!result.success);
        assert_eq!(result.message, "API call failed");
        assert_eq!(result.duration_ms, 2000);
    }

    #[test]
    fn test_step_result_serialize() {
        let result = StepResult::success("test-step", "test message", 100);
        let json = serde_json::to_string(&result).unwrap();

        assert!(json.contains("\"step\":\"test-step\""));
        assert!(json.contains("\"success\":true"));
        assert!(json.contains("\"message\":\"test message\""));
        assert!(json.contains("\"duration_ms\":100"));
    }

    // ==================== RecoveryResult テスト ====================

    #[test]
    fn test_recovery_result_success() {
        let steps = vec![
            StepResult::success("ec2-start", "instance started", 5000),
            StepResult::success("health-check", "sqlite-api healthy", 1500),
            StepResult::success("lambda-enable", "3 functions enabled", 2000),
            StepResult::success("cloudfront-enable", "distribution enabled", 3000),
        ];

        let result = RecoveryResult::success("2025-02-01T00:05:30Z".to_string(), steps);

        assert_eq!(result.result_type, "recovery-result");
        assert_eq!(result.timestamp, "2025-02-01T00:05:30Z");
        assert!(!result.skipped);
        assert!(result.skip_reason.is_none());
        assert!(result.overall_success);
        assert!(result.steps.is_some());
        assert_eq!(result.steps.as_ref().unwrap().len(), 4);
        assert!(result.error_step.is_none());
        assert!(result.error_message.is_none());
        assert!(result.completed_steps.is_none());
        assert_eq!(result.total_duration_ms, 11500);
    }

    #[test]
    fn test_recovery_result_skipped() {
        let result = RecoveryResult::skipped(
            "2025-02-01T00:05:30Z".to_string(),
            "サービスは既に稼働中".to_string(),
        );

        assert_eq!(result.result_type, "recovery-result");
        assert_eq!(result.timestamp, "2025-02-01T00:05:30Z");
        assert!(result.skipped);
        assert_eq!(result.skip_reason.as_ref().unwrap(), "サービスは既に稼働中");
        assert!(result.overall_success);
        assert!(result.steps.is_none());
        assert!(result.error_step.is_none());
        assert!(result.error_message.is_none());
        assert!(result.completed_steps.is_none());
        assert_eq!(result.total_duration_ms, 0);
    }

    #[test]
    fn test_recovery_result_error() {
        let completed_steps = vec![
            StepResult::success("ec2-start", "instance started", 5000),
        ];

        let result = RecoveryResult::error(
            "2025-02-01T00:05:45Z".to_string(),
            "health-check".to_string(),
            "sqlite-api health check failed after 5 retries".to_string(),
            completed_steps,
        );

        assert_eq!(result.result_type, "recovery-result");
        assert_eq!(result.timestamp, "2025-02-01T00:05:45Z");
        assert!(!result.skipped);
        assert!(result.skip_reason.is_none());
        assert!(!result.overall_success);
        assert!(result.steps.is_none());
        assert_eq!(result.error_step.as_ref().unwrap(), "health-check");
        assert_eq!(
            result.error_message.as_ref().unwrap(),
            "sqlite-api health check failed after 5 retries"
        );
        assert!(result.completed_steps.is_some());
        assert_eq!(result.completed_steps.as_ref().unwrap().len(), 1);
        assert_eq!(result.total_duration_ms, 5000);
    }

    #[test]
    fn test_recovery_result_success_serialize() {
        let steps = vec![
            StepResult::success("ec2-start", "instance started", 5000),
        ];

        let result = RecoveryResult::success("2025-02-01T00:05:30Z".to_string(), steps);
        let json = serde_json::to_string_pretty(&result).unwrap();

        assert!(json.contains("\"type\": \"recovery-result\""));
        assert!(json.contains("\"timestamp\": \"2025-02-01T00:05:30Z\""));
        assert!(json.contains("\"skipped\": false"));
        assert!(json.contains("\"overall_success\": true"));
        assert!(json.contains("\"steps\""));
        // skip_reason, error_step, error_message, completed_steps はシリアライズされない
        assert!(!json.contains("skip_reason"));
        assert!(!json.contains("error_step"));
        assert!(!json.contains("error_message"));
        assert!(!json.contains("completed_steps"));
    }

    #[test]
    fn test_recovery_result_skipped_serialize() {
        let result = RecoveryResult::skipped(
            "2025-02-01T00:05:30Z".to_string(),
            "サービスは既に稼働中".to_string(),
        );
        let json = serde_json::to_string_pretty(&result).unwrap();

        assert!(json.contains("\"skipped\": true"));
        assert!(json.contains("\"skip_reason\": \"サービスは既に稼働中\""));
        assert!(json.contains("\"overall_success\": true"));
        // steps, error_* はシリアライズされない
        assert!(!json.contains("\"steps\""));
        assert!(!json.contains("error_step"));
        assert!(!json.contains("error_message"));
        assert!(!json.contains("completed_steps"));
    }

    #[test]
    fn test_recovery_result_error_serialize() {
        let completed_steps = vec![
            StepResult::success("ec2-start", "instance started", 5000),
        ];

        let result = RecoveryResult::error(
            "2025-02-01T00:05:45Z".to_string(),
            "health-check".to_string(),
            "health check failed".to_string(),
            completed_steps,
        );
        let json = serde_json::to_string_pretty(&result).unwrap();

        assert!(json.contains("\"overall_success\": false"));
        assert!(json.contains("\"error_step\": \"health-check\""));
        assert!(json.contains("\"error_message\": \"health check failed\""));
        assert!(json.contains("\"completed_steps\""));
        // steps, skip_reason はシリアライズされない
        assert!(!json.contains("\"steps\""));
        assert!(!json.contains("skip_reason"));
    }
}
