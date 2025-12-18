/// Shutdown Lambda関数
///
/// 予算超過時にサービスを段階的に停止するLambda関数。
/// SNSトピックからトリガーされ、以下のフェーズを順次実行:
/// - Phase 1: relay Lambda関数のreserved concurrencyを0に設定
/// - Phase 2: 実行中Lambda完了を待機（30秒）
/// - Phase 3: SSM Run Command経由でsqlite-api停止
/// - Phase 4: EC2インスタンス停止
/// - Phase 5: CloudFrontディストリビューション無効化
///
/// 各フェーズの失敗は記録して次フェーズに継続（エラー継続戦略）。
/// 最終結果をSNSトピックに発行してSlack通知。
///
/// 要件: 3.1, 3.2, 3.3, 3.4, 3.6, 3.7, 3.8, 3.9, 3.10
use aws_lambda_events::event::sns::SnsEvent;
use lambda_runtime::{service_fn, Error, LambdaEvent};
use relay::infrastructure::{init_logging, AwsLambdaOps, LambdaOps, PhaseResult, ShutdownConfig, ShutdownResult};
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
/// 1. 環境変数からShutdownConfigを読み込み
/// 2. 5つのフェーズを順次実行（各フェーズは失敗しても継続）
/// 3. 全フェーズの結果をShutdownResultにまとめてSNS通知
///
/// # 引数
/// * `event` - SNSイベント（AWS Budgetからの通知）
///
/// # 戻り値
/// 常にOkを返す（エラー継続戦略のため）
async fn handler(event: LambdaEvent<SnsEvent>) -> Result<(), Error> {
    let start_time = std::time::Instant::now();

    // SNSイベントの情報をログ出力
    let sns_event = event.payload;
    let record_count = sns_event.records.len();
    info!(
        record_count = record_count,
        "予算アラートSNSイベントを受信"
    );

    // SNSレコードの詳細をログ出力
    for (i, record) in sns_event.records.iter().enumerate() {
        let subject = record.sns.subject.as_deref().unwrap_or("(no subject)");
        let message = &record.sns.message;
        let topic_arn = &record.sns.topic_arn;

        info!(
            index = i,
            subject = subject,
            topic_arn = topic_arn,
            message_length = message.len(),
            "SNSレコード詳細"
        );
    }

    // 設定を環境変数から読み込み
    let config = match ShutdownConfig::from_env() {
        Ok(config) => {
            info!(
                lambda_functions = ?config.relay_lambda_function_names(),
                ec2_instance_id = config.ec2_instance_id(),
                cloudfront_distribution_id = config.cloudfront_distribution_id(),
                result_sns_topic_arn = config.result_sns_topic_arn(),
                sqlite_api_systemd_service = config.sqlite_api_systemd_service(),
                "Shutdown設定を読み込み"
            );
            config
        }
        Err(err) => {
            error!(error = %err, "Shutdown設定読み込み失敗");
            // 設定が読み込めない場合は終了（通知も不可能）
            return Err(format!("Shutdown設定読み込み失敗: {}", err).into());
        }
    };

    // フェーズ結果を記録するベクター
    let mut phases: Vec<PhaseResult> = Vec::new();

    // Phase 1: Lambda無効化（TODO: Task 2.2で実装）
    let phase1_start = std::time::Instant::now();
    let phase1_result = execute_phase1_lambda_disable(&config).await;
    let phase1_duration = phase1_start.elapsed().as_millis() as u64;
    phases.push(match phase1_result {
        Ok(message) => {
            info!(phase = "lambda-disable", message = %message, duration_ms = phase1_duration, "Phase 1 完了");
            PhaseResult::success("lambda-disable", message, phase1_duration)
        }
        Err(message) => {
            warn!(phase = "lambda-disable", message = %message, duration_ms = phase1_duration, "Phase 1 失敗（継続）");
            PhaseResult::failure("lambda-disable", message, phase1_duration)
        }
    });

    // Phase 2: 処理完了待ち（TODO: Task 2.3で実装）
    let phase2_start = std::time::Instant::now();
    let phase2_result = execute_phase2_wait_completion().await;
    let phase2_duration = phase2_start.elapsed().as_millis() as u64;
    phases.push(match phase2_result {
        Ok(message) => {
            info!(phase = "wait-completion", message = %message, duration_ms = phase2_duration, "Phase 2 完了");
            PhaseResult::success("wait-completion", message, phase2_duration)
        }
        Err(message) => {
            warn!(phase = "wait-completion", message = %message, duration_ms = phase2_duration, "Phase 2 失敗（継続）");
            PhaseResult::failure("wait-completion", message, phase2_duration)
        }
    });

    // Phase 3: sqlite-api停止（TODO: Task 2.3で実装）
    let phase3_start = std::time::Instant::now();
    let phase3_result = execute_phase3_sqlite_api_stop(&config).await;
    let phase3_duration = phase3_start.elapsed().as_millis() as u64;
    phases.push(match phase3_result {
        Ok(message) => {
            info!(phase = "sqlite-api-stop", message = %message, duration_ms = phase3_duration, "Phase 3 完了");
            PhaseResult::success("sqlite-api-stop", message, phase3_duration)
        }
        Err(message) => {
            warn!(phase = "sqlite-api-stop", message = %message, duration_ms = phase3_duration, "Phase 3 失敗（継続）");
            PhaseResult::failure("sqlite-api-stop", message, phase3_duration)
        }
    });

    // Phase 4: EC2停止（TODO: Task 2.3で実装）
    let phase4_start = std::time::Instant::now();
    let phase4_result = execute_phase4_ec2_stop(&config).await;
    let phase4_duration = phase4_start.elapsed().as_millis() as u64;
    phases.push(match phase4_result {
        Ok(message) => {
            info!(phase = "ec2-stop", message = %message, duration_ms = phase4_duration, "Phase 4 完了");
            PhaseResult::success("ec2-stop", message, phase4_duration)
        }
        Err(message) => {
            warn!(phase = "ec2-stop", message = %message, duration_ms = phase4_duration, "Phase 4 失敗（継続）");
            PhaseResult::failure("ec2-stop", message, phase4_duration)
        }
    });

    // Phase 5: CloudFront無効化（TODO: Task 2.4で実装）
    let phase5_start = std::time::Instant::now();
    let phase5_result = execute_phase5_cloudfront_disable(&config).await;
    let phase5_duration = phase5_start.elapsed().as_millis() as u64;
    phases.push(match phase5_result {
        Ok(message) => {
            info!(phase = "cloudfront-disable", message = %message, duration_ms = phase5_duration, "Phase 5 完了");
            PhaseResult::success("cloudfront-disable", message, phase5_duration)
        }
        Err(message) => {
            warn!(phase = "cloudfront-disable", message = %message, duration_ms = phase5_duration, "Phase 5 失敗（継続）");
            PhaseResult::failure("cloudfront-disable", message, phase5_duration)
        }
    });

    // 結果を集計
    let timestamp = chrono::Utc::now().to_rfc3339();
    let result = ShutdownResult::new(timestamp, phases);
    let total_duration = start_time.elapsed().as_millis() as u64;

    // 結果をログ出力
    let result_json = serde_json::to_string_pretty(&result).unwrap_or_default();
    if result.overall_success {
        info!(
            overall_success = result.overall_success,
            total_duration_ms = total_duration,
            result = %result_json,
            "全フェーズ成功"
        );
    } else {
        warn!(
            overall_success = result.overall_success,
            total_duration_ms = total_duration,
            result = %result_json,
            "一部フェーズ失敗"
        );
    }

    // SNS通知（TODO: Task 2.4で実装）
    if let Err(err) = publish_result_to_sns(&config, &result).await {
        error!(error = %err, "結果SNS通知失敗");
    }

    Ok(())
}

