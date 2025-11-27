/// WebSocket $connect ルートハンドラー
///
/// API Gateway WebSocketの接続リクエストを処理し、
/// 接続情報をDynamoDBに保存する。
///
/// 要件: 1.1, 17.1, 17.2
use lambda_runtime::{service_fn, Error, LambdaEvent};
use relay::application::ConnectHandler;
use relay::infrastructure::{DynamoConnectionRepository, DynamoDbConfig};
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
/// 2. ConnectHandlerを使用して接続を処理
/// 3. 成功時は200 OK、失敗時は500エラーを返却
async fn handler(event: LambdaEvent<Value>) -> Result<Value, Error> {
    // DynamoDB設定を環境から読み込み
    let config = match DynamoDbConfig::from_env().await {
        Ok(config) => config,
        Err(err) => {
            eprintln!("Failed to load DynamoDB config: {}", err);
            return Ok(serde_json::json!({
                "statusCode": 500,
                "body": "Internal server error"
            }));
        }
    };

    // ConnectionRepositoryを作成
    let connection_repo = DynamoConnectionRepository::new(
        config.client().clone(),
        config.connections_table().to_string(),
    );

    // ConnectHandlerを作成して接続を処理
    let connect_handler = ConnectHandler::new(connection_repo);

    match connect_handler.handle(&event.payload).await {
        Ok(()) => {
            // 成功時は200 OKを返却（要件 1.1）
            Ok(serde_json::json!({
                "statusCode": 200,
                "body": "Connected"
            }))
        }
        Err(err) => {
            // エラー時はログ出力して500エラーを返却
            eprintln!("Connect handler error: {}", err);
            Ok(serde_json::json!({
                "statusCode": 500,
                "body": "Internal server error"
            }))
        }
    }
}
