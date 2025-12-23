//! EC2操作モジュール
//!
//! Shutdown/Recovery Lambdaで使用するEC2インスタンスの制御操作を提供する。
//! - インスタンスの停止
//! - インスタンスの起動
//! - インスタンス状態の確認
//!
//! 要件: 3.6, 4.4

use async_trait::async_trait;
use aws_sdk_ec2::Client as Ec2Client;
use thiserror::Error;
use tracing::{info, warn};

/// EC2操作のエラー型
#[derive(Debug, Error)]
pub enum Ec2OpsError {
    /// AWS SDK エラー
    #[error("AWS EC2 APIエラー: {0}")]
    AwsSdkError(String),
    /// インスタンスが見つからない
    #[error("インスタンスが見つかりません: {0}")]
    InstanceNotFound(String),
    /// 操作タイムアウト
    #[error("操作タイムアウト: {0}")]
    OperationTimeout(String),
}

/// EC2インスタンス状態
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstanceState {
    /// 起動中
    Pending,
    /// 実行中
    Running,
    /// 停止中
    Stopping,
    /// 停止済み
    Stopped,
    /// シャットダウン中
    ShuttingDown,
    /// 終了済み
    Terminated,
    /// 不明
    Unknown(String),
}

impl From<&str> for InstanceState {
    fn from(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "pending" => InstanceState::Pending,
            "running" => InstanceState::Running,
            "stopping" => InstanceState::Stopping,
            "stopped" => InstanceState::Stopped,
            "shutting-down" => InstanceState::ShuttingDown,
            "terminated" => InstanceState::Terminated,
            _ => InstanceState::Unknown(s.to_string()),
        }
    }
}

impl std::fmt::Display for InstanceState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InstanceState::Pending => write!(f, "pending"),
            InstanceState::Running => write!(f, "running"),
            InstanceState::Stopping => write!(f, "stopping"),
            InstanceState::Stopped => write!(f, "stopped"),
            InstanceState::ShuttingDown => write!(f, "shutting-down"),
            InstanceState::Terminated => write!(f, "terminated"),
            InstanceState::Unknown(s) => write!(f, "{}", s),
        }
    }
}

/// EC2インスタンス停止結果
#[derive(Debug, Clone)]
pub struct StopInstanceResult {
    /// インスタンスID
    pub instance_id: String,
    /// 成功したかどうか
    pub success: bool,
    /// 以前の状態
    pub previous_state: InstanceState,
    /// 現在の状態
    pub current_state: InstanceState,
    /// 結果メッセージ
    pub message: String,
}

/// EC2インスタンス起動結果
#[derive(Debug, Clone)]
pub struct StartInstanceResult {
    /// インスタンスID
    pub instance_id: String,
    /// 成功したかどうか
    pub success: bool,
    /// 以前の状態
    pub previous_state: InstanceState,
    /// 現在の状態
    pub current_state: InstanceState,
    /// 結果メッセージ
    pub message: String,
}

impl StopInstanceResult {
    /// 成功結果を作成
    pub fn success(
        instance_id: impl Into<String>,
        previous_state: InstanceState,
        current_state: InstanceState,
    ) -> Self {
        let id = instance_id.into();
        let message = format!(
            "インスタンス {} を停止しました ({} -> {})",
            id, previous_state, current_state
        );
        Self {
            instance_id: id,
            success: true,
            previous_state,
            current_state,
            message,
        }
    }

    /// 失敗結果を作成
    pub fn failure(instance_id: impl Into<String>, error: impl std::fmt::Display) -> Self {
        let id = instance_id.into();
        let message = format!("インスタンス {} の停止に失敗しました: {}", id, error);
        Self {
            instance_id: id,
            success: false,
            previous_state: InstanceState::Unknown("unknown".to_string()),
            current_state: InstanceState::Unknown("unknown".to_string()),
            message,
        }
    }
}

impl StartInstanceResult {
    /// 成功結果を作成
    pub fn success(
        instance_id: impl Into<String>,
        previous_state: InstanceState,
        current_state: InstanceState,
    ) -> Self {
        let id = instance_id.into();
        let message = format!(
            "インスタンス {} を起動しました ({} -> {})",
            id, previous_state, current_state
        );
        Self {
            instance_id: id,
            success: true,
            previous_state,
            current_state,
            message,
        }
    }

