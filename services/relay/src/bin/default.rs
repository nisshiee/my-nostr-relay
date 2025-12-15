/// WebSocket $default ルートハンドラー
///
/// API Gateway WebSocketのメッセージリクエストを処理し、
/// EVENT, REQ, CLOSEメッセージを適切なハンドラーに委譲する。
///
/// 要件: 5.1, 6.1, 7.1, 14.4, 15.1, 15.2, 15.3
/// Task 6.1: OpenSearch参照を削除し、SQLiteのみを使用
///
/// 検索基盤: EC2 SQLite API (HttpSqliteEventRepository)
/// - SQLiteが設定されている場合はSQLiteを使用
/// - SQLiteが設定されていない場合はDynamoDBにフォールバック
use lambda_runtime::{service_fn, Error, LambdaEvent};
use relay::application::DefaultHandler;
use relay::domain::LimitationConfig;
use relay::infrastructure::{
    init_logging, ApiGatewayWebSocketSender, DynamoDbConfig, DynamoEventRepository,
    DynamoSubscriptionRepository, HttpSqliteConfig, HttpSqliteEventRepository,
};
use serde_json::Value;
use tokio::sync::OnceCell;
use tracing::{error, info, trace};

/// HttpSqliteEventRepositoryの静的インスタンス
///
/// Lambda warm start時にコネクションを再利用するため、
/// 一度初期化したリポジトリを静的に保持する。
/// Task 3.3: EC2 + SQLite検索基盤への接続
/// Task 3.6: 初期化時にSSMからトークンを取得するため非同期に変更
static HTTP_SQLITE_REPO: OnceCell<HttpSqliteEventRepository> = OnceCell::const_new();

/// HttpSqliteEventRepositoryを取得（初期化されていなければ初期化）
///
/// # 戻り値
/// * `Ok(&'static HttpSqliteEventRepository)` - 静的参照へのリポジトリ
/// * `Err(HttpSqliteConfigError)` - 設定読み込みエラー
///
/// Task 3.3: EC2 + SQLite検索基盤への接続
/// Task 3.6: SSMからAPIトークンを取得（非同期初期化）
async fn get_http_sqlite_repo() -> Result<&'static HttpSqliteEventRepository, relay::infrastructure::HttpSqliteConfigError> {
    HTTP_SQLITE_REPO
        .get_or_try_init(|| async {
            let config = HttpSqliteConfig::from_env_with_ssm().await?;
            Ok(HttpSqliteEventRepository::new(config))
        })
        .await
}

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
///
/// # 検索バックエンド
/// - SQLite (HttpSqliteEventRepository): プライマリ検索バックエンド
/// - DynamoDB (DynamoEventRepository): SQLiteが設定されていない場合のフォールバック
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

    // メッセージボディを取得（ログ用、全文記録）
    let body = event
        .payload
        .get("body")
        .and_then(|b| b.as_str())
        .unwrap_or("(empty)");

    // アクセスログ出力（法的対処・不正利用防止のため）
    info!(
        connection_id = connection_id,
        source_ip = source_ip,
        user_agent = user_agent,
        request_time = request_time,
        event_type = "message",
        body = body,
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

    // 制限値設定を環境変数から読み込み
    let limitation_config = LimitationConfig::from_env();

    // SQLiteを試行、失敗時はDynamoDBにフォールバック
    let result = match get_http_sqlite_repo().await {
        Ok(query_repo) => {
            info!(
                connection_id = connection_id,
                backend = "sqlite",
                endpoint = query_repo.config().endpoint(),
                "SQLiteバックエンドを使用"
            );

            let default_handler = DefaultHandler::with_query_repo(
                event_repo,
                query_repo.clone(),
                subscription_repo,
                ws_sender,
                limitation_config,
            );
            default_handler.handle(&event.payload).await
        }
        Err(err) => {
            trace!(
                connection_id = connection_id,
                error = %err,
                "SQLite設定なし、DynamoDBを使用"
            );

            let default_handler = DefaultHandler::with_config(
                event_repo,
                subscription_repo,
                ws_sender,
                limitation_config,
            );
            default_handler.handle(&event.payload).await
        }
    };

    match result {
        Ok(()) => {
            // 成功時は200 OKを返却
            info!(
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
