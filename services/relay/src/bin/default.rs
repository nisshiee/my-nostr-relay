/// WebSocket $default ルートハンドラー
///
/// API Gateway WebSocketのメッセージリクエストを処理し、
/// EVENT, REQ, CLOSEメッセージを適切なハンドラーに委譲する。
///
/// 要件: 5.1, 6.1, 7.1, 14.4, 15.1, 15.2, 15.3, 19.2, 19.5, 19.6
/// Task 3.3: HttpSqliteEventRepositoryを優先使用（OpenSearchはフォールバック）
/// Task 3.6: SSM Parameter StoreからAPIトークンを取得
///
/// 並行稼働: SEARCH_BACKEND_PRIORITY環境変数で検索優先順位を切り替え可能
/// - "opensearch" (デフォルト): OpenSearch優先、失敗時SQLiteフォールバック
/// - "sqlite": SQLite優先、失敗時OpenSearchフォールバック
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

    // 並行稼働: SEARCH_BACKEND_PRIORITY環境変数で検索優先順位を切り替え
    // "opensearch" (デフォルト): OpenSearch優先、失敗時SQLiteフォールバック
    // "sqlite": SQLite優先、失敗時OpenSearchフォールバック
    let backend_priority = std::env::var("SEARCH_BACKEND_PRIORITY")
        .unwrap_or_else(|_| "opensearch".to_string());

    let result = match backend_priority.as_str() {
        "sqlite" => {
            // SQLite優先モード（従来の実装）
            handle_with_sqlite_priority(
                connection_id,
                &event.payload,
                event_repo,
                subscription_repo,
                ws_sender,
                limitation_config,
            )
            .await
        }
        _ => {
            // OpenSearch優先モード（並行稼働中のデフォルト）
            handle_with_opensearch_priority(
                connection_id,
                &event.payload,
                event_repo,
                subscription_repo,
                ws_sender,
                limitation_config,
            )
            .await
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

/// SQLite優先モードでリクエストを処理
///
/// 優先順位:
/// 1. SQLite → 2. OpenSearch → 3. DynamoDB
async fn handle_with_sqlite_priority(
    connection_id: &str,
    payload: &serde_json::Value,
    event_repo: DynamoEventRepository,
    subscription_repo: DynamoSubscriptionRepository,
    ws_sender: ApiGatewayWebSocketSender,
    limitation_config: LimitationConfig,
) -> Result<(), relay::application::DefaultHandlerError> {
    // SQLiteを試行
    match get_http_sqlite_repo().await {
        Ok(query_repo) => {
            info!(
                connection_id = connection_id,
                backend = "sqlite",
                endpoint = query_repo.config().endpoint(),
                "SQLite優先モード: HttpSqliteEventRepositoryを使用"
            );

            let default_handler = DefaultHandler::with_query_repo(
                event_repo,
                query_repo.clone(),
                subscription_repo,
                ws_sender,
                limitation_config,
            );
            default_handler.handle(payload).await
        }
        Err(err) => {
            trace!(
                connection_id = connection_id,
                error = %err,
                "SQLite設定なし、OpenSearchにフォールバック"
            );

            // OpenSearchにフォールバック
            handle_with_opensearch_or_dynamo(
                connection_id,
                payload,
                event_repo,
                subscription_repo,
                ws_sender,
                limitation_config,
            )
            .await
        }
    }
}

/// OpenSearch優先モードでリクエストを処理（並行稼働中のデフォルト）
///
/// 優先順位:
/// 1. OpenSearch → 2. SQLite → 3. DynamoDB
async fn handle_with_opensearch_priority(
    connection_id: &str,
    payload: &serde_json::Value,
    event_repo: DynamoEventRepository,
    subscription_repo: DynamoSubscriptionRepository,
    ws_sender: ApiGatewayWebSocketSender,
    limitation_config: LimitationConfig,
) -> Result<(), relay::application::DefaultHandlerError> {
    // OpenSearchを試行
    let opensearch_config = OpenSearchConfig::from_env();
    match opensearch_config {
        Ok(os_config) => {
            match get_opensearch_repo(&os_config).await {
                Ok(query_repo) => {
                    info!(
                        connection_id = connection_id,
                        backend = "opensearch",
                        endpoint = os_config.endpoint(),
                        index_name = os_config.index_name(),
                        "OpenSearch優先モード: OpenSearchEventRepositoryを使用"
                    );

                    let default_handler = DefaultHandler::with_query_repo(
                        event_repo,
                        query_repo.clone(),
                        subscription_repo,
                        ws_sender,
                        limitation_config,
                    );
                    default_handler.handle(payload).await
                }
                Err(err) => {
                    warn!(
                        connection_id = connection_id,
                        error = %err,
                        "OpenSearch初期化失敗、SQLiteにフォールバック"
                    );

                    // SQLiteにフォールバック
                    handle_with_sqlite_or_dynamo(
                        connection_id,
                        payload,
                        event_repo,
                        subscription_repo,
                        ws_sender,
                        limitation_config,
                    )
                    .await
                }
            }
        }
        Err(_) => {
            trace!(
                connection_id = connection_id,
                "OpenSearch設定なし、SQLiteにフォールバック"
            );

            // SQLiteにフォールバック
            handle_with_sqlite_or_dynamo(
                connection_id,
                payload,
                event_repo,
                subscription_repo,
                ws_sender,
                limitation_config,
            )
            .await
        }
    }
}

/// SQLiteまたはDynamoDBでリクエストを処理（OpenSearchフォールバック用）
async fn handle_with_sqlite_or_dynamo(
    connection_id: &str,
    payload: &serde_json::Value,
    event_repo: DynamoEventRepository,
    subscription_repo: DynamoSubscriptionRepository,
    ws_sender: ApiGatewayWebSocketSender,
    limitation_config: LimitationConfig,
) -> Result<(), relay::application::DefaultHandlerError> {
    match get_http_sqlite_repo().await {
        Ok(query_repo) => {
            info!(
                connection_id = connection_id,
                backend = "sqlite",
                endpoint = query_repo.config().endpoint(),
                "フォールバック: HttpSqliteEventRepositoryを使用"
            );

            let default_handler = DefaultHandler::with_query_repo(
                event_repo,
                query_repo.clone(),
                subscription_repo,
                ws_sender,
                limitation_config,
            );
            default_handler.handle(payload).await
        }
        Err(_) => {
            trace!(
                connection_id = connection_id,
                "SQLite設定なし、DynamoEventRepositoryを使用"
            );

            let default_handler = DefaultHandler::with_config(
                event_repo,
                subscription_repo,
                ws_sender,
                limitation_config,
            );
            default_handler.handle(payload).await
        }
    }
}

/// OpenSearchまたはDynamoDBでリクエストを処理（SQLiteフォールバック用）
async fn handle_with_opensearch_or_dynamo(
    connection_id: &str,
    payload: &serde_json::Value,
    event_repo: DynamoEventRepository,
    subscription_repo: DynamoSubscriptionRepository,
    ws_sender: ApiGatewayWebSocketSender,
    limitation_config: LimitationConfig,
) -> Result<(), relay::application::DefaultHandlerError> {
    let opensearch_config = OpenSearchConfig::from_env();
    match opensearch_config {
        Ok(os_config) => {
            match get_opensearch_repo(&os_config).await {
                Ok(query_repo) => {
                    info!(
                        connection_id = connection_id,
                        backend = "opensearch",
                        endpoint = os_config.endpoint(),
                        index_name = os_config.index_name(),
                        "フォールバック: OpenSearchEventRepositoryを使用"
                    );

                    let default_handler = DefaultHandler::with_query_repo(
                        event_repo,
                        query_repo.clone(),
                        subscription_repo,
                        ws_sender,
                        limitation_config,
                    );
                    default_handler.handle(payload).await
                }
                Err(_) => {
                    trace!(
                        connection_id = connection_id,
                        "OpenSearch初期化失敗、DynamoEventRepositoryを使用"
                    );

                    let default_handler = DefaultHandler::with_config(
                        event_repo,
                        subscription_repo,
                        ws_sender,
                        limitation_config,
                    );
                    default_handler.handle(payload).await
                }
            }
        }
        Err(_) => {
            trace!(
                connection_id = connection_id,
                "OpenSearch設定なし、DynamoEventRepositoryを使用"
            );

            let default_handler = DefaultHandler::with_config(
                event_repo,
                subscription_repo,
                ws_sender,
                limitation_config,
            );
            default_handler.handle(payload).await
        }
    }
}
