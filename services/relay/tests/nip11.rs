//! NIP-11 Relay Information Document のE2Eテスト

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    Router, extract::State, extract::ws::WebSocketUpgrade, http::HeaderMap, response::Response,
    routing::get,
};
use serde_json::{Value, json};
use serial_test::serial;
use tokio::net::TcpListener;

/// テスト用の共有状態
#[derive(Clone)]
struct TestState {
    relay: Arc<relay::relay::Relay<relay::store::InMemoryEventStore>>,
    limitation: Arc<relay::config::LimitationConfig>,
}

/// テスト用リレーサーバーを起動し、アドレスを返す
/// （NIP-11とWebSocket両方に対応）
async fn start_relay() -> SocketAddr {
    let store = relay::store::InMemoryEventStore::new();
    let relay_instance = Arc::new(relay::relay::Relay::new(store));
    let limitation = Arc::new(relay::config::LimitationConfig::default());

    let state = TestState {
        relay: relay_instance,
        limitation,
    };

    let app = Router::new().route("/", get(handler)).with_state(state);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    addr
}

/// メインハンドラー（main.rs のhandlerと同等）
async fn handler(
    State(state): State<TestState>,
    headers: HeaderMap,
    ws: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
) -> Response {
    use axum::response::IntoResponse;

    // WebSocket or HTTP
    match ws {
        Ok(ws) => {
            // WebSocket接続
            let conn_id = uuid::Uuid::now_v7().to_string();
            let relay = state.relay.clone();
            let limitation = state.limitation.clone();
            let owner_priority =
                std::sync::Arc::new(relay::owner_priority::OwnerPriority::new(None));
            ws.on_upgrade(move |socket| {
                relay::ws::handle_socket(
                    socket,
                    relay,
                    conn_id,
                    limitation,
                    owner_priority,
                    tokio_util::sync::CancellationToken::new(),
                )
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

/// NIP-11ハンドラー（main.rs と同等）
async fn handle_nip11(limitation: &relay::config::LimitationConfig) -> Response {
    use axum::http::{HeaderMap, HeaderValue, StatusCode};
    use axum::response::IntoResponse;

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
    match relay::nip11::RelayInformation::from_env_with_config(limitation) {
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

/// NIP-11エンドポイントの正常なレスポンステスト
#[tokio::test]
#[serial]
async fn test_nip11_valid_response() {
    // テスト用の環境変数設定
    unsafe {
        std::env::set_var(
            "RELAY_PUBKEY",
            "deadbeefcafebabe1234567890abcdef1234567890abcdef1234567890abcdef",
        );
        std::env::set_var("RELAY_NAME", "Test Relay");
        std::env::set_var("RELAY_DESCRIPTION", "A test Nostr relay");
        std::env::set_var("RELAY_CONTACT", "admin@example.com");
        std::env::set_var(
            "RELAY_SOFTWARE",
            "https://github.com/nisshiee/my-nostr-relay",
        );
        std::env::set_var("RELAY_VERSION", "2.0.0-test");
    }

    let addr = start_relay().await;
    let url = format!("http://{addr}/");

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("Accept", "application/nostr+json")
        .send()
        .await
        .expect("リクエストに失敗");

    // ステータスコードチェック
    assert_eq!(response.status(), 200);

    // CORSヘッダーチェック
    assert_eq!(
        response
            .headers()
            .get("Access-Control-Allow-Origin")
            .unwrap(),
        "*"
    );
    assert_eq!(
        response
            .headers()
            .get("Access-Control-Allow-Headers")
            .unwrap(),
        "Accept, Content-Type"
    );
    assert_eq!(
        response
            .headers()
            .get("Access-Control-Allow-Methods")
            .unwrap(),
        "GET, OPTIONS"
    );

    // Content-Typeチェック
    assert_eq!(
        response.headers().get("Content-Type").unwrap(),
        "application/json"
    );

    // レスポンスボディのJSONチェック
    let json: Value = response.json().await.expect("JSONパースに失敗");

    assert_eq!(json["name"], "Test Relay");
    assert_eq!(json["description"], "A test Nostr relay");
    assert_eq!(
        json["pubkey"],
        "deadbeefcafebabe1234567890abcdef1234567890abcdef1234567890abcdef"
    );
    assert_eq!(json["contact"], "admin@example.com");
    // supported_nipsは実装状況に基づく固定値（環境変数ではなくSUPPORTED_NIPS定数）
    assert_eq!(json["supported_nips"], json!([1, 9, 11, 70]));
    assert_eq!(
        json["software"],
        "https://github.com/nisshiee/my-nostr-relay"
    );
    assert_eq!(json["version"], "2.0.0-test");

    // limitation フィールドの検証
    let limitation = &json["limitation"];
    assert!(limitation.is_object(), "limitationフィールドが存在すること");
    assert_eq!(
        limitation["max_message_length"],
        relay::config::DEFAULT_MAX_MESSAGE_LENGTH
    );
    assert_eq!(
        limitation["max_subscriptions"],
        relay::config::DEFAULT_MAX_SUBSCRIPTIONS
    );
    assert_eq!(
        limitation["max_filters"],
        relay::config::DEFAULT_MAX_FILTERS
    );
    assert_eq!(
        limitation["max_subid_length"],
        relay::config::DEFAULT_MAX_SUBID_LENGTH
    );
    assert_eq!(
        limitation["max_event_tags"],
        relay::config::DEFAULT_MAX_EVENT_TAGS
    );
    assert_eq!(
        limitation["max_content_length"],
        relay::config::DEFAULT_MAX_CONTENT_LENGTH
    );
    assert_eq!(
        limitation["created_at_lower_limit"],
        relay::config::DEFAULT_CREATED_AT_LOWER_LIMIT
    );
    assert_eq!(
        limitation["created_at_upper_limit"],
        relay::config::DEFAULT_CREATED_AT_UPPER_LIMIT
    );

    // 環境変数クリーンアップ
    unsafe {
        std::env::remove_var("RELAY_PUBKEY");
        std::env::remove_var("RELAY_NAME");
        std::env::remove_var("RELAY_DESCRIPTION");
        std::env::remove_var("RELAY_CONTACT");
        std::env::remove_var("RELAY_SOFTWARE");
        std::env::remove_var("RELAY_VERSION");
    }
}

/// デフォルト値での NIP-11 レスポンステスト
#[tokio::test]
#[serial]
async fn test_nip11_default_values() {
    // 必須のPUBKEYのみ設定、他はデフォルト値を使用
    unsafe {
        std::env::set_var(
            "RELAY_PUBKEY",
            "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        );

        // 他の環境変数をクリア
        std::env::remove_var("RELAY_NAME");
        std::env::remove_var("RELAY_DESCRIPTION");
        std::env::remove_var("RELAY_CONTACT");
        std::env::remove_var("RELAY_SOFTWARE");
        std::env::remove_var("RELAY_VERSION");
    }

    let addr = start_relay().await;
    let url = format!("http://{addr}/");

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("Accept", "application/nostr+json")
        .send()
        .await
        .expect("リクエストに失敗");

    assert_eq!(response.status(), 200);
    let json: Value = response.json().await.expect("JSONパースに失敗");

    // デフォルト値をチェック
    assert_eq!(json["name"], "Nostr Relay");
    assert_eq!(json["description"], "A Nostr relay server");
    assert_eq!(
        json["pubkey"],
        "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
    );
    assert_eq!(json["contact"], "");
    // supported_nipsは実装状況に基づく固定値
    assert_eq!(json["supported_nips"], json!([1, 9, 11, 70]));
    assert_eq!(
        json["software"],
        "https://github.com/nisshiee/my-nostr-relay"
    );
    assert_eq!(json["version"], env!("CARGO_PKG_VERSION"));

    // クリーンアップ
    unsafe {
        std::env::remove_var("RELAY_PUBKEY");
    }
}

/// RELAY_PUBKEYが設定されていない場合のエラーレスポンステスト
#[tokio::test]
#[serial]
async fn test_nip11_missing_pubkey_error() {
    // すべての環境変数をクリア
    unsafe {
        std::env::remove_var("RELAY_PUBKEY");
        std::env::remove_var("RELAY_NAME");
        std::env::remove_var("RELAY_DESCRIPTION");
        std::env::remove_var("RELAY_CONTACT");
        std::env::remove_var("RELAY_SOFTWARE");
        std::env::remove_var("RELAY_VERSION");
    }

    let addr = start_relay().await;
    let url = format!("http://{addr}/");

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("Accept", "application/nostr+json")
        .send()
        .await
        .expect("リクエストに失敗");

    // エラー時も500ステータスだが、CORSヘッダーは付与される
    assert_eq!(response.status(), 500);

    // CORSヘッダーは設定されているはず
    assert_eq!(
        response
            .headers()
            .get("Access-Control-Allow-Origin")
            .unwrap(),
        "*"
    );

    let json: Value = response.json().await.expect("JSONパースに失敗");
    assert_eq!(json["error"], "Relay information not configured");
}

/// Accept ヘッダーが application/nostr+json でない場合の通常レスポンステスト
#[tokio::test]
async fn test_non_nip11_request() {
    let addr = start_relay().await;
    let url = format!("http://{addr}/");

    let client = reqwest::Client::new();

    // Accept ヘッダーなし
    let response1 = client.get(&url).send().await.expect("リクエストに失敗");
    assert_eq!(response1.status(), 200);
    let text1 = response1.text().await.expect("テキスト取得に失敗");
    assert_eq!(text1, "Hello, this is a regular HTTP response.");

    // 異なるAccept ヘッダー
    let response2 = client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .expect("リクエストに失敗");
    assert_eq!(response2.status(), 200);
    let text2 = response2.text().await.expect("テキスト取得に失敗");
    assert_eq!(text2, "Hello, this is a regular HTTP response.");
}

// RELAY_SUPPORTED_NIPS環境変数は廃止（supported_nipsは実装状況に基づく固定値）
