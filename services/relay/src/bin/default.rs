/// WebSocket $default ルートハンドラー
///
/// API Gateway WebSocketのメッセージリクエストを処理し、
/// EVENT, REQ, CLOSEメッセージを適切なハンドラーに委譲する。
///
/// 要件: 5.1, 6.1, 7.1, 14.4, 15.1, 15.2, 15.3, 19.2, 19.5, 19.6
use lambda_runtime::{service_fn, Error, LambdaEvent};
use relay::application::DefaultHandler;
use relay::infrastructure::{
    init_logging, ApiGatewayWebSocketSender, DynamoDbConfig, DynamoEventRepository, DynamoSubscriptionRepository,
};
use serde_json::Value;
use tracing::{debug, error, trace};

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
/// 2. WebSocket送信用のエンドポイントURLを構築
/// 3. DefaultHandlerを使用してメッセージを処理
/// 4. 成功時は200 OK、失敗時は適切なレスポンスを返却
async fn handler(event: LambdaEvent<Value>) -> Result<Value, Error> {
    // requestContextから情報を取得
    let request_context = event.payload.get("requestContext");

    // 接続IDを取得（ログ用）
    let connection_id = request_context
        .and_then(|ctx| ctx.get("connectionId"))
        .and_then(|id| id.as_str())
        .unwrap_or("unknown");

    // アクセスログ情報を取得
    let source_ip = request_context
        .and_then(|ctx| ctx.get("identity"))
        .and_then(|identity| identity.get("sourceIp"))
        .and_then(|ip| ip.as_str())
        .unwrap_or("unknown");

    let user_agent = request_context
        .and_then(|ctx| ctx.get("identity"))
        .and_then(|identity| identity.get("userAgent"))
        .and_then(|ua| ua.as_str())
        .unwrap_or("unknown");

    let request_time = request_context
        .and_then(|ctx| ctx.get("requestTimeEpoch"))
        .and_then(|time| time.as_i64())
        .unwrap_or(0);

    // メッセージボディを取得（ログ用、最大100バイトに切り詰め）
    let body_preview = event
        .payload
        .get("body")
        .and_then(|b| b.as_str())
        .map(|s| {
            if s.len() <= 100 {
                s
            } else {
                // 100バイト以下の最大の文字境界を見つける
                let mut end = 100;
                while !s.is_char_boundary(end) {
                    end -= 1;
                }
                &s[..end]
            }
        })
        .unwrap_or("(empty)");

    // アクセスログ出力（法的対処・不正利用防止のため）
    debug!(
        connection_id = connection_id,
        source_ip = source_ip,
        user_agent = user_agent,
        request_time = request_time,
        event_type = "message",
        body_preview = body_preview,
        "WebSocketメッセージ受信"
    );

    // DynamoDB設定を環境から読み込み
    let config = match DynamoDbConfig::from_env().await {
        Ok(config) => config,
        Err(err) => {
            error!(
                connection_id = connection_id,
                error = %err,
                "DynamoDB設定読み込み失敗"
            );
            return Ok(serde_json::json!({
                "statusCode": 500,
                "body": "Internal server error"
            }));
        }
    };

    // 環境変数からエンドポイントURLを取得
    let endpoint_url = match std::env::var("API_GATEWAY_ENDPOINT") {
        Ok(url) => {
            trace!(
                connection_id = connection_id,
                endpoint_url = %url,
                "エンドポイントURL取得完了"
            );
            url
        }
        Err(_) => {
            error!(
                connection_id = connection_id,
                "API_GATEWAY_ENDPOINT環境変数が設定されていません"
            );
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
            debug!(
                connection_id = connection_id,
                "メッセージ処理完了"
            );
            Ok(serde_json::json!({
                "statusCode": 200,
                "body": "Message processed"
            }))
        }
        Err(err) => {
            // エラー時はログ出力して適切なレスポンスを返却
            error!(
                connection_id = connection_id,
                error = %err,
                "メッセージ処理エラー"
            );
            Ok(serde_json::json!({
                "statusCode": 200,
                "body": "Message processing error"
            }))
        }
    }
}

