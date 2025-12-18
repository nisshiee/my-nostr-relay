//! CloudFront操作モジュール
//!
//! Shutdown/Recovery Lambdaで使用するCloudFrontディストリビューションの制御操作を提供する。
//! - ディストリビューションの無効化（Enabled=false）
//! - ディストリビューションの有効化（Enabled=true）
//!
//! 要件: 3.7, 4.7

use async_trait::async_trait;
use aws_sdk_cloudfront::Client as CloudFrontClient;
use thiserror::Error;
use tracing::{info, warn};

/// CloudFront操作のエラー型
#[derive(Debug, Error)]
pub enum CloudFrontOpsError {
    /// AWS SDK エラー
    #[error("AWS CloudFront APIエラー: {0}")]
    AwsSdkError(String),
    /// ディストリビューションが見つからない
    #[error("ディストリビューションが見つかりません: {0}")]
    DistributionNotFound(String),
    /// 設定取得エラー
    #[error("ディストリビューション設定の取得に失敗: {0}")]
    GetConfigError(String),
}

/// CloudFrontディストリビューション無効化結果
#[derive(Debug, Clone)]
pub struct DisableDistributionResult {
    /// ディストリビューションID
    pub distribution_id: String,
    /// 成功したかどうか
    pub success: bool,
    /// 以前の状態（enabled/disabled）
    pub was_enabled: bool,
    /// 結果メッセージ
    pub message: String,
}

impl DisableDistributionResult {
    /// 成功結果を作成
    pub fn success(distribution_id: impl Into<String>, was_enabled: bool) -> Self {
        let id = distribution_id.into();
        let message = if was_enabled {
            format!("ディストリビューション {} を無効化しました", id)
        } else {
            format!("ディストリビューション {} は既に無効化されています", id)
        };
        Self {
            distribution_id: id,
            success: true,
            was_enabled,
            message,
        }
    }

    /// 失敗結果を作成
    pub fn failure(distribution_id: impl Into<String>, error: impl std::fmt::Display) -> Self {
        let id = distribution_id.into();
        let message = format!("ディストリビューション {} の無効化に失敗: {}", id, error);
        Self {
            distribution_id: id,
            success: false,
            was_enabled: false,
            message,
        }
    }
}

/// CloudFront操作トレイト（テスト用の抽象化）
#[async_trait]
pub trait CloudFrontOps: Send + Sync {
    /// CloudFrontディストリビューションを無効化する
    ///
    /// GetDistributionでETagと現在の設定を取得し、
    /// UpdateDistributionでEnabled=falseに設定する。
    ///
    /// # 引数
    /// * `distribution_id` - CloudFrontディストリビューションID
    ///
    /// # 戻り値
    /// * `Ok(DisableDistributionResult)` - 無効化結果
    /// * `Err(CloudFrontOpsError)` - エラー
    async fn disable_distribution(
        &self,
        distribution_id: &str,
    ) -> Result<DisableDistributionResult, CloudFrontOpsError>;
}

/// 実際のAWS CloudFront SDKを使用したCloudFront操作実装
pub struct AwsCloudFrontOps {
    client: CloudFrontClient,
}

impl AwsCloudFrontOps {
    /// 新しいAwsCloudFrontOpsを作成
    pub fn new(client: CloudFrontClient) -> Self {
        Self { client }
    }

    /// AWS設定からデフォルトのクライアントを作成
    pub async fn from_config() -> Self {
        let config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
        let client = CloudFrontClient::new(&config);
        Self::new(client)
    }
}

