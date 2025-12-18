/// Recovery Lambda関数
///
/// 月初の自動復旧または手動トリガーでサービスを復旧するLambda関数。
/// EventBridgeスケジュールまたは手動invocationからトリガーされ、以下のステップを順次実行:
/// - Step 1: EC2インスタンス状態確認（稼働中ならスキップ）
/// - Step 2: EC2インスタンス起動
/// - Step 3: sqlite-apiヘルスチェック
/// - Step 4: relay Lambda関数のreserved concurrency設定削除
/// - Step 5: CloudFrontディストリビューション有効化
///
/// エラー発生時は即座に処理を中断し、その時点の状態を通知（エラー中断戦略）。
/// 最終結果をSNSトピックに発行してSlack通知。
///
/// 要件: 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9
use lambda_runtime::{service_fn, Error, LambdaEvent};
use relay::infrastructure::{
    init_logging, AwsCloudFrontOps, AwsEc2Ops, AwsLambdaOps, AwsSnsOps, CloudFrontOps, Ec2Ops,
    HealthCheckOps, HttpHealthCheck, InstanceState, LambdaOps, RecoveryConfig, RecoveryResult,
    SnsOps, StepResult,
};
use serde_json::Value;
use tracing::{error, info, warn};

#[tokio::main]
async fn main() -> Result<(), Error> {
    // 構造化ログを初期化
    init_logging();

    // Lambda関数を初期化して実行
    let func = service_fn(handler);
    lambda_runtime::run(func).await?;
    Ok(())
}