    /// 失敗結果を作成
    pub fn failure(instance_id: impl Into<String>, error: impl std::fmt::Display) -> Self {
        let id = instance_id.into();
        let message = format!("インスタンス {} の起動に失敗しました: {}", id, error);
        Self {
            instance_id: id,
            success: false,
            previous_state: InstanceState::Unknown("unknown".to_string()),
            current_state: InstanceState::Unknown("unknown".to_string()),
            message,
        }
    }
}

/// EC2操作トレイト（テスト用の抽象化）
#[async_trait]
pub trait Ec2Ops: Send + Sync {
    /// EC2インスタンスを停止する
    ///
    /// # 引数
    /// * `instance_id` - EC2インスタンスID
    ///
    /// # 戻り値
    /// * `Ok(StopInstanceResult)` - 停止結果
    /// * `Err(Ec2OpsError)` - エラー
    async fn stop_instance(&self, instance_id: &str) -> Result<StopInstanceResult, Ec2OpsError>;

    /// EC2インスタンスを起動する
    ///
    /// # 引数
    /// * `instance_id` - EC2インスタンスID
    ///
    /// # 戻り値
    /// * `Ok(StartInstanceResult)` - 起動結果
    /// * `Err(Ec2OpsError)` - エラー
    async fn start_instance(&self, instance_id: &str) -> Result<StartInstanceResult, Ec2OpsError>;

    /// EC2インスタンスの状態を取得する
    ///
    /// # 引数
    /// * `instance_id` - EC2インスタンスID
    ///
    /// # 戻り値
    /// * `Ok(InstanceState)` - インスタンス状態
    /// * `Err(Ec2OpsError)` - エラー
    async fn get_instance_state(&self, instance_id: &str) -> Result<InstanceState, Ec2OpsError>;

    /// EC2インスタンスがRunning状態になるまで待機する
    ///
    /// # 引数
    /// * `instance_id` - EC2インスタンスID
    /// * `timeout_secs` - タイムアウト秒数
    /// * `poll_interval_secs` - ポーリング間隔秒数
    ///
    /// # 戻り値
    /// * `Ok(())` - Running状態になった
    /// * `Err(Ec2OpsError)` - タイムアウトまたはエラー
    async fn wait_for_running(
        &self,
        instance_id: &str,
        timeout_secs: u64,
        poll_interval_secs: u64,
    ) -> Result<(), Ec2OpsError>;
}

/// 実際のAWS EC2 SDKを使用したEC2操作実装
pub struct AwsEc2Ops {
    client: Ec2Client,
}

impl AwsEc2Ops {
    /// 新しいAwsEc2Opsを作成
    pub fn new(client: Ec2Client) -> Self {
        Self { client }
    }

    /// AWS設定からデフォルトのクライアントを作成
    pub async fn from_config() -> Self {
        let config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
        let client = Ec2Client::new(&config);
        Self::new(client)
    }
}

#[async_trait]
impl Ec2Ops for AwsEc2Ops {
    async fn stop_instance(&self, instance_id: &str) -> Result<StopInstanceResult, Ec2OpsError> {
        info!(
            instance_id = %instance_id,
            "EC2インスタンス停止開始"
        );

        // StopInstances APIを呼び出し
        let result = self
            .client
            .stop_instances()
            .instance_ids(instance_id)
            .send()
            .await;

        match result {
            Ok(response) => {
                // StoppingInstancesから結果を取得
                if let Some(instance_change) = response.stopping_instances().first() {
                    let previous_state = instance_change
                        .previous_state()
                        .and_then(|s| s.name())
                        .map(|n| InstanceState::from(n.as_str()))
                        .unwrap_or(InstanceState::Unknown("unknown".to_string()));

                    let current_state = instance_change
                        .current_state()
                        .and_then(|s| s.name())
                        .map(|n| InstanceState::from(n.as_str()))
                        .unwrap_or(InstanceState::Unknown("unknown".to_string()));

                    info!(
                        instance_id = %instance_id,
                        previous_state = %previous_state,
                        current_state = %current_state,
                        "StopInstances成功"
                    );

                    Ok(StopInstanceResult::success(
                        instance_id,
                        previous_state,
                        current_state,
                    ))
                } else {
                    warn!(
                        instance_id = %instance_id,
                        "StopInstances応答にインスタンス情報が含まれていません"
                    );
                    Err(Ec2OpsError::InstanceNotFound(instance_id.to_string()))
                }
            }
            Err(err) => {
                warn!(
                    instance_id = %instance_id,
                    error = %err,
                    "StopInstancesエラー"
                );
                Err(Ec2OpsError::AwsSdkError(err.to_string()))
            }
        }
    }

