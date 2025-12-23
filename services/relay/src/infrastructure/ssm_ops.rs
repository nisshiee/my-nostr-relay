//! SSM操作モジュール
//!
//! Shutdown Lambdaで使用するSSM Run Command操作を提供する。
//! - EC2インスタンス上でsystemctl stopコマンドを実行
//! - コマンド完了を待機
//!
//! 要件: 3.4

use async_trait::async_trait;
use aws_sdk_ssm::Client as SsmClient;
use thiserror::Error;
use tracing::{info, warn};

/// SSM操作のエラー型
#[derive(Debug, Error)]
pub enum SsmOpsError {
    /// AWS SDK エラー
    #[error("AWS SSM APIエラー: {0}")]
    AwsSdkError(String),
    /// コマンドタイムアウト
    #[error("コマンドタイムアウト: {0}")]
    CommandTimeout(String),
    /// コマンド実行失敗
    #[error("コマンド実行失敗: {0}")]
    CommandFailed(String),
}

/// SSM Run Command実行結果
#[derive(Debug, Clone)]
pub struct RunCommandResult {
    /// コマンドID
    pub command_id: String,
    /// 成功したかどうか
    pub success: bool,
    /// 結果メッセージ
    pub message: String,
}

impl RunCommandResult {
    /// 成功結果を作成
    pub fn success(command_id: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            command_id: command_id.into(),
            success: true,
            message: message.into(),
        }
    }

    /// 失敗結果を作成
    pub fn failure(command_id: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            command_id: command_id.into(),
            success: false,
            message: message.into(),
        }
    }
}

/// SSM操作トレイト（テスト用の抽象化）
#[async_trait]
pub trait SsmOps: Send + Sync {
    /// EC2インスタンス上でsystemctlコマンドを実行してサービスを停止する
    ///
    /// # 引数
    /// * `instance_id` - EC2インスタンスID
    /// * `service_name` - systemdサービス名
    ///
    /// # 戻り値
    /// * `Ok(RunCommandResult)` - コマンド実行結果
    /// * `Err(SsmOpsError)` - エラー
    async fn stop_systemd_service(
        &self,
        instance_id: &str,
        service_name: &str,
    ) -> Result<RunCommandResult, SsmOpsError>;
}

/// 実際のAWS SSM SDKを使用したSSM操作実装
pub struct AwsSsmOps {
    client: SsmClient,
    /// コマンド完了待機のタイムアウト秒数
    timeout_seconds: u64,
    /// ポーリング間隔秒数
    poll_interval_seconds: u64,
}

impl AwsSsmOps {
    /// 新しいAwsSsmOpsを作成
    pub fn new(client: SsmClient) -> Self {
        Self {
            client,
            timeout_seconds: 60,
            poll_interval_seconds: 5,
        }
    }

    /// タイムアウトを設定
    pub fn with_timeout(mut self, timeout_seconds: u64) -> Self {
        self.timeout_seconds = timeout_seconds;
        self
    }

    /// ポーリング間隔を設定
    pub fn with_poll_interval(mut self, poll_interval_seconds: u64) -> Self {
        self.poll_interval_seconds = poll_interval_seconds;
        self
    }

    /// AWS設定からデフォルトのクライアントを作成
    pub async fn from_config() -> Self {
        let config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
        let client = SsmClient::new(&config);
        Self::new(client)
    }

