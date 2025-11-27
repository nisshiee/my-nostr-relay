/// WebSocket $disconnect ルートハンドラー
///
/// API Gateway WebSocketの切断リクエストを処理し、
/// 関連するサブスクリプションと接続レコードをDynamoDBから削除する。
///
/// 要件: 1.2, 1.3, 17.3, 18.5, 19.2, 19.5, 19.6
use lambda_runtime::{service_fn, Error, LambdaEvent};
use relay::application::DisconnectHandler;
use relay::infrastructure::{init_logging, DynamoConnectionRepository, DynamoDbConfig, DynamoSubscriptionRepository};
use serde_json::Value;
use tracing::{debug, error, info, warn};

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
/// 1. DynamoDB設定を環境から読み込み
/// 2. DisconnectHandlerを使用して切断を処理
/// 3. 成功時も失敗時も200 OKを返却（クリーンアップ処理のため）
///
/// # 注意事項
/// 切断ハンドラーはクリーンアップ処理であるため、
/// エラーが発生してもログ出力のみで200 OKを返却する。
/// これにより、DynamoDB一時障害時でも接続切断自体は成功する。
async fn handler(event: LambdaEvent<Value>) -> Result<Value, Error> {
    // 接続IDを取得（ログ用）
    let connection_id = event
        .payload
        .get("requestContext")
        .and_then(|ctx| ctx.get("connectionId"))
        .and_then(|id| id.as_str())
        .unwrap_or("unknown");

    debug!(
        connection_id = connection_id,
        "WebSocket切断リクエスト受信"
    );

    // DynamoDB設定を環境から読み込み
    let config = match DynamoDbConfig::from_env().await {
        Ok(config) => config,
        Err(err) => {
            // 設定エラー時もログ出力のみで200 OKを返却
            error!(
                connection_id = connection_id,
                error = %err,
                "DynamoDB設定読み込み失敗（切断処理続行）"
            );
            return Ok(serde_json::json!({
                "statusCode": 200,
                "body": "Disconnected (config error)"
            }));
        }
    };

    // リポジトリを作成
    let connection_repo = DynamoConnectionRepository::new(
        config.client().clone(),
        config.connections_table().to_string(),
    );
    let subscription_repo = DynamoSubscriptionRepository::new(
        config.client().clone(),
        config.subscriptions_table().to_string(),
    );

    // DisconnectHandlerを作成して切断を処理
    let disconnect_handler = DisconnectHandler::new(connection_repo, subscription_repo);

    match disconnect_handler.handle(&event.payload).await {
        Ok(()) => {
            // 成功時は200 OKを返却
            info!(
                connection_id = connection_id,
                "WebSocket切断完了"
            );
            Ok(serde_json::json!({
                "statusCode": 200,
                "body": "Disconnected"
            }))
        }
        Err(err) => {
            // エラー時もログ出力のみで200 OKを返却（要件: クリーンアップ処理のため）
            warn!(
                connection_id = connection_id,
                error = %err,
                "切断クリーンアップエラー（接続切断は完了）"
            );
            Ok(serde_json::json!({
                "statusCode": 200,
                "body": "Disconnected (cleanup error)"
            }))
        }
    }
}