    async fn start_instance(&self, instance_id: &str) -> Result<StartInstanceResult, Ec2OpsError> {
        info!(
            instance_id = %instance_id,
            "EC2インスタンス起動開始"
        );

        // StartInstances APIを呼び出し
        let result = self
            .client
            .start_instances()
            .instance_ids(instance_id)
            .send()
            .await;

        match result {
            Ok(response) => {
                // StartingInstancesから結果を取得
                if let Some(instance_change) = response.starting_instances().first() {
                    let previous_state = instance_change
                        .previous_state()
                        .and_then(|s| s.name())
                        .map(|n| InstanceState::from(n.as_str()))
                        .unwrap_or(InstanceState::Unknown("unknown".to_string()));

                    let current_state = instance_change
                        .current_state()
                        .and_then(|s| s.name())
                        .map(|n| InstanceState::from(n.as_str()))
                        .unwrap_or(InstanceState::Unknown("unknown".to_string()));

                    info!(
                        instance_id = %instance_id,
                        previous_state = %previous_state,
                        current_state = %current_state,
                        "StartInstances成功"
                    );

                    Ok(StartInstanceResult::success(
                        instance_id,
                        previous_state,
                        current_state,
                    ))
                } else {
                    warn!(
                        instance_id = %instance_id,
                        "StartInstances応答にインスタンス情報が含まれていません"
                    );
                    Err(Ec2OpsError::InstanceNotFound(instance_id.to_string()))
                }
            }
            Err(err) => {
                warn!(
                    instance_id = %instance_id,
                    error = %err,
                    "StartInstancesエラー"
                );
                Err(Ec2OpsError::AwsSdkError(err.to_string()))
            }
        }
    }

    async fn get_instance_state(&self, instance_id: &str) -> Result<InstanceState, Ec2OpsError> {
        let result = self
            .client
            .describe_instances()
            .instance_ids(instance_id)
            .send()
            .await;

        match result {
            Ok(response) => {
                // レスポンスからインスタンス状態を取得
                let state = response
                    .reservations()
                    .first()
                    .and_then(|r| r.instances().first())
                    .and_then(|i| i.state())
                    .and_then(|s| s.name())
                    .map(|n| InstanceState::from(n.as_str()));

                match state {
                    Some(state) => {
                        info!(
                            instance_id = %instance_id,
                            state = %state,
                            "インスタンス状態取得成功"
                        );
                        Ok(state)
                    }
                    None => {
                        warn!(
                            instance_id = %instance_id,
                            "インスタンスが見つかりません"
                        );
                        Err(Ec2OpsError::InstanceNotFound(instance_id.to_string()))
                    }
                }
            }
            Err(err) => {
                warn!(
                    instance_id = %instance_id,
                    error = %err,
                    "DescribeInstancesエラー"
                );
                Err(Ec2OpsError::AwsSdkError(err.to_string()))
            }
        }
    }