/// Lambda関数のメインハンドラー
///
/// # 処理フロー
/// 1. 環境変数からRecoveryConfigを読み込み
/// 2. EC2インスタンス状態を確認（稼働中ならスキップ）
/// 3. 5つのステップを順次実行（エラー発生時は即座に中断）
/// 4. 結果をRecoveryResultにまとめてSNS通知
///
/// # 引数
/// * `event` - EventBridgeイベントまたは手動invocationペイロード
///
/// # 戻り値
/// 処理成功時はOk、設定エラー時はErr
async fn handler(event: LambdaEvent<Value>) -> Result<(), Error> {
    let start_time = std::time::Instant::now();

    // イベント情報をログ出力
    let event_payload = event.payload;
    info!(
        event = %serde_json::to_string_pretty(&event_payload).unwrap_or_default(),
        "Recovery Lambdaがトリガーされました"
    );

    // 設定を環境変数から読み込み
    let config = match RecoveryConfig::from_env() {
        Ok(config) => {
            info!(
                lambda_functions = ?config.relay_lambda_function_names(),
                ec2_instance_id = config.ec2_instance_id(),
                cloudfront_distribution_id = config.cloudfront_distribution_id(),
                result_sns_topic_arn = config.result_sns_topic_arn(),
                sqlite_api_endpoint = config.sqlite_api_endpoint(),
                "Recovery設定を読み込み"
            );
            config
        }
        Err(err) => {
            error!(error = %err, "Recovery設定読み込み失敗");
            // 設定が読み込めない場合は終了（通知も不可能）
            return Err(format!("Recovery設定読み込み失敗: {}", err).into());
        }
    };

    // 完了したステップを記録するベクター
    let mut completed_steps: Vec<StepResult> = Vec::new();

    // Step 1: EC2状態確認
    let step1_start = std::time::Instant::now();
    let step1_result = execute_step1_check_ec2_state(&config).await;
    let step1_duration = step1_start.elapsed().as_millis() as u64;

    match step1_result {
        Ok(Ec2CheckResult::AlreadyRunning) => {
            // サービスが既に稼働中の場合はスキップ
            let timestamp = chrono::Utc::now().to_rfc3339();
            let result = RecoveryResult::skipped(timestamp, "EC2インスタンスは既に稼働中".to_string());
            let result_json = serde_json::to_string_pretty(&result).unwrap_or_default();

            info!(
                skipped = true,
                skip_reason = "EC2インスタンスは既に稼働中",
                result = %result_json,
                "サービス稼働中のためスキップ"
            );

            // スキップ結果をSNS通知
            if let Err(err) = publish_result_to_sns(&config, &result).await {
                error!(error = %err, "結果SNS通知失敗");
            }

            return Ok(());
        }
        Ok(Ec2CheckResult::NeedsRecovery) => {
            let step = StepResult::success("ec2-check", "EC2 stopped, needs recovery", step1_duration);
            info!(
                step = "ec2-check",
                message = %step.message,
                duration_ms = step1_duration,
                "Step 1 完了: 復旧が必要"
            );
            completed_steps.push(step);
        }
        Err(err_message) => {
            // エラー発生時は即座に中断
            let timestamp = chrono::Utc::now().to_rfc3339();
            let result = RecoveryResult::error(
                timestamp,
                "ec2-check".to_string(),
                err_message.clone(),
                completed_steps,
            );

            warn!(
                step = "ec2-check",
                error = %err_message,
                duration_ms = step1_duration,
                "Step 1 失敗: 処理中断"
            );

            if let Err(err) = publish_result_to_sns(&config, &result).await {
                error!(error = %err, "結果SNS通知失敗");
            }

            return Ok(());
        }
    }

    // Step 2: EC2起動
    let step2_start = std::time::Instant::now();
    let step2_result = execute_step2_start_ec2(&config).await;
    let step2_duration = step2_start.elapsed().as_millis() as u64;

    match step2_result {
        Ok(message) => {
            let step = StepResult::success("ec2-start", message.clone(), step2_duration);
            info!(step = "ec2-start", message = %message, duration_ms = step2_duration, "Step 2 完了");
            completed_steps.push(step);
        }
        Err(err_message) => {
            let timestamp = chrono::Utc::now().to_rfc3339();
            let result = RecoveryResult::error(
                timestamp,
                "ec2-start".to_string(),
                err_message.clone(),
                completed_steps,
            );

            warn!(step = "ec2-start", error = %err_message, duration_ms = step2_duration, "Step 2 失敗: 処理中断");

            if let Err(err) = publish_result_to_sns(&config, &result).await {
                error!(error = %err, "結果SNS通知失敗");
            }

            return Ok(());
        }
    }

    // Step 3: sqlite-apiヘルスチェック
    let step3_start = std::time::Instant::now();
    let step3_result = execute_step3_health_check(&config).await;
    let step3_duration = step3_start.elapsed().as_millis() as u64;

    match step3_result {
        Ok(message) => {
            let step = StepResult::success("health-check", message.clone(), step3_duration);
            info!(step = "health-check", message = %message, duration_ms = step3_duration, "Step 3 完了");
            completed_steps.push(step);
        }
        Err(err_message) => {
            let timestamp = chrono::Utc::now().to_rfc3339();
            let result = RecoveryResult::error(
                timestamp,
                "health-check".to_string(),
                err_message.clone(),
                completed_steps,
            );

            warn!(step = "health-check", error = %err_message, duration_ms = step3_duration, "Step 3 失敗: 処理中断");

            if let Err(err) = publish_result_to_sns(&config, &result).await {
                error!(error = %err, "結果SNS通知失敗");
            }

            return Ok(());
        }
    }

    // Step 4: Lambda有効化
    let step4_start = std::time::Instant::now();
    let step4_result = execute_step4_enable_lambdas(&config).await;
    let step4_duration = step4_start.elapsed().as_millis() as u64;

    match step4_result {
        Ok(message) => {
            let step = StepResult::success("lambda-enable", message.clone(), step4_duration);
            info!(step = "lambda-enable", message = %message, duration_ms = step4_duration, "Step 4 完了");
            completed_steps.push(step);
        }
        Err(err_message) => {
            let timestamp = chrono::Utc::now().to_rfc3339();
            let result = RecoveryResult::error(
                timestamp,
                "lambda-enable".to_string(),
                err_message.clone(),
                completed_steps,
            );

            warn!(step = "lambda-enable", error = %err_message, duration_ms = step4_duration, "Step 4 失敗: 処理中断");

            if let Err(err) = publish_result_to_sns(&config, &result).await {
                error!(error = %err, "結果SNS通知失敗");
            }

            return Ok(());
        }
    }

    // Step 5: CloudFront有効化
    let step5_start = std::time::Instant::now();
    let step5_result = execute_step5_enable_cloudfront(&config).await;
    let step5_duration = step5_start.elapsed().as_millis() as u64;

    match step5_result {
        Ok(message) => {
            let step = StepResult::success("cloudfront-enable", message.clone(), step5_duration);
            info!(step = "cloudfront-enable", message = %message, duration_ms = step5_duration, "Step 5 完了");
            completed_steps.push(step);
        }
        Err(err_message) => {
            let timestamp = chrono::Utc::now().to_rfc3339();
            let result = RecoveryResult::error(
                timestamp,
                "cloudfront-enable".to_string(),
                err_message.clone(),
                completed_steps,
            );

            warn!(step = "cloudfront-enable", error = %err_message, duration_ms = step5_duration, "Step 5 失敗: 処理中断");

            if let Err(err) = publish_result_to_sns(&config, &result).await {
                error!(error = %err, "結果SNS通知失敗");
            }

            return Ok(());
        }
    }

    // 全ステップ成功
    let timestamp = chrono::Utc::now().to_rfc3339();
    let result = RecoveryResult::success(timestamp, completed_steps);
    let total_duration = start_time.elapsed().as_millis() as u64;

    let result_json = serde_json::to_string_pretty(&result).unwrap_or_default();
    info!(
        overall_success = result.overall_success,
        total_duration_ms = total_duration,
        result = %result_json,
        "全ステップ成功"
    );

    // SNS通知
    if let Err(err) = publish_result_to_sns(&config, &result).await {
        error!(error = %err, "結果SNS通知失敗");
    }

    Ok(())
}

