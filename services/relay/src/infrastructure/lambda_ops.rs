//! Lambda操作モジュール
//!
//! Shutdown/Recovery Lambdaで使用するLambda関数の制御操作を提供する。
//! - reserved concurrencyを0に設定（無効化）
//! - reserved concurrency設定を削除（有効化）
//!
//! 要件: 3.2, 4.6

use async_trait::async_trait;
use aws_sdk_lambda::Client as LambdaClient;
use thiserror::Error;
use tracing::{info, warn};

/// Lambda操作のエラー型
#[derive(Debug, Error)]
pub enum LambdaOpsError {
    /// AWS SDK エラー
    #[error("AWS Lambda APIエラー: {0}")]
    AwsSdkError(String),
}

/// Lambda関数を無効化した結果
#[derive(Debug, Clone)]
pub struct DisableFunctionResult {
    /// 関数名
    pub function_name: String,
    /// 成功したかどうか
    pub success: bool,
    /// 結果メッセージ
    pub message: String,
}

impl DisableFunctionResult {
    /// 成功結果を作成
    pub fn success(function_name: impl Into<String>) -> Self {
        let name = function_name.into();
        Self {
            function_name: name.clone(),
            success: true,
            message: format!("{} disabled", name),
        }
    }

    /// 失敗結果を作成
    pub fn failure(function_name: impl Into<String>, error: impl std::fmt::Display) -> Self {
        let name = function_name.into();
        Self {
            function_name: name.clone(),
            success: false,
            message: format!("{} failed: {}", name, error),
        }
    }
}

/// Lambda関数を有効化した結果
#[derive(Debug, Clone)]
pub struct EnableFunctionResult {
    /// 関数名
    pub function_name: String,
    /// 成功したかどうか
    pub success: bool,
    /// 結果メッセージ
    pub message: String,
}

impl EnableFunctionResult {
    /// 成功結果を作成
    pub fn success(function_name: impl Into<String>) -> Self {
        let name = function_name.into();
        Self {
            function_name: name.clone(),
            success: true,
            message: format!("{} enabled", name),
        }
    }

    /// 失敗結果を作成
    pub fn failure(function_name: impl Into<String>, error: impl std::fmt::Display) -> Self {
        let name = function_name.into();
        Self {
            function_name: name.clone(),
            success: false,
            message: format!("{} failed: {}", name, error),
        }
    }
}

/// Lambda操作トレイト（テスト用の抽象化）
#[async_trait]
pub trait LambdaOps: Send + Sync {
    /// Lambda関数のreserved concurrencyを0に設定して無効化する
    async fn disable_function(&self, function_name: &str) -> DisableFunctionResult;

    /// Lambda関数のreserved concurrency設定を削除して有効化する
    async fn enable_function(&self, function_name: &str) -> EnableFunctionResult;

    /// 複数のLambda関数を無効化する
    ///
    /// 各関数に対してdisable_functionを呼び出し、結果を集約する。
    /// 一部の関数が失敗しても他の関数の処理は継続する（エラー継続戦略）。
    ///
    /// # 引数
    /// * `function_names` - 無効化するLambda関数名のリスト
    ///
    /// # 戻り値
    /// * `Ok(String)` - 成功メッセージ（無効化した関数数と総数）
    /// * `Err(String)` - 全て失敗した場合のエラーメッセージ
    async fn disable_functions(&self, function_names: &[String]) -> Result<String, String> {
        if function_names.is_empty() {
            return Err("無効化対象のLambda関数がありません".to_string());
        }

        let mut results = Vec::new();

        for function_name in function_names {
            let result = self.disable_function(function_name).await;
            if result.success {
                info!(
                    function_name = %function_name,
                    "Lambda関数を無効化"
                );
            } else {
                warn!(
                    function_name = %function_name,
                    error = %result.message,
                    "Lambda関数の無効化に失敗（継続）"
                );
            }
            results.push(result);
        }

        let success_count = results.iter().filter(|r| r.success).count();
        let total_count = results.len();

        if success_count == 0 {
            // 全て失敗
            let errors: Vec<String> = results.iter().map(|r| r.message.clone()).collect();
            Err(format!("全ての関数の無効化に失敗: {}", errors.join(", ")))
        } else if success_count < total_count {
            // 一部成功
            let failed: Vec<&str> = results
                .iter()
                .filter(|r| !r.success)
                .map(|r| r.function_name.as_str())
                .collect();
            Ok(format!(
                "{}/{} functions disabled (failed: {})",
                success_count,
                total_count,
                failed.join(", ")
            ))
        } else {
            // 全て成功
            Ok(format!("{} functions disabled", total_count))
        }
    }