#[async_trait]
impl CloudFrontOps for AwsCloudFrontOps {
    async fn disable_distribution(
        &self,
        distribution_id: &str,
    ) -> Result<DisableDistributionResult, CloudFrontOpsError> {
        info!(
            distribution_id = %distribution_id,
            "CloudFrontディストリビューション無効化開始"
        );

        // GetDistributionでETagと現在の設定を取得
        let get_result = self
            .client
            .get_distribution_config()
            .id(distribution_id)
            .send()
            .await
            .map_err(|e| {
                warn!(
                    distribution_id = %distribution_id,
                    error = %e,
                    "GetDistributionConfigエラー"
                );
                CloudFrontOpsError::GetConfigError(e.to_string())
            })?;

        let etag = get_result.e_tag().ok_or_else(|| {
            CloudFrontOpsError::GetConfigError("ETagが取得できませんでした".to_string())
        })?;

        let distribution_config = get_result.distribution_config().ok_or_else(|| {
            CloudFrontOpsError::GetConfigError(
                "DistributionConfigが取得できませんでした".to_string(),
            )
        })?;

        // 現在の状態を確認
        let was_enabled = distribution_config.enabled();

        // 既に無効化されている場合はスキップ
        if !was_enabled {
            info!(
                distribution_id = %distribution_id,
                "ディストリビューションは既に無効化されています"
            );
            return Ok(DisableDistributionResult::success(distribution_id, false));
        }

        // 無効化した設定を作成
        let mut new_config = distribution_config.clone();
        new_config.enabled = false;

        // UpdateDistributionで無効化
        let update_result = self
            .client
            .update_distribution()
            .id(distribution_id)
            .if_match(etag)
            .distribution_config(new_config)
            .send()
            .await;

        match update_result {
            Ok(_) => {
                info!(
                    distribution_id = %distribution_id,
                    "UpdateDistribution成功（無効化）"
                );
                Ok(DisableDistributionResult::success(distribution_id, true))
            }
            Err(err) => {
                warn!(
                    distribution_id = %distribution_id,
                    error = %err,
                    "UpdateDistributionエラー"
                );
                Err(CloudFrontOpsError::AwsSdkError(err.to_string()))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// テスト用のモックCloudFront操作
    struct MockCloudFrontOps {
        /// ディストリビューションIDに対応する状態（enabled）と成功フラグ
        distributions: std::collections::HashMap<String, (bool, bool)>,
        /// disable_distribution呼び出し回数
        call_count: Arc<AtomicUsize>,
    }

    impl MockCloudFrontOps {
        fn new() -> Self {
            Self {
                distributions: std::collections::HashMap::new(),
                call_count: Arc::new(AtomicUsize::new(0)),
            }
        }

        /// ディストリビューションを追加
        /// enabled: 現在の有効状態
        /// disable_success: 無効化が成功するかどうか
        fn with_distribution(
            mut self,
            distribution_id: impl Into<String>,
            enabled: bool,
            disable_success: bool,
        ) -> Self {
            self.distributions
                .insert(distribution_id.into(), (enabled, disable_success));
            self
        }

        fn call_count(&self) -> usize {
            self.call_count.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl CloudFrontOps for MockCloudFrontOps {
        async fn disable_distribution(
            &self,
            distribution_id: &str,
        ) -> Result<DisableDistributionResult, CloudFrontOpsError> {
            self.call_count.fetch_add(1, Ordering::SeqCst);

            match self.distributions.get(distribution_id) {
                Some((enabled, true)) => {
                    Ok(DisableDistributionResult::success(distribution_id, *enabled))
                }
                Some((_, false)) => Err(CloudFrontOpsError::AwsSdkError("mock error".to_string())),
                None => Err(CloudFrontOpsError::DistributionNotFound(
                    distribution_id.to_string(),
                )),
            }
        }
    }

    // ==================== DisableDistributionResult テスト ====================

    #[test]
    fn test_disable_distribution_result_success_was_enabled() {
        let result = DisableDistributionResult::success("E1234567890ABC", true);

        assert_eq!(result.distribution_id, "E1234567890ABC");
        assert!(result.success);
        assert!(result.was_enabled);
        assert!(result.message.contains("E1234567890ABC"));
        assert!(result.message.contains("無効化しました"));
    }

    #[test]
    fn test_disable_distribution_result_success_was_disabled() {
        let result = DisableDistributionResult::success("E1234567890ABC", false);

        assert_eq!(result.distribution_id, "E1234567890ABC");
        assert!(result.success);
        assert!(!result.was_enabled);
        assert!(result.message.contains("既に無効化"));
    }

    #[test]
    fn test_disable_distribution_result_failure() {
        let result = DisableDistributionResult::failure("E1234567890ABC", "API error");

        assert_eq!(result.distribution_id, "E1234567890ABC");
        assert!(!result.success);
        assert!(result.message.contains("失敗"));
        assert!(result.message.contains("API error"));
    }

    // ==================== CloudFrontOpsError テスト ====================

    #[test]
    fn test_cloudfront_ops_error_display() {
        let sdk_error = CloudFrontOpsError::AwsSdkError("API呼び出し失敗".to_string());
        assert_eq!(
            sdk_error.to_string(),
            "AWS CloudFront APIエラー: API呼び出し失敗"
        );

        let not_found = CloudFrontOpsError::DistributionNotFound("E123".to_string());
        assert_eq!(
            not_found.to_string(),
            "ディストリビューションが見つかりません: E123"
        );

        let config_error = CloudFrontOpsError::GetConfigError("設定取得失敗".to_string());
        assert_eq!(
            config_error.to_string(),
            "ディストリビューション設定の取得に失敗: 設定取得失敗"
        );
    }

    // ==================== MockCloudFrontOps テスト ====================

    #[tokio::test]
    async fn test_mock_cloudfront_ops_disable_success_was_enabled() {
        let mock = MockCloudFrontOps::new().with_distribution("E1234567890ABC", true, true);

        let result = mock.disable_distribution("E1234567890ABC").await;

        assert!(result.is_ok());
        let result = result.unwrap();
        assert!(result.success);
        assert!(result.was_enabled);
        assert_eq!(mock.call_count(), 1);
    }

    #[tokio::test]
    async fn test_mock_cloudfront_ops_disable_success_was_disabled() {
        let mock = MockCloudFrontOps::new().with_distribution("E1234567890ABC", false, true);

        let result = mock.disable_distribution("E1234567890ABC").await;

        assert!(result.is_ok());
        let result = result.unwrap();
        assert!(result.success);
        assert!(!result.was_enabled);
        assert_eq!(mock.call_count(), 1);
    }

    #[tokio::test]
    async fn test_mock_cloudfront_ops_disable_failure() {
        let mock = MockCloudFrontOps::new().with_distribution("E1234567890ABC", true, false);

        let result = mock.disable_distribution("E1234567890ABC").await;

        assert!(result.is_err());
        match result.unwrap_err() {
            CloudFrontOpsError::AwsSdkError(_) => {}
            _ => panic!("Expected AwsSdkError"),
        }
        assert_eq!(mock.call_count(), 1);
    }

    #[tokio::test]
    async fn test_mock_cloudfront_ops_disable_not_found() {
        let mock = MockCloudFrontOps::new();

        let result = mock.disable_distribution("E-nonexistent").await;

        assert!(result.is_err());
        match result.unwrap_err() {
            CloudFrontOpsError::DistributionNotFound(id) => {
                assert_eq!(id, "E-nonexistent");
            }
            _ => panic!("Expected DistributionNotFound"),
        }
    }
}