/// Phase 1: relay Lambda関数のreserved concurrencyを0に設定
///
/// 複数のLambda関数（connect/disconnect/default）に対して
/// PutFunctionConcurrency APIを呼び出し、reserved concurrencyを0に設定。
/// 新規invocationを即座にブロックする。
///
/// # 戻り値
/// * `Ok(String)` - 成功メッセージ（無効化した関数数）
/// * `Err(String)` - エラーメッセージ
async fn execute_phase1_lambda_disable(config: &ShutdownConfig) -> Result<String, String> {
    let function_names = config.relay_lambda_function_names();
    let function_count = function_names.len();

    info!(
        function_count = function_count,
        functions = ?function_names,
        "Phase 1: Lambda関数の無効化を開始"
    );

    // AWS Lambda クライアントを作成
    let lambda_ops = AwsLambdaOps::from_config().await;

    // 各Lambda関数のreserved concurrencyを0に設定
    lambda_ops.disable_functions(function_names).await
}

/// Phase 2: 実行中Lambda関数の完了を待機
///
/// Lambda関数がreserved concurrency=0に設定された後、
/// 実行中のinvocationが完了するまで30秒待機する。
///
/// # 戻り値
/// * `Ok(String)` - 成功メッセージ
/// * `Err(String)` - エラーメッセージ
async fn execute_phase2_wait_completion() -> Result<String, String> {
    // TODO: Task 2.3で実装
    // tokio::time::sleepで30秒待機
    info!("Phase 2: 処理完了待ち（未実装）");
    Ok("waited 30s (stub)".to_string())
}