    /// 複数のLambda関数を有効化する
    ///
    /// 各関数に対してenable_functionを呼び出し、結果を集約する。
    /// エラー発生時は即座に処理を中断する（エラー中断戦略）。
    ///
    /// # 引数
    /// * `function_names` - 有効化するLambda関数名のリスト
    ///
    /// # 戻り値
    /// * `Ok(String)` - 成功メッセージ（有効化した関数数）
    /// * `Err(String)` - エラーメッセージ（最初に失敗した関数）
    async fn enable_functions(&self, function_names: &[String]) -> Result<String, String> {
        if function_names.is_empty() {
            return Err("有効化対象のLambda関数がありません".to_string());
        }

        for function_name in function_names {
            let result = self.enable_function(function_name).await;
            if result.success {
                info!(
                    function_name = %function_name,
                    "Lambda関数を有効化"
                );
            } else {
                warn!(
                    function_name = %function_name,
                    error = %result.message,
                    "Lambda関数の有効化に失敗（中断）"
                );
                // エラー中断戦略: 最初のエラーで処理を中断
                return Err(result.message);
            }
        }

        // 全て成功
        Ok(format!("{} functions enabled", function_names.len()))
    }
}

/// 実際のAWS Lambda SDKを使用したLambda操作実装
pub struct AwsLambdaOps {
    client: LambdaClient,
}

impl AwsLambdaOps {
    /// 新しいAwsLambdaOpsを作成
    pub fn new(client: LambdaClient) -> Self {
        Self { client }
    }

    /// AWS設定からデフォルトのクライアントを作成
    pub async fn from_config() -> Self {
        let config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
        let client = LambdaClient::new(&config);
        Self::new(client)
    }
}

#[async_trait]
impl LambdaOps for AwsLambdaOps {
    async fn disable_function(&self, function_name: &str) -> DisableFunctionResult {
        // PutFunctionConcurrencyでreserved concurrencyを0に設定
        let result = self
            .client
            .put_function_concurrency()
            .function_name(function_name)
            .reserved_concurrent_executions(0)
            .send()
            .await;

        match result {
            Ok(_) => {
                info!(
                    function_name = %function_name,
                    reserved_concurrency = 0,
                    "PutFunctionConcurrency成功"
                );
                DisableFunctionResult::success(function_name)
            }
            Err(err) => {
                warn!(
                    function_name = %function_name,
                    error = %err,
                    "PutFunctionConcurrencyエラー"
                );
                DisableFunctionResult::failure(function_name, err)
            }
        }
    }

