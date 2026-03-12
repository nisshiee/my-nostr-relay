use std::sync::Arc;

use anyhow::Context;
use axum::{
    Router,
    extract::State,
    extract::ws::{WebSocketUpgrade, rejection::WebSocketUpgradeRejection},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::get,
};
use tokio_util::sync::CancellationToken;
use tracing::{error, info};

use relay::config::LimitationConfig;
use relay::logging;
use relay::nip11::RelayInformation;
use relay::owner_priority::OwnerPriority;
use relay::relay::Relay;
use relay::store::{AppEventStore, create_event_store};
use relay::ws;

/// アプリケーション共有状態
#[derive(Clone)]
struct AppState {
    relay: Arc<Relay<AppEventStore>>,
    limitation: Arc<LimitationConfig>,
    owner_priority: Arc<OwnerPriority>,
    shutdown: CancellationToken,
}

async fn handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    // WebSocket or HTTP
    match ws {
        Ok(ws) => {
            // 接続IDを生成（UUID v7 - タイムスタンプベースで時系列ソート可能）
            let conn_id = uuid::Uuid::now_v7().to_string();
            let relay = state.relay.clone();
            let limitation = state.limitation.clone();
            let owner_priority = state.owner_priority.clone();
            let shutdown = state.shutdown.clone();
            ws.on_upgrade(move |socket| {
                ws::handle_socket(socket, relay, conn_id, limitation, owner_priority, shutdown)
            })
        }
        Err(_) => {
            // NIP-11 Request 判定
            if let Some(value) = headers.get("Accept")
                && value == "application/nostr+json"
            {
                handle_nip11(&state.limitation).await
            } else {
                "Hello, this is a regular HTTP response.".into_response()
            }
        }
    }
}

async fn handle_nip11(limitation: &LimitationConfig) -> Response {
    use axum::http::{HeaderMap, HeaderValue, StatusCode};

    let mut headers = HeaderMap::new();

    // CORSヘッダーの設定（NIP-11必須）
    headers.insert("Access-Control-Allow-Origin", HeaderValue::from_static("*"));
    headers.insert(
        "Access-Control-Allow-Headers",
        HeaderValue::from_static("Accept, Content-Type"),
    );
    headers.insert(
        "Access-Control-Allow-Methods",
        HeaderValue::from_static("GET, OPTIONS"),
    );

    // Content-Type設定
    headers.insert("Content-Type", HeaderValue::from_static("application/json"));

    // 環境変数からリレー情報を取得（制限値設定を反映）
    match RelayInformation::from_env_with_config(limitation) {
        Ok(info) => match serde_json::to_string(&info) {
            Ok(json) => (StatusCode::OK, headers, json).into_response(),
            Err(e) => {
                tracing::error!(error = %e, "NIP-11情報のJSON化に失敗");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    headers,
                    "{\"error\":\"Internal server error\"}".to_string(),
                )
                    .into_response()
            }
        },
        Err(e) => {
            tracing::error!(error = %e, "NIP-11情報の取得に失敗");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                headers,
                "{\"error\":\"Relay information not configured\"}".to_string(),
            )
                .into_response()
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // ログ初期化（最初に実行）
    logging::init_logging();

    info!(
        version = env!("CARGO_PKG_VERSION"),
        "Nostr Relay v2 を起動中"
    );

    // 制限値設定を読み込み
    let limitation = Arc::new(LimitationConfig::from_env());

    // EventStore の実装を選択（feature flagに基づいてDynamoDB/InMemory切り替え）
    let (store, owner_priority) = create_event_store().await?;
    let relay = Arc::new(Relay::new(store));

    // DynamoDB使用時: バックグラウンドで既存イベントをロード
    // ロード完了前のREQは不完全な結果を返すが、サーバーはすぐにリッスン開始する
    #[cfg(feature = "dynamo")]
    {
        let relay_clone = Arc::clone(&relay);
        tokio::spawn(async move {
            info!("DynamoDBからのイベントロードをバックグラウンドで開始");
            match relay_clone.store().load_recent_events().await {
                Ok(()) => info!("DynamoDBからのイベントロードが完了"),
                Err(e) => error!(error = %e, "DynamoDBからのイベントロードに失敗"),
            }
        });
    }

    let shutdown = CancellationToken::new();
    let state = AppState {
        relay,
        limitation,
        owner_priority,
        shutdown: shutdown.clone(),
    };

    let app = Router::new().route("/", get(handler)).with_state(state);

    let bind_addr = "0.0.0.0:3000";
    info!(
        bind_address = bind_addr,
        "サーバーがリスニングを開始しました"
    );

    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .context("TcpListener bindに失敗")?;

    // Graceful shutdown:
    // 1. SIGTERM/SIGINTを受信
    // 2. CancellationTokenをキャンセル → 各WebSocket接続にCloseフレーム送信を通知
    // 3. 新規接続の受付を停止し、既存接続のクローズ完了を待機
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(shutdown))
        .await
        .context("サーバー起動に失敗")?;

    info!("サーバーをシャットダウンしました");
    Ok(())
}

/// SIGTERM/SIGINTを待機し、受信したらCancellationTokenをキャンセルする
async fn shutdown_signal(token: CancellationToken) {
    use tokio::signal::unix::{SignalKind, signal};

    let mut sigterm = signal(SignalKind::terminate()).expect("SIGTERMハンドラの登録に失敗");
    let mut sigint = signal(SignalKind::interrupt()).expect("SIGINTハンドラの登録に失敗");

    tokio::select! {
        _ = sigterm.recv() => {
            info!("SIGTERMを受信、graceful shutdownを開始");
        }
        _ = sigint.recv() => {
            info!("SIGINTを受信、graceful shutdownを開始");
        }
    }

    // 全WebSocket接続にシャットダウンを通知
    token.cancel();
}