/// Phase 3: SSM Run Command経由でsqlite-apiを停止
///
/// systemctl stop <service>コマンドをSSM経由で実行し、
/// sqlite-apiプロセスをgraceful stopさせる。
///
/// # 戻り値
/// * `Ok(String)` - 成功メッセージ
/// * `Err(String)` - エラーメッセージ
async fn execute_phase3_sqlite_api_stop(config: &ShutdownConfig) -> Result<String, String> {
    // TODO: Task 2.3で実装
    // aws-sdk-ssmを使用してSendCommand APIを呼び出し
    info!(
        ec2_instance_id = config.ec2_instance_id(),
        systemd_service = config.sqlite_api_systemd_service(),
        "Phase 3: sqlite-api停止（未実装）"
    );
    Ok("graceful shutdown completed (stub)".to_string())
}

/// Phase 4: EC2インスタンスを停止
///
/// StopInstances APIを呼び出してsqlite-api EC2を停止する。
///
/// # 戻り値
/// * `Ok(String)` - 成功メッセージ
/// * `Err(String)` - エラーメッセージ
async fn execute_phase4_ec2_stop(config: &ShutdownConfig) -> Result<String, String> {
    // TODO: Task 2.3で実装
    // aws-sdk-ec2を使用してStopInstances APIを呼び出し
    info!(
        ec2_instance_id = config.ec2_instance_id(),
        "Phase 4: EC2停止（未実装）"
    );
    Ok("instance stopped (stub)".to_string())
}

/// Phase 5: CloudFrontディストリビューションを無効化
///
/// UpdateDistribution APIを呼び出してCloudFrontを無効化する。
/// 伝播には最大15分かかる可能性がある。
///
/// # 戻り値
/// * `Ok(String)` - 成功メッセージ
/// * `Err(String)` - エラーメッセージ
async fn execute_phase5_cloudfront_disable(config: &ShutdownConfig) -> Result<String, String> {
    // TODO: Task 2.4で実装
    // aws-sdk-cloudfrontを使用してUpdateDistribution APIを呼び出し
    info!(
        cloudfront_distribution_id = config.cloudfront_distribution_id(),
        "Phase 5: CloudFront無効化（未実装）"
    );
    Ok("distribution disabled (stub)".to_string())
}

/// 結果をSNSトピックに発行
///
/// ShutdownResultをJSON形式でSNSトピックに発行し、
/// AWS Chatbot経由でSlack通知を行う。
///
/// # 戻り値
/// * `Ok(())` - 発行成功
/// * `Err(String)` - エラーメッセージ
async fn publish_result_to_sns(config: &ShutdownConfig, result: &ShutdownResult) -> Result<(), String> {
    // TODO: Task 2.4で実装
    // aws-sdk-snsを使用してPublish APIを呼び出し
    let result_json = serde_json::to_string(result).map_err(|e| e.to_string())?;
    info!(
        sns_topic_arn = config.result_sns_topic_arn(),
        result_length = result_json.len(),
        "結果SNS通知（未実装）"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_phase_result_creation() {
        let success = PhaseResult::success("test", "ok", 100);
        assert!(success.success);

        let failure = PhaseResult::failure("test", "failed", 100);
        assert!(!failure.success);
    }

    #[test]
    fn test_shutdown_result_creation() {
        let phases = vec![
            PhaseResult::success("phase1", "ok", 100),
            PhaseResult::success("phase2", "ok", 200),
        ];

        let result = ShutdownResult::new("2025-01-01T00:00:00Z".to_string(), phases);
        assert!(result.overall_success);
        assert_eq!(result.total_duration_ms, 300);
    }
}