    async fn wait_for_running(
        &self,
        instance_id: &str,
        timeout_secs: u64,
        poll_interval_secs: u64,
    ) -> Result<(), Ec2OpsError> {
        use std::time::{Duration, Instant};

        let start = Instant::now();
        let timeout = Duration::from_secs(timeout_secs);
        let poll_interval = Duration::from_secs(poll_interval_secs);

        info!(
            instance_id = %instance_id,
            timeout_secs = timeout_secs,
            poll_interval_secs = poll_interval_secs,
            "EC2インスタンスRunning状態待機開始"
        );

        loop {
            // 現在の状態を取得
            let state = self.get_instance_state(instance_id).await?;

            match &state {
                InstanceState::Running => {
                    info!(
                        instance_id = %instance_id,
                        elapsed_secs = start.elapsed().as_secs(),
                        "EC2インスタンスがRunning状態になりました"
                    );
                    return Ok(());
                }
                // 異常状態への遷移を検出して早期終了
                InstanceState::ShuttingDown | InstanceState::Terminated => {
                    let message = format!(
                        "インスタンスが異常状態に遷移しました: {}",
                        state
                    );
                    warn!(
                        instance_id = %instance_id,
                        current_state = %state,
                        "EC2インスタンスが復旧不可能な状態に遷移"
                    );
                    return Err(Ec2OpsError::AwsSdkError(message));
                }
                // Pending, Stopping, Stopped, Unknownは待機継続
                _ => {}
            }

            // タイムアウトチェック
            if start.elapsed() > timeout {
                let message = format!(
                    "タイムアウト({}秒): 現在の状態={}",
                    timeout_secs, state
                );
                warn!(
                    instance_id = %instance_id,
                    elapsed_secs = start.elapsed().as_secs(),
                    current_state = %state,
                    "EC2インスタンスRunning状態待機タイムアウト"
                );
                return Err(Ec2OpsError::OperationTimeout(message));
            }

            info!(
                instance_id = %instance_id,
                current_state = %state,
                elapsed_secs = start.elapsed().as_secs(),
                "Running状態待機中..."
            );

            // 次のポーリングまで待機
            tokio::time::sleep(poll_interval).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use std::sync::Mutex;

    /// インスタンス設定（状態、操作成功フラグ、状態遷移シーケンス）
    struct InstanceConfig {
        /// 現在の状態
        state: InstanceState,
        /// 操作成功フラグ
        success: bool,
        /// 状態遷移シーケンス（get_instance_state呼び出しごとに次の状態に遷移）
        state_sequence: Vec<InstanceState>,
        /// シーケンスのインデックス
        sequence_index: usize,
    }

    /// テスト用のモックEC2操作
    struct MockEc2Ops {
        /// インスタンスIDに対応する設定
        instances: Mutex<std::collections::HashMap<String, InstanceConfig>>,
        /// stop_instance呼び出し回数
        stop_call_count: Arc<AtomicUsize>,
        /// start_instance呼び出し回数
        start_call_count: Arc<AtomicUsize>,
        /// get_instance_state呼び出し回数
        get_state_call_count: Arc<AtomicUsize>,
        /// wait_for_running呼び出し回数
        wait_call_count: Arc<AtomicUsize>,
    }

    impl MockEc2Ops {
        fn new() -> Self {
            Self {
                instances: Mutex::new(std::collections::HashMap::new()),
                stop_call_count: Arc::new(AtomicUsize::new(0)),
                start_call_count: Arc::new(AtomicUsize::new(0)),
                get_state_call_count: Arc::new(AtomicUsize::new(0)),
                wait_call_count: Arc::new(AtomicUsize::new(0)),
            }
        }

        fn with_instance(
            self,
            instance_id: impl Into<String>,
            state: InstanceState,
            success: bool,
        ) -> Self {
            let mut instances = self.instances.lock().unwrap();
            instances.insert(
                instance_id.into(),
                InstanceConfig {
                    state,
                    success,
                    state_sequence: Vec::new(),
                    sequence_index: 0,
                },
            );
            drop(instances);
            self
        }

        /// 状態遷移シーケンスを設定（get_instance_state呼び出しごとに次の状態に遷移）
        fn with_state_sequence(
            self,
            instance_id: impl Into<String>,
            sequence: Vec<InstanceState>,
        ) -> Self {
            let id = instance_id.into();
            let mut instances = self.instances.lock().unwrap();
            if let Some(config) = instances.get_mut(&id) {
                config.state_sequence = sequence;
            }
            drop(instances);
            self
        }

        fn stop_call_count(&self) -> usize {
            self.stop_call_count.load(Ordering::SeqCst)
        }

        fn start_call_count(&self) -> usize {
            self.start_call_count.load(Ordering::SeqCst)
        }

        fn get_state_call_count(&self) -> usize {
            self.get_state_call_count.load(Ordering::SeqCst)
        }

        #[allow(dead_code)]
        fn wait_call_count(&self) -> usize {
            self.wait_call_count.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl Ec2Ops for MockEc2Ops {
        async fn stop_instance(
            &self,
            instance_id: &str,
        ) -> Result<StopInstanceResult, Ec2OpsError> {
            self.stop_call_count.fetch_add(1, Ordering::SeqCst);

            let instances = self.instances.lock().unwrap();
            match instances.get(instance_id) {
                Some(config) if config.success => Ok(StopInstanceResult::success(
                    instance_id,
                    config.state.clone(),
                    InstanceState::Stopping,
                )),
                Some(_) => Err(Ec2OpsError::AwsSdkError("mock error".to_string())),
                None => Err(Ec2OpsError::InstanceNotFound(instance_id.to_string())),
            }
        }

        async fn start_instance(
            &self,
            instance_id: &str,
        ) -> Result<StartInstanceResult, Ec2OpsError> {
            self.start_call_count.fetch_add(1, Ordering::SeqCst);

            let instances = self.instances.lock().unwrap();
            match instances.get(instance_id) {
                Some(config) if config.success => Ok(StartInstanceResult::success(
                    instance_id,
                    config.state.clone(),
                    InstanceState::Pending,
                )),
                Some(_) => Err(Ec2OpsError::AwsSdkError("mock error".to_string())),
                None => Err(Ec2OpsError::InstanceNotFound(instance_id.to_string())),
            }
        }

        async fn get_instance_state(
            &self,
            instance_id: &str,
        ) -> Result<InstanceState, Ec2OpsError> {
            self.get_state_call_count.fetch_add(1, Ordering::SeqCst);

            let mut instances = self.instances.lock().unwrap();
            match instances.get_mut(instance_id) {
                Some(config) => {
                    // シーケンスがある場合は次の状態を返す
                    if !config.state_sequence.is_empty()
                        && config.sequence_index < config.state_sequence.len()
                    {
                        let state = config.state_sequence[config.sequence_index].clone();
                        config.sequence_index += 1;
                        Ok(state)
                    } else if !config.state_sequence.is_empty() {
                        // シーケンスの最後を返し続ける
                        Ok(config.state_sequence.last().unwrap().clone())
                    } else {
                        Ok(config.state.clone())
                    }
                }
                None => Err(Ec2OpsError::InstanceNotFound(instance_id.to_string())),
            }
        }

        async fn wait_for_running(
            &self,
            instance_id: &str,
            _timeout_secs: u64,
            _poll_interval_secs: u64,
        ) -> Result<(), Ec2OpsError> {
            self.wait_call_count.fetch_add(1, Ordering::SeqCst);

            let instances = self.instances.lock().unwrap();
            match instances.get(instance_id) {
                Some(config) if config.success => Ok(()),
                Some(_) => Err(Ec2OpsError::OperationTimeout(
                    "mock timeout".to_string(),
                )),
                None => Err(Ec2OpsError::InstanceNotFound(instance_id.to_string())),
            }
        }
    }

    // ==================== InstanceState テスト ====================

    #[test]
    fn test_instance_state_from_str() {
        assert_eq!(InstanceState::from("pending"), InstanceState::Pending);
        assert_eq!(InstanceState::from("running"), InstanceState::Running);
        assert_eq!(InstanceState::from("stopping"), InstanceState::Stopping);
        assert_eq!(InstanceState::from("stopped"), InstanceState::Stopped);
        assert_eq!(
            InstanceState::from("shutting-down"),
            InstanceState::ShuttingDown
        );
        assert_eq!(InstanceState::from("terminated"), InstanceState::Terminated);
        // 大文字小文字を区別しない
        assert_eq!(InstanceState::from("Running"), InstanceState::Running);
        assert_eq!(InstanceState::from("STOPPED"), InstanceState::Stopped);
        // 不明な状態
        assert!(matches!(
            InstanceState::from("unknown-state"),
            InstanceState::Unknown(_)
        ));
    }

    #[test]
    fn test_instance_state_display() {
        assert_eq!(format!("{}", InstanceState::Running), "running");
        assert_eq!(format!("{}", InstanceState::Stopped), "stopped");
        assert_eq!(format!("{}", InstanceState::Stopping), "stopping");
        assert_eq!(
            format!("{}", InstanceState::Unknown("test".to_string())),
            "test"
        );
    }

    // ==================== StopInstanceResult テスト ====================

    #[test]
    fn test_stop_instance_result_success() {
        let result = StopInstanceResult::success(
            "i-1234567890",
            InstanceState::Running,
            InstanceState::Stopping,
        );

        assert_eq!(result.instance_id, "i-1234567890");
        assert!(result.success);
        assert_eq!(result.previous_state, InstanceState::Running);
        assert_eq!(result.current_state, InstanceState::Stopping);
        assert!(result.message.contains("i-1234567890"));
        assert!(result.message.contains("running"));
        assert!(result.message.contains("stopping"));
    }

    #[test]
    fn test_stop_instance_result_failure() {
        let result = StopInstanceResult::failure("i-1234567890", "API error");

        assert_eq!(result.instance_id, "i-1234567890");
        assert!(!result.success);
        assert!(result.message.contains("i-1234567890"));
        assert!(result.message.contains("失敗"));
        assert!(result.message.contains("API error"));
    }

    // ==================== StartInstanceResult テスト ====================

    #[test]
    fn test_start_instance_result_success() {
        let result = StartInstanceResult::success(
            "i-1234567890",
            InstanceState::Stopped,
            InstanceState::Pending,
        );

        assert_eq!(result.instance_id, "i-1234567890");
        assert!(result.success);
        assert_eq!(result.previous_state, InstanceState::Stopped);
        assert_eq!(result.current_state, InstanceState::Pending);
        assert!(result.message.contains("i-1234567890"));
        assert!(result.message.contains("起動"));
        assert!(result.message.contains("stopped"));
        assert!(result.message.contains("pending"));
    }

    #[test]
    fn test_start_instance_result_failure() {
        let result = StartInstanceResult::failure("i-1234567890", "API error");

        assert_eq!(result.instance_id, "i-1234567890");
        assert!(!result.success);
        assert!(result.message.contains("i-1234567890"));
        assert!(result.message.contains("起動"));
        assert!(result.message.contains("失敗"));
        assert!(result.message.contains("API error"));
    }

    // ==================== Ec2OpsError テスト ====================

    #[test]
    fn test_ec2_ops_error_display() {
        let sdk_error = Ec2OpsError::AwsSdkError("API呼び出し失敗".to_string());
        assert_eq!(sdk_error.to_string(), "AWS EC2 APIエラー: API呼び出し失敗");

        let not_found = Ec2OpsError::InstanceNotFound("i-123".to_string());
        assert_eq!(not_found.to_string(), "インスタンスが見つかりません: i-123");

        let timeout = Ec2OpsError::OperationTimeout("60秒".to_string());
        assert_eq!(timeout.to_string(), "操作タイムアウト: 60秒");
    }

    // ==================== MockEc2Ops テスト ====================

    #[tokio::test]
    async fn test_mock_ec2_ops_stop_success() {
        let mock = MockEc2Ops::new().with_instance("i-1234567890", InstanceState::Running, true);

        let result = mock.stop_instance("i-1234567890").await;

        assert!(result.is_ok());
        let result = result.unwrap();
        assert!(result.success);
        assert_eq!(result.previous_state, InstanceState::Running);
        assert_eq!(result.current_state, InstanceState::Stopping);
        assert_eq!(mock.stop_call_count(), 1);
    }

    #[tokio::test]
    async fn test_mock_ec2_ops_stop_failure() {
        let mock = MockEc2Ops::new().with_instance("i-1234567890", InstanceState::Running, false);

        let result = mock.stop_instance("i-1234567890").await;

        assert!(result.is_err());
        match result.unwrap_err() {
            Ec2OpsError::AwsSdkError(_) => {}
            _ => panic!("Expected AwsSdkError"),
        }
        assert_eq!(mock.stop_call_count(), 1);
    }

    #[tokio::test]
    async fn test_mock_ec2_ops_stop_not_found() {
        let mock = MockEc2Ops::new();

        let result = mock.stop_instance("i-nonexistent").await;

        assert!(result.is_err());
        match result.unwrap_err() {
            Ec2OpsError::InstanceNotFound(id) => {
                assert_eq!(id, "i-nonexistent");
            }
            _ => panic!("Expected InstanceNotFound"),
        }
    }

    #[tokio::test]
    async fn test_mock_ec2_ops_get_state() {
        let mock = MockEc2Ops::new().with_instance("i-1234567890", InstanceState::Running, true);

        let result = mock.get_instance_state("i-1234567890").await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), InstanceState::Running);
        assert_eq!(mock.get_state_call_count(), 1);
    }

    #[tokio::test]
    async fn test_mock_ec2_ops_get_state_not_found() {
        let mock = MockEc2Ops::new();

        let result = mock.get_instance_state("i-nonexistent").await;

        assert!(result.is_err());
        match result.unwrap_err() {
            Ec2OpsError::InstanceNotFound(id) => {
                assert_eq!(id, "i-nonexistent");
            }
            _ => panic!("Expected InstanceNotFound"),
        }
    }

    // ==================== MockEc2Ops start_instance テスト ====================

    #[tokio::test]
    async fn test_mock_ec2_ops_start_success() {
        let mock = MockEc2Ops::new().with_instance("i-1234567890", InstanceState::Stopped, true);

        let result = mock.start_instance("i-1234567890").await;

        assert!(result.is_ok());
        let result = result.unwrap();
        assert!(result.success);
        assert_eq!(result.previous_state, InstanceState::Stopped);
        assert_eq!(result.current_state, InstanceState::Pending);
        assert_eq!(mock.start_call_count(), 1);
    }

    #[tokio::test]
    async fn test_mock_ec2_ops_start_failure() {
        let mock = MockEc2Ops::new().with_instance("i-1234567890", InstanceState::Stopped, false);

        let result = mock.start_instance("i-1234567890").await;

        assert!(result.is_err());
        match result.unwrap_err() {
            Ec2OpsError::AwsSdkError(_) => {}
            _ => panic!("Expected AwsSdkError"),
        }
        assert_eq!(mock.start_call_count(), 1);
    }

    #[tokio::test]
    async fn test_mock_ec2_ops_start_not_found() {
        let mock = MockEc2Ops::new();

        let result = mock.start_instance("i-nonexistent").await;

        assert!(result.is_err());
        match result.unwrap_err() {
            Ec2OpsError::InstanceNotFound(id) => {
                assert_eq!(id, "i-nonexistent");
            }
            _ => panic!("Expected InstanceNotFound"),
        }
    }

    // ==================== MockEc2Ops wait_for_running テスト ====================

    #[tokio::test]
    async fn test_mock_ec2_ops_wait_for_running_success() {
        let mock = MockEc2Ops::new().with_instance("i-1234567890", InstanceState::Stopped, true);

        let result = mock.wait_for_running("i-1234567890", 120, 5).await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_mock_ec2_ops_wait_for_running_timeout() {
        let mock = MockEc2Ops::new().with_instance("i-1234567890", InstanceState::Stopped, false);

        let result = mock.wait_for_running("i-1234567890", 120, 5).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            Ec2OpsError::OperationTimeout(_) => {}
            _ => panic!("Expected OperationTimeout"),
        }
    }

    // ==================== MockEc2Ops 状態遷移シーケンステスト ====================

    #[tokio::test]
    async fn test_mock_ec2_ops_state_sequence() {
        let mock = MockEc2Ops::new()
            .with_instance("i-1234567890", InstanceState::Stopped, true)
            .with_state_sequence(
                "i-1234567890",
                vec![
                    InstanceState::Pending,
                    InstanceState::Pending,
                    InstanceState::Running,
                ],
            );

        // 最初の呼び出し: Pending
        let state = mock.get_instance_state("i-1234567890").await.unwrap();
        assert_eq!(state, InstanceState::Pending);

        // 2回目の呼び出し: Pending
        let state = mock.get_instance_state("i-1234567890").await.unwrap();
        assert_eq!(state, InstanceState::Pending);

        // 3回目の呼び出し: Running
        let state = mock.get_instance_state("i-1234567890").await.unwrap();
        assert_eq!(state, InstanceState::Running);

        // 4回目以降: Running（最後の状態を維持）
        let state = mock.get_instance_state("i-1234567890").await.unwrap();
        assert_eq!(state, InstanceState::Running);
    }
}
