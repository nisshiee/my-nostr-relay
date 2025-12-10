/// WebSocket $default ルートハンドラー
///
/// API Gateway WebSocketのメッセージリクエストを処理し、
/// EVENT, REQ, CLOSEメッセージを適切なハンドラーに委譲する。
///
/// 要件: 5.1, 6.1, 7.1, 14.4, 15.1, 15.2, 15.3, 19.2, 19.5, 19.6
/// Task 3.3: HttpSqliteEventRepositoryを優先使用（OpenSearchはフォールバック）
/// Task 3.6: SSM Parameter StoreからAPIトークンを取得
use lambda_runtime::{service_fn, Error, LambdaEvent};
use relay::application::DefaultHandler;
use relay::domain::LimitationConfig;
use relay::infrastructure::{
    init_logging, ApiGatewayWebSocketSender, DynamoDbConfig, DynamoEventRepository,
    DynamoSubscriptionRepository, HttpSqliteConfig, HttpSqliteEventRepository,
    OpenSearchConfig, OpenSearchEventRepository,
};
use serde_json::Value;
use tokio::sync::OnceCell;
use tracing::{error, info, trace, warn};

/// HttpSqliteEventRepositoryの静的インスタンス
///
/// Lambda warm start時にコネクションを再利用するため、
/// 一度初期化したリポジトリを静的に保持する。
/// Task 3.3: EC2 + SQLite検索基盤への接続
/// Task 3.6: 初期化時にSSMからトークンを取得するため非同期に変更
static HTTP_SQLITE_REPO: OnceCell<HttpSqliteEventRepository> = OnceCell::const_new();

/// OpenSearchEventRepositoryの静的インスタンス（フォールバック用）
///
/// Lambda warm start時にコネクションを再利用するため、
/// 一度初期化したクライアントを静的に保持する。
static OPENSEARCH_REPO: OnceCell<OpenSearchEventRepository> = OnceCell::const_new();

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

/// OpenSearchEventRepositoryを取得（初期化されていなければ初期化）
async fn get_opensearch_repo(
    config: &OpenSearchConfig,
) -> Result<&'static OpenSearchEventRepository, relay::infrastructure::OpenSearchEventRepositoryError>
{
    OPENSEARCH_REPO
        .get_or_try_init(|| async { OpenSearchEventRepository::new(config).await })
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

    // Task 3.3, 3.6: HttpSqliteEventRepositoryを優先使用（SSMからトークン取得）
    // 優先順位:
    // 1. SQLITE_API_ENDPOINTが設定されている場合はHttpSqliteEventRepositoryを使用
    // 2. OPENSEARCH_ENDPOINTが設定されている場合はOpenSearchEventRepositoryを使用
    // 3. どちらも設定されていない場合はDynamoEventRepositoryを使用
    let result = match get_http_sqlite_repo().await {
        Ok(query_repo) => {
            // HttpSqliteEventRepositoryを取得（静的保持でwarm start時再利用）
            info!(
                connection_id = connection_id,
                endpoint = query_repo.config().endpoint(),
                "HttpSqliteEventRepositoryを使用してクエリを実行（トークンはSSMから取得）"
            );

            // HttpSqliteをクエリ用に使用
            // 要件 4.2: EC2接続エラー時の適切なエラーハンドリング
            // ハンドラー内で接続エラーが発生した場合でも、WebSocketレスポンスは返される
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
            // SQLITE_API設定が不足している場合（環境変数またはSSMエラー）
            trace!(
                connection_id = connection_id,
                error = %err,
                "SQLITE_API設定なし、OpenSearchにフォールバック"
            );

            // OpenSearchにフォールバック
            let opensearch_config = OpenSearchConfig::from_env();
            match opensearch_config {
                Ok(os_config) => {
                    // OpenSearchEventRepositoryを取得（静的保持でwarm start時再利用）
                    match get_opensearch_repo(&os_config).await {
                        Ok(query_repo) => {
                            warn!(
                                connection_id = connection_id,
                                endpoint = os_config.endpoint(),
                                index_name = os_config.index_name(),
                                "SQLITE_API設定なし、OpenSearchEventRepositoryにフォールバック"
                            );

                            // OpenSearchをクエリ用に使用
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
                            // OpenSearch初期化失敗時はエラーを返す
                            error!(
                                connection_id = connection_id,
                                error = %err,
                                "OpenSearchEventRepository初期化失敗"
                            );
                            return Ok(serde_json::json!({
                                "statusCode": 500,
                                "body": "OpenSearch initialization failed"
                            }));
                        }
                    }
                }
                Err(_) => {
                    // どちらも設定されていない場合はDynamoDBを使用
                    trace!(
                        connection_id = connection_id,
                        "SQLITE_API/OpenSearch設定なし、DynamoEventRepositoryを使用"
                    );

                    let default_handler = DefaultHandler::with_config(
                        event_repo,
                        subscription_repo,
                        ws_sender,
                        limitation_config,
                    );
                    default_handler.handle(&event.payload).await
                }
            }
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

