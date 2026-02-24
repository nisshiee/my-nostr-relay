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
use tracing::info;

use relay::logging;
use relay::relay::Relay;
use relay::store::InMemoryEventStore;
use relay::ws;

async fn handler(
    State(relay): State<Arc<Relay>>,
    headers: HeaderMap,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    // WebSocket or HTTP
    match ws {
        Ok(ws) => {
            // 接続IDを生成（UUID v7 - タイムスタンプベースで時系列ソート可能）
            let conn_id = uuid::Uuid::now_v7().to_string();
            ws.on_upgrade(move |socket| ws::handle_socket(socket, relay, conn_id))
        }
        Err(_) => {
            // NIP-11 Request 判定
            if let Some(value) = headers.get("X-Special-Mode")
                && value == "debug"
            {
                handle_nip11().await
            } else {
                "Hello, this is a regular HTTP response.".into_response()
            }
        }
    }
}

async fn handle_nip11() -> Response {
    todo!()
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // ログ初期化（最初に実行）
    logging::init_logging();

    info!(
        version = env!("CARGO_PKG_VERSION"),
        "Nostr Relay v2 を起動中"
    );

    // EventStore の実装を選択（将来は DynamoDB 等に差し替え可能）
    let store = Arc::new(InMemoryEventStore::new());
    let relay = Arc::new(Relay::new(store));

    let app = Router::new()
        .route("/", get(handler))
        .with_state(relay);

    let bind_addr = "0.0.0.0:3000";
    info!(bind_address = bind_addr, "サーバーがリスニングを開始しました");

    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .context("TcpListener bindに失敗")?;
    axum::serve(listener, app)
        .await
        .context("サーバー起動に失敗")?;

    Ok(())
}