    async fn enable_function(&self, function_name: &str) -> EnableFunctionResult {
        // DeleteFunctionConcurrencyでreserved concurrency設定を削除
        let result = self
            .client
            .delete_function_concurrency()
            .function_name(function_name)
            .send()
            .await;

        match result {
            Ok(_) => {
                info!(
                    function_name = %function_name,
                    "DeleteFunctionConcurrency成功"
                );
                EnableFunctionResult::success(function_name)
            }
            Err(err) => {
                warn!(
                    function_name = %function_name,
                    error = %err,
                    "DeleteFunctionConcurrencyエラー"
                );
                EnableFunctionResult::failure(function_name, err)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// テスト用のモックLambda操作
    struct MockLambdaOps {
        /// 成功させる関数名のリスト（このリストに含まれる関数は成功）
        success_functions: Vec<String>,
        /// disable_function呼び出し回数
        disable_call_count: Arc<AtomicUsize>,
        /// enable_function呼び出し回数
        enable_call_count: Arc<AtomicUsize>,
    }

    impl MockLambdaOps {
        fn new(success_functions: Vec<String>) -> Self {
            Self {
                success_functions,
                disable_call_count: Arc::new(AtomicUsize::new(0)),
                enable_call_count: Arc::new(AtomicUsize::new(0)),
            }
        }

        fn call_count(&self) -> usize {
            self.disable_call_count.load(Ordering::SeqCst)
        }

        fn enable_call_count(&self) -> usize {
            self.enable_call_count.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl LambdaOps for MockLambdaOps {
        async fn disable_function(&self, function_name: &str) -> DisableFunctionResult {
            self.disable_call_count.fetch_add(1, Ordering::SeqCst);

            if self.success_functions.contains(&function_name.to_string()) {
                DisableFunctionResult::success(function_name)
            } else {
                DisableFunctionResult::failure(function_name, "mock error")
            }
        }

        async fn enable_function(&self, function_name: &str) -> EnableFunctionResult {
            self.enable_call_count.fetch_add(1, Ordering::SeqCst);

            if self.success_functions.contains(&function_name.to_string()) {
                EnableFunctionResult::success(function_name)
            } else {
                EnableFunctionResult::failure(function_name, "mock error")
            }
        }
    }

    // ==================== DisableFunctionResult テスト ====================

    #[test]
    fn test_disable_function_result_success() {
        let result = DisableFunctionResult::success("test-function");

        assert_eq!(result.function_name, "test-function");
        assert!(result.success);
        assert_eq!(result.message, "test-function disabled");
    }

    #[test]
    fn test_disable_function_result_failure() {
        let result = DisableFunctionResult::failure("test-function", "API error");

        assert_eq!(result.function_name, "test-function");
        assert!(!result.success);
        assert_eq!(result.message, "test-function failed: API error");
    }

    // ==================== disable_functions テスト ====================

    #[tokio::test]
    async fn test_disable_functions_empty_list() {
        let ops = MockLambdaOps::new(vec![]);
        let result = ops.disable_functions(&[]).await;

        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            "無効化対象のLambda関数がありません"
        );
    }

    #[tokio::test]
    async fn test_disable_functions_all_success() {
        let ops = MockLambdaOps::new(vec![
            "connect".to_string(),
            "disconnect".to_string(),
            "default".to_string(),
        ]);

        let function_names = vec![
            "connect".to_string(),
            "disconnect".to_string(),
            "default".to_string(),
        ];

        let result = ops.disable_functions(&function_names).await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "3 functions disabled");
        assert_eq!(ops.call_count(), 3);
    }

    #[tokio::test]
    async fn test_disable_functions_partial_failure() {
        // connectとdefaultは成功、disconnectは失敗
        let ops = MockLambdaOps::new(vec!["connect".to_string(), "default".to_string()]);

        let function_names = vec![
            "connect".to_string(),
            "disconnect".to_string(),
            "default".to_string(),
        ];

        let result = ops.disable_functions(&function_names).await;

        assert!(result.is_ok());
        let message = result.unwrap();
        assert!(message.contains("2/3 functions disabled"));
        assert!(message.contains("disconnect"));
        assert_eq!(ops.call_count(), 3);
    }

    #[tokio::test]
    async fn test_disable_functions_all_failure() {
        // 全ての関数が失敗
        let ops = MockLambdaOps::new(vec![]);

        let function_names = vec![
            "connect".to_string(),
            "disconnect".to_string(),
            "default".to_string(),
        ];

        let result = ops.disable_functions(&function_names).await;

        assert!(result.is_err());
        let error = result.unwrap_err();
        assert!(error.contains("全ての関数の無効化に失敗"));
        assert_eq!(ops.call_count(), 3);
    }

    #[tokio::test]
    async fn test_disable_functions_single_function() {
        let ops = MockLambdaOps::new(vec!["single".to_string()]);

        let function_names = vec!["single".to_string()];

        let result = ops.disable_functions(&function_names).await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "1 functions disabled");
        assert_eq!(ops.call_count(), 1);
    }

    // ==================== EnableFunctionResult テスト ====================

    #[test]
    fn test_enable_function_result_success() {
        let result = EnableFunctionResult::success("test-function");

        assert_eq!(result.function_name, "test-function");
        assert!(result.success);
        assert_eq!(result.message, "test-function enabled");
    }

    #[test]
    fn test_enable_function_result_failure() {
        let result = EnableFunctionResult::failure("test-function", "API error");

        assert_eq!(result.function_name, "test-function");
        assert!(!result.success);
        assert_eq!(result.message, "test-function failed: API error");
    }

    // ==================== enable_functions テスト ====================

    #[tokio::test]
    async fn test_enable_functions_empty_list() {
        let ops = MockLambdaOps::new(vec![]);
        let result = ops.enable_functions(&[]).await;

        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            "有効化対象のLambda関数がありません"
        );
    }

    #[tokio::test]
    async fn test_enable_functions_all_success() {
        let ops = MockLambdaOps::new(vec![
            "connect".to_string(),
            "disconnect".to_string(),
            "default".to_string(),
        ]);

        let function_names = vec![
            "connect".to_string(),
            "disconnect".to_string(),
            "default".to_string(),
        ];

        let result = ops.enable_functions(&function_names).await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "3 functions enabled");
        assert_eq!(ops.enable_call_count(), 3);
    }

    #[tokio::test]
    async fn test_enable_functions_first_failure_aborts() {
        // connectは成功、disconnectは失敗（エラー中断戦略）
        let ops = MockLambdaOps::new(vec!["connect".to_string(), "default".to_string()]);

        let function_names = vec![
            "connect".to_string(),
            "disconnect".to_string(),
            "default".to_string(),
        ];

        let result = ops.enable_functions(&function_names).await;

        // 2番目のdisconnectで失敗して中断
        assert!(result.is_err());
        let error = result.unwrap_err();
        assert!(error.contains("disconnect"));
        // エラー中断戦略: 2回呼ばれて中断（defaultは呼ばれない）
        assert_eq!(ops.enable_call_count(), 2);
    }

    #[tokio::test]
    async fn test_enable_functions_all_failure_at_first() {
        // 最初から失敗
        let ops = MockLambdaOps::new(vec![]);

        let function_names = vec![
            "connect".to_string(),
            "disconnect".to_string(),
            "default".to_string(),
        ];

        let result = ops.enable_functions(&function_names).await;

        assert!(result.is_err());
        let error = result.unwrap_err();
        assert!(error.contains("connect"));
        // エラー中断戦略: 1回目で失敗して即座に中断
        assert_eq!(ops.enable_call_count(), 1);
    }

    #[tokio::test]
    async fn test_enable_functions_single_function() {
        let ops = MockLambdaOps::new(vec!["single".to_string()]);

        let function_names = vec!["single".to_string()];

        let result = ops.enable_functions(&function_names).await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "1 functions enabled");
        assert_eq!(ops.enable_call_count(), 1);
    }
}
