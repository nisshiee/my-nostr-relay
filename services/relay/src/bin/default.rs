/// WebSocket $default ルートハンドラー
///
/// API Gateway WebSocketのメッセージリクエストを処理し、
/// EVENT, REQ, CLOSEメッセージを適切なハンドラーに委譲する。
///
/// 要件: 5.1, 6.1, 7.1, 14.4, 15.1, 15.2, 15.3
use lambda_runtime::{service_fn, Error, LambdaEvent};
use relay::application::DefaultHandler;
use relay::infrastructure::{
    ApiGatewayWebSocketSender, DynamoDbConfig, DynamoEventRepository, DynamoSubscriptionRepository,
};
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
/// 2. WebSocket送信用のエンドポイントURLを構築
/// 3. DefaultHandlerを使用してメッセージを処理
/// 4. 成功時は200 OK、失敗時は適切なレスポンスを返却
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

    // requestContextからエンドポイントURLを構築
    let endpoint_url = match extract_endpoint_url(&event.payload) {
        Some(url) => url,
        None => {
            eprintln!("Failed to extract endpoint URL from request context");
            return Ok(serde_json::json!({
                "statusCode": 500,
                "body": "Internal server error"
            }));
        }
    };

    // リポジトリを作成
    let event_repo = DynamoEventRepository::new(
        config.client().clone(),
        config.events_table().to_string(),
    );
    let subscription_repo = DynamoSubscriptionRepository::new(
        config.client().clone(),
        config.subscriptions_table().to_string(),
    );

    // WebSocket送信を作成
    let ws_sender = ApiGatewayWebSocketSender::new(&endpoint_url).await;

    // DefaultHandlerを作成してメッセージを処理
    let default_handler = DefaultHandler::new(event_repo, subscription_repo, ws_sender);

    match default_handler.handle(&event.payload).await {
        Ok(()) => {
            // 成功時は200 OKを返却
            Ok(serde_json::json!({
                "statusCode": 200,
                "body": "Message processed"
            }))
        }
        Err(err) => {
            // エラー時はログ出力して適切なレスポンスを返却
            eprintln!("Default handler error: {}", err);
            Ok(serde_json::json!({
                "statusCode": 200,
                "body": "Message processing error"
            }))
        }
    }
}

/// requestContextからAPI Gateway Management APIのエンドポイントURLを抽出
fn extract_endpoint_url(event: &Value) -> Option<String> {
    let request_context = event.get("requestContext")?;
    let domain_name = request_context.get("domainName")?.as_str()?;
    let stage = request_context.get("stage")?.as_str()?;
    Some(ApiGatewayWebSocketSender::build_endpoint_url(domain_name, stage))
}