/// EC2状態確認の結果
enum Ec2CheckResult {
    /// EC2が既に稼働中（スキップする）
    AlreadyRunning,
    /// 復旧が必要（停止中）
    NeedsRecovery,
}

/// Step 1: EC2インスタンス状態確認
///
/// DescribeInstances APIでEC2の状態を確認。
/// 既にrunning状態の場合はAlreadyRunningを返してスキップ。
///
/// # 戻り値
/// * `Ok(Ec2CheckResult)` - 確認結果
/// * `Err(String)` - エラーメッセージ
async fn execute_step1_check_ec2_state(config: &RecoveryConfig) -> Result<Ec2CheckResult, String> {
    let instance_id = config.ec2_instance_id();

    info!(
        instance_id = %instance_id,
        "Step 1: EC2状態確認開始"
    );

    // EC2操作クライアントを作成
    let ec2_ops = AwsEc2Ops::from_config().await;

    // インスタンス状態を取得
    match ec2_ops.get_instance_state(instance_id).await {
        Ok(state) => {
            info!(
                instance_id = %instance_id,
                state = %state,
                "EC2インスタンス状態取得成功"
            );

            match state {
                InstanceState::Running => {
                    // 既に稼働中
                    Ok(Ec2CheckResult::AlreadyRunning)
                }
                InstanceState::Stopped => {
                    // 停止中 -> 復旧が必要
                    Ok(Ec2CheckResult::NeedsRecovery)
                }
                InstanceState::Pending | InstanceState::Stopping => {
                    // 遷移中の状態 -> エラー扱い
                    Err(format!(
                        "EC2インスタンスが遷移中の状態です: {}",
                        state
                    ))
                }
                InstanceState::ShuttingDown | InstanceState::Terminated => {
                    // 終了済み -> エラー扱い
                    Err(format!(
                        "EC2インスタンスが終了状態です: {}",
                        state
                    ))
                }
                InstanceState::Unknown(s) => {
                    Err(format!(
                        "EC2インスタンスが不明な状態です: {}",
                        s
                    ))
                }
            }
        }
        Err(err) => {
            warn!(
                instance_id = %instance_id,
                error = %err,
                "EC2インスタンス状態取得失敗"
            );
            Err(format!("EC2状態確認失敗: {}", err))
        }
    }
}

/// EC2起動待機のタイムアウト秒数（最大2分）
const EC2_START_TIMEOUT_SECS: u64 = 120;

/// EC2起動待機のポーリング間隔秒数
const EC2_START_POLL_INTERVAL_SECS: u64 = 5;

