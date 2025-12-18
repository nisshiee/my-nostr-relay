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
    init_logging, RecoveryConfig, RecoveryResult, StepResult,
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

    // Step 1: EC2状態確認（TODO: Task 3.2で実装）
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

    // Step 2: EC2起動（TODO: Task 3.2で実装）
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

    // Step 3: sqlite-apiヘルスチェック（TODO: Task 3.3で実装）
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

    // Step 4: Lambda有効化（TODO: Task 3.4で実装）
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

    // Step 5: CloudFront有効化（TODO: Task 3.4で実装）
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
#[allow(dead_code)] // Task 3.2で実装時に使用
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
async fn execute_step1_check_ec2_state(_config: &RecoveryConfig) -> Result<Ec2CheckResult, String> {
    // TODO: Task 3.2で実装
    // 現在はプレースホルダーとしてNeedsRecoveryを返す
    info!("Step 1: EC2状態確認（プレースホルダー）");
    Ok(Ec2CheckResult::NeedsRecovery)
}

/// Step 2: EC2インスタンス起動
///
/// StartInstances APIでEC2を起動し、running状態になるまで待機。
///
/// # 戻り値
/// * `Ok(String)` - 成功メッセージ
/// * `Err(String)` - エラーメッセージ
async fn execute_step2_start_ec2(_config: &RecoveryConfig) -> Result<String, String> {
    // TODO: Task 3.2で実装
    info!("Step 2: EC2起動（プレースホルダー）");
    Ok("instance started (placeholder)".to_string())
}

/// Step 3: sqlite-apiヘルスチェック
///
/// /healthエンドポイントにHTTP GETリクエストを送信。
/// リトライロジック（最大5回、5秒間隔）を実装。
///
/// # 戻り値
/// * `Ok(String)` - 成功メッセージ
/// * `Err(String)` - エラーメッセージ
async fn execute_step3_health_check(_config: &RecoveryConfig) -> Result<String, String> {
    // TODO: Task 3.3で実装
    info!("Step 3: sqlite-apiヘルスチェック（プレースホルダー）");
    Ok("sqlite-api healthy (placeholder)".to_string())
}

/// Step 4: relay Lambda関数の有効化
///
/// DeleteFunctionConcurrency APIでreserved concurrency設定を削除。
///
/// # 戻り値
/// * `Ok(String)` - 成功メッセージ
/// * `Err(String)` - エラーメッセージ
async fn execute_step4_enable_lambdas(_config: &RecoveryConfig) -> Result<String, String> {
    // TODO: Task 3.4で実装
    info!("Step 4: Lambda有効化（プレースホルダー）");
    Ok("lambdas enabled (placeholder)".to_string())
}

/// Step 5: CloudFrontディストリビューション有効化
///
/// GetDistribution/UpdateDistribution APIでディストリビューションを有効化。
///
/// # 戻り値
/// * `Ok(String)` - 成功メッセージ
/// * `Err(String)` - エラーメッセージ
async fn execute_step5_enable_cloudfront(_config: &RecoveryConfig) -> Result<String, String> {
    // TODO: Task 3.4で実装
    info!("Step 5: CloudFront有効化（プレースホルダー）");
    Ok("distribution enabled (placeholder)".to_string())
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
    // TODO: SNS通知を実装
    let topic_arn = config.result_sns_topic_arn();

    info!(
        topic_arn = %topic_arn,
        overall_success = result.overall_success,
        skipped = result.skipped,
        "結果SNS通知開始（プレースホルダー）"
    );

    // TODO: Task 3.4でAwsSnsOpsを使用して実装
    // 現在はログ出力のみ
    let result_json = serde_json::to_string_pretty(result).unwrap_or_default();
    info!(result = %result_json, "SNS通知内容");

    Ok(())
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
}