    /// コマンドの完了を待機する
    async fn wait_for_command(
        &self,
        command_id: &str,
        instance_id: &str,
    ) -> Result<RunCommandResult, SsmOpsError> {
        let start_time = std::time::Instant::now();
        let timeout = std::time::Duration::from_secs(self.timeout_seconds);
        let poll_interval = std::time::Duration::from_secs(self.poll_interval_seconds);

        loop {
            // タイムアウトチェック
            if start_time.elapsed() > timeout {
                return Err(SsmOpsError::CommandTimeout(format!(
                    "コマンド {} が {}秒以内に完了しませんでした",
                    command_id, self.timeout_seconds
                )));
            }

            // コマンドステータスを確認
            let invocation_result = self
                .client
                .get_command_invocation()
                .command_id(command_id)
                .instance_id(instance_id)
                .send()
                .await;

            match invocation_result {
                Ok(response) => {
                    let status = response
                        .status()
                        .map(|s| s.as_str())
                        .unwrap_or("Unknown");

                    info!(
                        command_id = %command_id,
                        instance_id = %instance_id,
                        status = %status,
                        "コマンドステータス確認"
                    );

                    match status {
                        "Success" => {
                            let output = response
                                .standard_output_content()
                                .unwrap_or("")
                                .to_string();
                            return Ok(RunCommandResult::success(
                                command_id,
                                format!("コマンド完了: {}", output.trim()),
                            ));
                        }
                        "Failed" | "Cancelled" | "TimedOut" => {
                            let error_output = response
                                .standard_error_content()
                                .unwrap_or("")
                                .to_string();
                            return Err(SsmOpsError::CommandFailed(format!(
                                "コマンド {}: {} - {}",
                                status,
                                command_id,
                                error_output.trim()
                            )));
                        }
                        "Pending" | "InProgress" | "Delayed" => {
                            // まだ完了していない、待機継続
                        }
                        _ => {
                            // 不明なステータス、待機継続
                            warn!(
                                command_id = %command_id,
                                status = %status,
                                "不明なコマンドステータス"
                            );
                        }
                    }
                }
                Err(err) => {
                    // InvocationDoesNotExistエラーの場合は少し待って再試行
                    // （コマンド送信直後はinvocationがまだ作成されていない可能性がある）
                    let err_str = err.to_string();
                    if err_str.contains("InvocationDoesNotExist") {
                        info!(
                            command_id = %command_id,
                            "コマンドinvocationがまだ作成されていません、待機中..."
                        );
                    } else {
                        warn!(
                            command_id = %command_id,
                            error = %err,
                            "GetCommandInvocationエラー"
                        );
                    }
                }
            }

            // 次のポーリングまで待機
            tokio::time::sleep(poll_interval).await;
        }
    }
}

