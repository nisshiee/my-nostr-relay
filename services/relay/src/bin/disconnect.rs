/// WebSocket $disconnect ルートハンドラー
///
/// API Gateway WebSocketの切断リクエストを処理し、
/// 関連するサブスクリプションと接続レコードをDynamoDBから削除する。
///
/// 要件: 1.2, 1.3, 17.3, 18.5
use lambda_runtime::{service_fn, Error, LambdaEvent};
use relay::application::DisconnectHandler;
use relay::infrastructure::{DynamoConnectionRepository, DynamoDbConfig, DynamoSubscriptionRepository};
use serde_json::Value;

#[tokio::main]
async fn main() -> Result<(), Error> {
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
    // DynamoDB設定を環境から読み込み
    let config = match DynamoDbConfig::from_env().await {
        Ok(config) => config,
        Err(err) => {
            // 設定エラー時もログ出力のみで200 OKを返却
            eprintln!("Failed to load DynamoDB config: {}", err);
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
            Ok(serde_json::json!({
                "statusCode": 200,
                "body": "Disconnected"
            }))
        }
        Err(err) => {
            // エラー時もログ出力のみで200 OKを返却（要件: クリーンアップ処理のため）
            eprintln!("Disconnect handler error: {}", err);
            Ok(serde_json::json!({
                "statusCode": 200,
                "body": "Disconnected (cleanup error)"
            }))
        }
    }
}