/// Step 2: EC2インスタンス起動
///
/// StartInstances APIでEC2を起動し、running状態になるまで待機。
///
/// # 戻り値
/// * `Ok(String)` - 成功メッセージ
/// * `Err(String)` - エラーメッセージ
async fn execute_step2_start_ec2(config: &RecoveryConfig) -> Result<String, String> {
    let instance_id = config.ec2_instance_id();

    info!(
        instance_id = %instance_id,
        "Step 2: EC2起動開始"
    );

    // EC2操作クライアントを作成
    let ec2_ops = AwsEc2Ops::from_config().await;

    // StartInstances APIを呼び出し
    match ec2_ops.start_instance(instance_id).await {
        Ok(start_result) => {
            info!(
                instance_id = %instance_id,
                previous_state = %start_result.previous_state,
                current_state = %start_result.current_state,
                "StartInstances成功、Running状態待機開始"
            );

            // Running状態になるまで待機（最大2分）
            match ec2_ops
                .wait_for_running(
                    instance_id,
                    EC2_START_TIMEOUT_SECS,
                    EC2_START_POLL_INTERVAL_SECS,
                )
                .await
            {
                Ok(()) => {
                    let message = format!(
                        "instance started ({} -> running)",
                        start_result.previous_state
                    );
                    info!(
                        instance_id = %instance_id,
                        message = %message,
                        "EC2起動完了"
                    );
                    Ok(message)
                }
                Err(err) => {
                    warn!(
                        instance_id = %instance_id,
                        error = %err,
                        "EC2 Running状態待機失敗"
                    );
                    Err(format!("EC2 Running状態待機失敗: {}", err))
                }
            }
        }
        Err(err) => {
            warn!(
                instance_id = %instance_id,
                error = %err,
                "EC2起動失敗"
            );
            Err(format!("EC2起動失敗: {}", err))
        }
    }
}

/// ヘルスチェックの最大リトライ回数
const HEALTH_CHECK_MAX_RETRIES: u32 = 5;

/// ヘルスチェックのリトライ間隔（秒）
const HEALTH_CHECK_RETRY_INTERVAL_SECS: u64 = 5;

/// Step 3: sqlite-apiヘルスチェック
///
/// /healthエンドポイントにHTTP GETリクエストを送信。
/// リトライロジック（最大5回、5秒間隔）を実装。
///
/// # 戻り値
/// * `Ok(String)` - 成功メッセージ
/// * `Err(String)` - エラーメッセージ
async fn execute_step3_health_check(config: &RecoveryConfig) -> Result<String, String> {
    let endpoint = config.sqlite_api_endpoint();

    info!(
        endpoint = %endpoint,
        max_retries = HEALTH_CHECK_MAX_RETRIES,
        retry_interval_secs = HEALTH_CHECK_RETRY_INTERVAL_SECS,
        "Step 3: sqlite-apiヘルスチェック開始"
    );

    // ヘルスチェッカーを作成
    let health_checker = HttpHealthCheck::new();

    // リトライ付きヘルスチェックを実行
    match health_checker
        .check_health_with_retry(
            endpoint,
            HEALTH_CHECK_MAX_RETRIES,
            HEALTH_CHECK_RETRY_INTERVAL_SECS,
        )
        .await
    {
        Ok(result) => {
            let message = result.message();
            info!(
                healthy = result.healthy,
                status_code = result.status_code,
                attempts = result.attempts,
                duration_ms = result.total_duration_ms,
                message = %message,
                "sqlite-apiヘルスチェック成功"
            );
            Ok(message)
        }
        Err(err) => {
            let error_message = format!(
                "sqlite-apiヘルスチェック失敗: {} ({}回リトライ後)",
                err, HEALTH_CHECK_MAX_RETRIES
            );
            warn!(
                error = %err,
                max_retries = HEALTH_CHECK_MAX_RETRIES,
                "sqlite-apiヘルスチェック失敗"
            );
            Err(error_message)
        }
    }
}

/// Step 4: relay Lambda関数の有効化
///
/// DeleteFunctionConcurrency APIでreserved concurrency設定を削除。
///
/// # 戻り値
/// * `Ok(String)` - 成功メッセージ
/// * `Err(String)` - エラーメッセージ
async fn execute_step4_enable_lambdas(config: &RecoveryConfig) -> Result<String, String> {
    let function_names = config.relay_lambda_function_names();
    let function_count = function_names.len();

    info!(
        function_count = function_count,
        functions = ?function_names,
        "Step 4: Lambda関数の有効化を開始"
    );

    // AWS Lambda クライアントを作成
    let lambda_ops = AwsLambdaOps::from_config().await;

    // 各Lambda関数のreserved concurrency設定を削除
    lambda_ops.enable_functions(function_names).await
}