#[async_trait]
impl SsmOps for AwsSsmOps {
    async fn stop_systemd_service(
        &self,
        instance_id: &str,
        service_name: &str,
    ) -> Result<RunCommandResult, SsmOpsError> {
        let command = format!("systemctl stop {}", service_name);

        info!(
            instance_id = %instance_id,
            service_name = %service_name,
            command = %command,
            "SSM Run Command実行開始"
        );

        // SendCommand APIを呼び出し
        let send_result = self
            .client
            .send_command()
            .document_name("AWS-RunShellScript")
            .instance_ids(instance_id)
            .parameters("commands", vec![command.clone()])
            .timeout_seconds(60)
            .send()
            .await;

        match send_result {
            Ok(response) => {
                let command_id = response
                    .command()
                    .and_then(|c| c.command_id())
                    .ok_or_else(|| {
                        SsmOpsError::AwsSdkError("コマンドIDを取得できませんでした".to_string())
                    })?
                    .to_string();

                info!(
                    command_id = %command_id,
                    instance_id = %instance_id,
                    "SendCommand成功、完了待機中..."
                );

                // コマンド完了を待機
                self.wait_for_command(&command_id, instance_id).await
            }
            Err(err) => {
                warn!(
                    instance_id = %instance_id,
                    error = %err,
                    "SendCommandエラー"
                );
                Err(SsmOpsError::AwsSdkError(err.to_string()))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// テスト用のモックSSM操作
    struct MockSsmOps {
        /// 成功させるインスタンスIDとサービス名のペア
        success_pairs: Vec<(String, String)>,
        /// stop_systemd_service呼び出し回数
        call_count: Arc<AtomicUsize>,
        /// 返すコマンドID
        command_id: String,
    }

    impl MockSsmOps {
        fn new(success_pairs: Vec<(String, String)>) -> Self {
            Self {
                success_pairs,
                call_count: Arc::new(AtomicUsize::new(0)),
                command_id: "test-command-id".to_string(),
            }
        }

        fn with_command_id(mut self, command_id: impl Into<String>) -> Self {
            self.command_id = command_id.into();
            self
        }

        fn call_count(&self) -> usize {
            self.call_count.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl SsmOps for MockSsmOps {
        async fn stop_systemd_service(
            &self,
            instance_id: &str,
            service_name: &str,
        ) -> Result<RunCommandResult, SsmOpsError> {
            self.call_count.fetch_add(1, Ordering::SeqCst);

            let pair = (instance_id.to_string(), service_name.to_string());
            if self.success_pairs.contains(&pair) {
                Ok(RunCommandResult::success(
                    &self.command_id,
                    format!("サービス {} を停止しました", service_name),
                ))
            } else {
                Err(SsmOpsError::CommandFailed(format!(
                    "サービス {} の停止に失敗しました",
                    service_name
                )))
            }
        }
    }

    // ==================== RunCommandResult テスト ====================

    #[test]
    fn test_run_command_result_success() {
        let result = RunCommandResult::success("cmd-123", "コマンド完了");

        assert_eq!(result.command_id, "cmd-123");
        assert!(result.success);
        assert_eq!(result.message, "コマンド完了");
    }

    #[test]
    fn test_run_command_result_failure() {
        let result = RunCommandResult::failure("cmd-456", "コマンド失敗");

        assert_eq!(result.command_id, "cmd-456");
        assert!(!result.success);
        assert_eq!(result.message, "コマンド失敗");
    }

    // ==================== SsmOpsError テスト ====================

    #[test]
    fn test_ssm_ops_error_display() {
        let sdk_error = SsmOpsError::AwsSdkError("API呼び出し失敗".to_string());
        assert_eq!(sdk_error.to_string(), "AWS SSM APIエラー: API呼び出し失敗");

        let timeout_error = SsmOpsError::CommandTimeout("60秒".to_string());
        assert_eq!(timeout_error.to_string(), "コマンドタイムアウト: 60秒");

        let failed_error = SsmOpsError::CommandFailed("exit code 1".to_string());
        assert_eq!(failed_error.to_string(), "コマンド実行失敗: exit code 1");
    }

    // ==================== MockSsmOps テスト ====================

    #[tokio::test]
    async fn test_mock_ssm_ops_success() {
        let mock = MockSsmOps::new(vec![(
            "i-1234567890".to_string(),
            "nostr-api".to_string(),
        )])
        .with_command_id("cmd-abc123");

        let result = mock
            .stop_systemd_service("i-1234567890", "nostr-api")
            .await;

        assert!(result.is_ok());
        let result = result.unwrap();
        assert!(result.success);
        assert_eq!(result.command_id, "cmd-abc123");
        assert!(result.message.contains("nostr-api"));
        assert_eq!(mock.call_count(), 1);
    }

    #[tokio::test]
    async fn test_mock_ssm_ops_failure() {
        let mock = MockSsmOps::new(vec![]); // 成功するペアなし

        let result = mock
            .stop_systemd_service("i-1234567890", "nostr-api")
            .await;

        assert!(result.is_err());
        match result.unwrap_err() {
            SsmOpsError::CommandFailed(msg) => {
                assert!(msg.contains("nostr-api"));
            }
            _ => panic!("Expected CommandFailed error"),
        }
        assert_eq!(mock.call_count(), 1);
    }

    #[tokio::test]
    async fn test_mock_ssm_ops_wrong_instance() {
        let mock = MockSsmOps::new(vec![(
            "i-1234567890".to_string(),
            "nostr-api".to_string(),
        )]);

        // 違うインスタンスIDで呼び出し
        let result = mock
            .stop_systemd_service("i-0987654321", "nostr-api")
            .await;

        assert!(result.is_err());
        assert_eq!(mock.call_count(), 1);
    }

    #[tokio::test]
    async fn test_mock_ssm_ops_wrong_service() {
        let mock = MockSsmOps::new(vec![(
            "i-1234567890".to_string(),
            "nostr-api".to_string(),
        )]);

        // 違うサービス名で呼び出し
        let result = mock
            .stop_systemd_service("i-1234567890", "other-service")
            .await;

        assert!(result.is_err());
        assert_eq!(mock.call_count(), 1);
    }
}