/// Step 5: CloudFrontディストリビューション有効化
///
/// GetDistribution/UpdateDistribution APIでディストリビューションを有効化。
///
/// # 戻り値
/// * `Ok(String)` - 成功メッセージ
/// * `Err(String)` - エラーメッセージ
async fn execute_step5_enable_cloudfront(config: &RecoveryConfig) -> Result<String, String> {
    let distribution_id = config.cloudfront_distribution_id();

    info!(
        distribution_id = %distribution_id,
        "Step 5: CloudFront有効化開始"
    );

    // CloudFront操作クライアントを作成
    let cloudfront_ops = AwsCloudFrontOps::from_config().await;

    // ディストリビューションを有効化
    match cloudfront_ops.enable_distribution(distribution_id).await {
        Ok(result) => {
            info!(
                distribution_id = %distribution_id,
                was_disabled = result.was_disabled,
                message = %result.message,
                "Step 5: CloudFront有効化成功"
            );
            if result.was_disabled {
                Ok("distribution enabled".to_string())
            } else {
                Ok("distribution already enabled".to_string())
            }
        }
        Err(err) => {
            warn!(
                distribution_id = %distribution_id,
                error = %err,
                "Step 5: CloudFront有効化失敗"
            );
            Err(format!("CloudFront有効化失敗: {}", err))
        }
    }
}

/// 結果をSNSトピックに発行
///
/// RecoveryResultをJSON形式でSNSトピックに発行し、
/// AWS Chatbot経由でSlack通知を行う。
///
/// # 戻り値
/// * `Ok(())` - 発行成功
/// * `Err(String)` - エラーメッセージ
async fn publish_result_to_sns(
    config: &RecoveryConfig,
    result: &RecoveryResult,
) -> Result<(), String> {
    let topic_arn = config.result_sns_topic_arn();

    info!(
        topic_arn = %topic_arn,
        overall_success = result.overall_success,
        skipped = result.skipped,
        "結果SNS通知開始"
    );

    // SNS操作クライアントを作成
    let sns_ops = AwsSnsOps::from_config().await;

    // 件名を生成（スキップ/成功/失敗で変える）
    let subject = if result.skipped {
        "Budget Recovery: サービス稼働中のためスキップ"
    } else if result.overall_success {
        "Budget Recovery: 全ステップ成功"
    } else {
        "Budget Recovery: 一部ステップ失敗"
    };

    // 結果をJSONとしてSNSに発行
    match sns_ops.publish_json(topic_arn, result, Some(subject)).await {
        Ok(publish_result) => {
            info!(
                topic_arn = %topic_arn,
                message_id = %publish_result.message_id,
                "結果SNS通知成功"
            );
            Ok(())
        }
        Err(err) => {
            warn!(
                topic_arn = %topic_arn,
                error = %err,
                "結果SNS通知失敗"
            );
            Err(format!("SNS通知失敗: {}", err))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_step_result_creation() {
        let success = StepResult::success("test", "ok", 100);
        assert!(success.success);

        let failure = StepResult::failure("test", "failed", 100);
        assert!(!failure.success);
    }

    #[test]
    fn test_recovery_result_success_creation() {
        let steps = vec![
            StepResult::success("step1", "ok", 100),
            StepResult::success("step2", "ok", 200),
        ];

        let result = RecoveryResult::success("2025-01-01T00:00:00Z".to_string(), steps);
        assert!(result.overall_success);
        assert!(!result.skipped);
        assert_eq!(result.total_duration_ms, 300);
    }

    #[test]
    fn test_recovery_result_skipped_creation() {
        let result = RecoveryResult::skipped(
            "2025-01-01T00:00:00Z".to_string(),
            "already running".to_string(),
        );
        assert!(result.overall_success);
        assert!(result.skipped);
        assert_eq!(result.skip_reason.as_ref().unwrap(), "already running");
    }

    #[test]
    fn test_recovery_result_error_creation() {
        let completed = vec![
            StepResult::success("step1", "ok", 100),
        ];

        let result = RecoveryResult::error(
            "2025-01-01T00:00:00Z".to_string(),
            "step2".to_string(),
            "failed".to_string(),
            completed,
        );
        assert!(!result.overall_success);
        assert!(!result.skipped);
        assert_eq!(result.error_step.as_ref().unwrap(), "step2");
        assert_eq!(result.error_message.as_ref().unwrap(), "failed");
    }

    // ==================== ヘルスチェック定数テスト ====================

    #[test]
    fn test_health_check_max_retries_value() {
        // 設計書に基づく最大リトライ回数: 5回
        assert_eq!(HEALTH_CHECK_MAX_RETRIES, 5);
    }

    #[test]
    fn test_health_check_retry_interval_value() {
        // 設計書に基づくリトライ間隔: 5秒
        assert_eq!(HEALTH_CHECK_RETRY_INTERVAL_SECS, 5);
    }
}
