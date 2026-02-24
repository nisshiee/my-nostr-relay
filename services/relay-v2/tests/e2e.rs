//! E2Eテスト: WebSocket経由でのリレー動作確認

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio::time::timeout;
use tokio_tungstenite::{connect_async, tungstenite::Message};

/// テスト用リレーサーバーを起動し、アドレスを返す
async fn start_relay() -> SocketAddr {
    start_relay_with_config(relay::config::LimitationConfig::default()).await
}

/// カスタム制限値設定でテスト用リレーサーバーを起動し、アドレスを返す
async fn start_relay_with_config(limitation: relay::config::LimitationConfig) -> SocketAddr {
    let store = relay::store::InMemoryEventStore::new();
    let relay_instance = Arc::new(relay::relay::Relay::new(store));
    let limitation = Arc::new(limitation);

    let app = axum::Router::new()
        .route(
            "/",
            axum::routing::get(
                move |ws: axum::extract::ws::WebSocketUpgrade| {
                    let relay_clone = relay_instance.clone();
                    let lim_clone = limitation.clone();
                    async move {
                        let conn_id = uuid::Uuid::now_v7().to_string();
                        ws.on_upgrade(move |socket| {
                            relay::ws::handle_socket(socket, relay_clone, conn_id, lim_clone)
                        })
                    }
                },
            ),
        );

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    addr
}

/// テスト用の有効なNostrイベントを生成
fn make_test_event(content: &str, kind: u64) -> Value {
    let secret_key_bytes =
        hex::decode("0000000000000000000000000000000000000000000000000000000000000001")
            .unwrap();
    let secp = secp256k1::Secp256k1::new();
    let secret_key =
        secp256k1::SecretKey::from_byte_array(secret_key_bytes.try_into().unwrap()).unwrap();
    let public_key = secp256k1::PublicKey::from_secret_key(&secp, &secret_key);
    let (xonly, _parity) = public_key.x_only_public_key();
    let pubkey_hex = hex::encode(xonly.serialize());

    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let tags: Vec<Vec<String>> = vec![];

    // イベントIDの計算: SHA256([0, pubkey, created_at, kind, tags, content])
    let serialized = json!([0, pubkey_hex, created_at, kind, tags, content]);
    let id_hash = Sha256::digest(serialized.to_string().as_bytes());
    let id_hex = hex::encode(id_hash);

    // Schnorr署名
    let keypair = secp256k1::Keypair::from_secret_key(&secp, &secret_key);
    let sig = secp.sign_schnorr_no_aux_rand(&id_hash, &keypair);
    let sig_hex = hex::encode(sig.to_byte_array());

    json!({
        "id": id_hex,
        "pubkey": pubkey_hex,
        "created_at": created_at,
        "kind": kind,
        "tags": tags,
        "content": content,
        "sig": sig_hex,
    })
}

/// テキストメッセージを送信するヘルパー
fn text_msg(v: &Value) -> Message {
    Message::Text(v.to_string().into())
}

/// WebSocketメッセージを受信（タイムアウト付き）
async fn recv_msg(
    ws: &mut futures::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
    timeout_ms: u64,
) -> Option<Value> {
    match timeout(Duration::from_millis(timeout_ms), ws.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str(&text).ok(),
        _ => None,
    }
}

/// EVENT送信→OK応答テスト
#[tokio::test]
async fn test_event_publish_and_ok_response() {
    let addr = start_relay().await;
    let url = format!("ws://{addr}/");

    let (ws, _) = connect_async(&url).await.expect("接続失敗");
    let (mut tx, mut rx) = ws.split();

    let event = make_test_event("hello nostr", 1);
    let msg = json!(["EVENT", event]);
    tx.send(text_msg(&msg)).await.unwrap();

    let resp = recv_msg(&mut rx, 3000).await.expect("OK応答が来ない");
    assert_eq!(resp[0], "OK");
    assert_eq!(resp[1], event["id"]);
    assert_eq!(resp[2], true);
}

/// REQ→EVENT→EOSEテスト
#[tokio::test]
async fn test_req_returns_stored_events() {
    let addr = start_relay().await;
    let url = format!("ws://{addr}/");

    let (ws, _) = connect_async(&url).await.expect("接続失敗");
    let (mut tx, mut rx) = ws.split();

    // イベント投稿
    let event = make_test_event("stored event", 1);
    tx.send(text_msg(&json!(["EVENT", event]))).await.unwrap();
    let _ = recv_msg(&mut rx, 3000).await; // OK消費

    // REQで取得
    tx.send(text_msg(&json!(["REQ", "sub1", {"kinds": [1]}])))
        .await
        .unwrap();

    // EVENT応答
    let resp = recv_msg(&mut rx, 3000).await.expect("EVENT応答が来ない");
    assert_eq!(resp[0], "EVENT");
    assert_eq!(resp[1], "sub1");
    assert_eq!(resp[2]["id"], event["id"]);

    // EOSE応答
    let eose = recv_msg(&mut rx, 3000).await.expect("EOSEが来ない");
    assert_eq!(eose[0], "EOSE");
    assert_eq!(eose[1], "sub1");
}

/// CLOSEでサブスクリプション解除後はbroadcastが届かないテスト
#[tokio::test]
async fn test_close_stops_broadcast() {
    let addr = start_relay().await;
    let url = format!("ws://{addr}/");

    // クライアントA: サブスクライバー
    let (ws_a, _) = connect_async(&url).await.expect("A接続失敗");
    let (mut tx_a, mut rx_a) = ws_a.split();

    // クライアントB: イベント送信者
    let (ws_b, _) = connect_async(&url).await.expect("B接続失敗");
    let (mut tx_b, mut rx_b) = ws_b.split();

    // A: サブスクリプション登録
    tx_a.send(text_msg(&json!(["REQ", "sub1", {"kinds": [1]}])))
        .await
        .unwrap();
    let eose = recv_msg(&mut rx_a, 3000).await.expect("EOSEが来ない");
    assert_eq!(eose[0], "EOSE");

    // A: CLOSE
    tx_a.send(text_msg(&json!(["CLOSE", "sub1"])))
        .await
        .unwrap();
    let closed = recv_msg(&mut rx_a, 3000).await.expect("CLOSEDが来ない");
    assert_eq!(closed[0], "CLOSED");

    // B: イベント送信
    let event = make_test_event("after close", 1);
    tx_b.send(text_msg(&json!(["EVENT", event])))
        .await
        .unwrap();
    let _ = recv_msg(&mut rx_b, 3000).await; // BのOK

    // A: broadcastが届かないことを確認
    let maybe = recv_msg(&mut rx_a, 1000).await;
    assert!(maybe.is_none(), "CLOSE後にbroadcastが届いてしまった");
}

/// 同一クライアントがサブスクライブ中に自分でEVENTを送信
/// → 自分自身にもbroadcastが届くか？
#[tokio::test]
async fn test_self_broadcast() {
    let addr = start_relay().await;
    let url = format!("ws://{addr}/");

    let (ws, _) = connect_async(&url).await.expect("接続失敗");
    let (mut tx, mut rx) = ws.split();

    // サブスクリプション登録
    tx.send(text_msg(&json!(["REQ", "self", {"kinds": [1]}])))
        .await
        .unwrap();
    let eose = recv_msg(&mut rx, 3000).await.expect("EOSEが来ない");
    assert_eq!(eose[0], "EOSE");

    // 自分でイベント送信
    let event = make_test_event("self broadcast test", 1);
    tx.send(text_msg(&json!(["EVENT", event]))).await.unwrap();

    // OK応答
    let ok = recv_msg(&mut rx, 3000).await.expect("OK応答が来ない");
    assert_eq!(ok[0], "OK");

    // 自分自身へのbroadcast
    let broadcast = recv_msg(&mut rx, 5000).await;
    assert!(
        broadcast.is_some(),
        "❌ 自分自身へのbroadcastが届かない！"
    );
    let broadcast = broadcast.unwrap();
    assert_eq!(broadcast[0], "EVENT");
    assert_eq!(broadcast[1], "self");
    assert_eq!(broadcast[2]["id"], event["id"]);
}

/// 複数フィルターのlimitが独立して適用されるテスト（NIP-01準拠）
#[tokio::test]
async fn test_multiple_filters_independent_limit() {
    let addr = start_relay().await;
    let url = format!("ws://{addr}/");

    let (ws, _) = connect_async(&url).await.expect("接続失敗");
    let (mut tx, mut rx) = ws.split();

    // kind=1を3件投稿
    for i in 0..3 {
        let event = make_test_event(&format!("kind1 msg {i}"), 1);
        tx.send(text_msg(&json!(["EVENT", event]))).await.unwrap();
        let _ = recv_msg(&mut rx, 3000).await;
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }

    // kind=2を3件投稿
    for i in 0..3 {
        let event = make_test_event(&format!("kind2 msg {i}"), 2);
        tx.send(text_msg(&json!(["EVENT", event]))).await.unwrap();
        let _ = recv_msg(&mut rx, 3000).await;
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }

    // REQ: kind=1をlimit=1、kind=2をlimit=2 → 合計3件のはず
    let req = json!(["REQ", "multi", {"kinds": [1], "limit": 1}, {"kinds": [2], "limit": 2}]);
    tx.send(text_msg(&req)).await.unwrap();

    let mut event_count = 0;
    loop {
        let msg = recv_msg(&mut rx, 3000).await.expect("応答が来ない");
        if msg[0] == "EOSE" {
            break;
        }
        assert_eq!(msg[0], "EVENT");
        event_count += 1;
    }
    assert_eq!(event_count, 3, "filter1のlimit=1 + filter2のlimit=2 = 3件");
}

/// REQの同一subscription_id上書きテスト（NIP-01準拠）
#[tokio::test]
async fn test_req_overwrite_subscription() {
    let addr = start_relay().await;
    let url = format!("ws://{addr}/");

    let (ws_a, _) = connect_async(&url).await.expect("A接続失敗");
    let (mut tx_a, mut rx_a) = ws_a.split();

    let (ws_b, _) = connect_async(&url).await.expect("B接続失敗");
    let (mut tx_b, mut rx_b) = ws_b.split();

    // A: kind=1をサブスクライブ
    tx_a.send(text_msg(&json!(["REQ", "s1", {"kinds": [1]}])))
        .await
        .unwrap();
    let eose = recv_msg(&mut rx_a, 3000).await.unwrap();
    assert_eq!(eose[0], "EOSE");

    // A: 同じsub_idでkind=2に上書き（kind=1は受け取らなくなるはず）
    tx_a.send(text_msg(&json!(["REQ", "s1", {"kinds": [2]}])))
        .await
        .unwrap();
    let eose2 = recv_msg(&mut rx_a, 3000).await.unwrap();
    assert_eq!(eose2[0], "EOSE");

    // B: kind=1のイベント送信
    let event1 = make_test_event("kind1 event", 1);
    tx_b.send(text_msg(&json!(["EVENT", event1]))).await.unwrap();
    let _ = recv_msg(&mut rx_b, 3000).await;

    // A: kind=1のbroadcastは届かないはず
    let maybe = recv_msg(&mut rx_a, 1000).await;
    assert!(maybe.is_none(), "上書き後にkind=1のbroadcastが届いてしまった");

    // B: kind=2のイベント送信
    let event2 = make_test_event("kind2 event", 2);
    tx_b.send(text_msg(&json!(["EVENT", event2]))).await.unwrap();
    let _ = recv_msg(&mut rx_b, 3000).await;

    // A: kind=2のbroadcastは届くはず
    let broadcast = recv_msg(&mut rx_a, 3000).await;
    assert!(broadcast.is_some(), "上書き後にkind=2のbroadcastが届かない");
    assert_eq!(broadcast.unwrap()[2]["content"], "kind2 event");
}

/// 不正JSONへのNOTICE応答テスト
#[tokio::test]
async fn test_invalid_json_returns_notice() {
    let addr = start_relay().await;
    let url = format!("ws://{addr}/");

    let (ws, _) = connect_async(&url).await.expect("接続失敗");
    let (mut tx, mut rx) = ws.split();

    // 不正なJSON
    tx.send(Message::Text("not json".into())).await.unwrap();
    let resp = recv_msg(&mut rx, 3000).await.expect("NOTICE応答が来ない");
    assert_eq!(resp[0], "NOTICE");

    // 不明なメッセージタイプ
    tx.send(text_msg(&json!(["UNKNOWN", "data"]))).await.unwrap();
    let resp2 = recv_msg(&mut rx, 3000).await.expect("NOTICE応答が来ない");
    assert_eq!(resp2[0], "NOTICE");
}

/// 重複イベントのOK応答テスト
#[tokio::test]
async fn test_duplicate_event_ok_response() {
    let addr = start_relay().await;
    let url = format!("ws://{addr}/");

    let (ws, _) = connect_async(&url).await.expect("接続失敗");
    let (mut tx, mut rx) = ws.split();

    let event = make_test_event("duplicate test", 1);

    // 1回目
    tx.send(text_msg(&json!(["EVENT", event]))).await.unwrap();
    let ok1 = recv_msg(&mut rx, 3000).await.unwrap();
    assert_eq!(ok1[0], "OK");
    assert_eq!(ok1[2], true);
    assert_eq!(ok1[3], "");

    // 2回目（重複）
    tx.send(text_msg(&json!(["EVENT", event]))).await.unwrap();
    let ok2 = recv_msg(&mut rx, 3000).await.unwrap();
    assert_eq!(ok2[0], "OK");
    assert_eq!(ok2[2], true);
    // NIP-01: duplicate: プレフィックス
    let msg = ok2[3].as_str().unwrap();
    assert!(msg.starts_with("duplicate:"), "duplicate prefixがない: {msg}");
}

/// 不正署名のイベントへのOK(false)応答テスト
#[tokio::test]
async fn test_invalid_signature_ok_response() {
    let addr = start_relay().await;
    let url = format!("ws://{addr}/");

    let (ws, _) = connect_async(&url).await.expect("接続失敗");
    let (mut tx, mut rx) = ws.split();

    // 有効なイベントを作ってからcontentを改ざん（sigが合わなくなる）
    let mut event = make_test_event("original", 1);
    event["content"] = json!("tampered");

    tx.send(text_msg(&json!(["EVENT", event]))).await.unwrap();
    let ok = recv_msg(&mut rx, 3000).await.unwrap();
    assert_eq!(ok[0], "OK");
    assert_eq!(ok[2], false);
    let msg = ok[3].as_str().unwrap();
    assert!(msg.starts_with("invalid:"), "invalid prefixがない: {msg}");
}

/// 💥 即時イベントリレーテスト（バグ再現用）
/// クライアントAがサブスクライブ中に、クライアントBがイベントを送信
/// → AにbroadcastでEVENTが届くか？
#[tokio::test]
async fn test_realtime_broadcast_between_clients() {
    let addr = start_relay().await;
    let url = format!("ws://{addr}/");

    // クライアントA: サブスクライバー
    let (ws_a, _) = connect_async(&url).await.expect("A接続失敗");
    let (mut tx_a, mut rx_a) = ws_a.split();

    // クライアントB: イベント送信者
    let (ws_b, _) = connect_async(&url).await.expect("B接続失敗");
    let (mut tx_b, mut rx_b) = ws_b.split();

    // A: kind=1のサブスクリプション登録
    tx_a.send(text_msg(&json!(["REQ", "live", {"kinds": [1]}])))
        .await
        .unwrap();

    // A: EOSE待ち
    let eose = recv_msg(&mut rx_a, 3000).await.expect("EOSEが来ない");
    assert_eq!(eose[0], "EOSE");

    // B: イベント送信
    let event = make_test_event("realtime test", 1);
    tx_b.send(text_msg(&json!(["EVENT", event])))
        .await
        .unwrap();

    // B: OK応答
    let ok = recv_msg(&mut rx_b, 3000).await.expect("BのOK応答が来ない");
    assert_eq!(ok[0], "OK");
    assert_eq!(ok[2], true);

    // 💥 A: broadcastされたイベントを受信できるか？
    let broadcast = recv_msg(&mut rx_a, 5000).await;
    assert!(
        broadcast.is_some(),
        "❌ リアルタイムbroadcastが届かない！（バグ再現）"
    );
    let broadcast = broadcast.unwrap();
    assert_eq!(broadcast[0], "EVENT");
    assert_eq!(broadcast[1], "live");
    assert_eq!(broadcast[2]["id"], event["id"]);
    assert_eq!(broadcast[2]["content"], "realtime test");
}

/// Replaceable イベント（kind=0）を2回送信し、REQで最新1件のみ返ることを確認
#[tokio::test]
async fn test_replaceable_event_returns_latest_only() {
    let addr = start_relay().await;
    let url = format!("ws://{addr}/");

    let (ws, _) = connect_async(&url).await.expect("接続失敗");
    let (mut tx, mut rx) = ws.split();

    // 1回目: kind=0 (replaceable) イベント送信
    let event1 = make_test_event("old profile", 0);
    tx.send(text_msg(&json!(["EVENT", event1]))).await.unwrap();
    let ok1 = recv_msg(&mut rx, 3000).await.unwrap();
    assert_eq!(ok1[0], "OK");
    assert_eq!(ok1[2], true);

    // 少し待って created_at が変わるようにする
    tokio::time::sleep(Duration::from_millis(1100)).await;

    // 2回目: kind=0 イベント送信（新しい created_at で置換されるはず）
    let event2 = make_test_event("new profile", 0);
    tx.send(text_msg(&json!(["EVENT", event2]))).await.unwrap();
    let ok2 = recv_msg(&mut rx, 3000).await.unwrap();
    assert_eq!(ok2[0], "OK");
    assert_eq!(ok2[2], true);

    // REQ: kind=0 で検索
    tx.send(text_msg(&json!(["REQ", "profile", {"kinds": [0]}])))
        .await
        .unwrap();

    let mut events = vec![];
    loop {
        let msg = recv_msg(&mut rx, 3000).await.expect("応答が来ない");
        if msg[0] == "EOSE" {
            break;
        }
        assert_eq!(msg[0], "EVENT");
        events.push(msg);
    }

    // 最新1件のみ返る
    assert_eq!(events.len(), 1, "Replaceableイベントは最新1件のみ返るべき");
    assert_eq!(events[0][2]["content"], "new profile");
}

// ===========================================
// 制限値 (limitation) E2Eテスト
// ===========================================

/// タグ付きテストイベントを作成
fn make_test_event_with_tags(content: &str, kind: u64, tags: Vec<Vec<&str>>) -> Value {
    let secret_key_bytes =
        hex::decode("0000000000000000000000000000000000000000000000000000000000000001")
            .unwrap();
    let secp = secp256k1::Secp256k1::new();
    let secret_key =
        secp256k1::SecretKey::from_byte_array(secret_key_bytes.try_into().unwrap()).unwrap();
    let public_key = secp256k1::PublicKey::from_secret_key(&secp, &secret_key);
    let (xonly, _parity) = public_key.x_only_public_key();
    let pubkey_hex = hex::encode(xonly.serialize());

    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let serialized = json!([0, pubkey_hex, created_at, kind, tags, content]);
    let id_hash = Sha256::digest(serialized.to_string().as_bytes());
    let id_hex = hex::encode(id_hash);

    let keypair = secp256k1::Keypair::from_secret_key(&secp, &secret_key);
    let sig = secp.sign_schnorr_no_aux_rand(&id_hash, &keypair);
    let sig_hex = hex::encode(sig.to_byte_array());

    json!({
        "id": id_hex,
        "pubkey": pubkey_hex,
        "created_at": created_at,
        "kind": kind,
        "tags": tags,
        "content": content,
        "sig": sig_hex,
    })
}

/// カスタムcreated_atのテストイベント作成
fn make_test_event_with_timestamp(content: &str, kind: u64, created_at: u64) -> Value {
    let secret_key_bytes =
        hex::decode("0000000000000000000000000000000000000000000000000000000000000001")
            .unwrap();
    let secp = secp256k1::Secp256k1::new();
    let secret_key =
        secp256k1::SecretKey::from_byte_array(secret_key_bytes.try_into().unwrap()).unwrap();
    let public_key = secp256k1::PublicKey::from_secret_key(&secp, &secret_key);
    let (xonly, _parity) = public_key.x_only_public_key();
    let pubkey_hex = hex::encode(xonly.serialize());

    let tags: Vec<Vec<String>> = vec![];

    let serialized = json!([0, pubkey_hex, created_at, kind, tags, content]);
    let id_hash = Sha256::digest(serialized.to_string().as_bytes());
    let id_hex = hex::encode(id_hash);

    let keypair = secp256k1::Keypair::from_secret_key(&secp, &secret_key);
    let sig = secp.sign_schnorr_no_aux_rand(&id_hash, &keypair);
    let sig_hex = hex::encode(sig.to_byte_array());

    json!({
        "id": id_hex,
        "pubkey": pubkey_hex,
        "created_at": created_at,
        "kind": kind,
        "tags": tags,
        "content": content,
        "sig": sig_hex,
    })
}

/// max_message_length 制限テスト
#[tokio::test]
async fn test_limitation_max_message_length() {
    let config = relay::config::LimitationConfig {
        max_message_length: 100, // 非常に小さい制限
        ..Default::default()
    };
    let addr = start_relay_with_config(config).await;
    let url = format!("ws://127.0.0.1:{}/", addr.port());

    let (ws, _) = connect_async(&url).await.unwrap();
    let (mut tx, mut rx) = ws.split();

    // 制限を超えるメッセージを送信
    let long_msg = "a".repeat(200);
    tx.send(Message::Text(long_msg.into())).await.unwrap();

    let resp = recv_msg(&mut rx, 2000).await.expect("NOTICEが返るべき");
    assert_eq!(resp[0], "NOTICE");
    assert!(resp[1].as_str().unwrap().contains("長すぎます"));
}

/// max_event_tags 制限テスト
#[tokio::test]
async fn test_limitation_max_event_tags() {
    let config = relay::config::LimitationConfig {
        max_event_tags: 2, // タグ最大2個
        ..Default::default()
    };
    let addr = start_relay_with_config(config).await;
    let url = format!("ws://127.0.0.1:{}/", addr.port());

    let (ws, _) = connect_async(&url).await.unwrap();
    let (mut tx, mut rx) = ws.split();

    // 3個のタグを持つイベント → 拒否されるべき
    let tags = vec![vec!["e", "a"], vec!["e", "b"], vec!["e", "c"]];
    let event = make_test_event_with_tags("test", 1, tags);
    let msg = json!(["EVENT", event]);
    tx.send(text_msg(&msg)).await.unwrap();

    let resp = recv_msg(&mut rx, 2000).await.expect("OK(false)が返るべき");
    assert_eq!(resp[0], "OK");
    assert_eq!(resp[2], false);
    assert!(resp[3].as_str().unwrap().contains("too many tags"));
}

/// max_content_length 制限テスト
#[tokio::test]
async fn test_limitation_max_content_length() {
    let config = relay::config::LimitationConfig {
        max_content_length: 10, // コンテンツ最大10文字
        max_message_length: 1048576, // メッセージ長は十分大きく
        ..Default::default()
    };
    let addr = start_relay_with_config(config).await;
    let url = format!("ws://127.0.0.1:{}/", addr.port());

    let (ws, _) = connect_async(&url).await.unwrap();
    let (mut tx, mut rx) = ws.split();

    // 11文字のコンテンツ → 拒否
    let event = make_test_event("12345678901", 1);
    let msg = json!(["EVENT", event]);
    tx.send(text_msg(&msg)).await.unwrap();

    let resp = recv_msg(&mut rx, 2000).await.expect("OK(false)が返るべき");
    assert_eq!(resp[0], "OK");
    assert_eq!(resp[2], false);
    assert!(resp[3].as_str().unwrap().contains("content too long"));
}

/// max_subscriptions 制限テスト
#[tokio::test]
async fn test_limitation_max_subscriptions() {
    let config = relay::config::LimitationConfig {
        max_subscriptions: 2, // 最大2サブスクリプション
        ..Default::default()
    };
    let addr = start_relay_with_config(config).await;
    let url = format!("ws://127.0.0.1:{}/", addr.port());

    let (ws, _) = connect_async(&url).await.unwrap();
    let (mut tx, mut rx) = ws.split();

    // サブスクリプション1
    let req1 = json!(["REQ", "sub1", {"kinds": [1]}]);
    tx.send(text_msg(&req1)).await.unwrap();
    let resp1 = recv_msg(&mut rx, 2000).await.unwrap();
    assert_eq!(resp1[0], "EOSE"); // 成功

    // サブスクリプション2
    let req2 = json!(["REQ", "sub2", {"kinds": [1]}]);
    tx.send(text_msg(&req2)).await.unwrap();
    let resp2 = recv_msg(&mut rx, 2000).await.unwrap();
    assert_eq!(resp2[0], "EOSE"); // 成功

    // サブスクリプション3 → 拒否
    let req3 = json!(["REQ", "sub3", {"kinds": [1]}]);
    tx.send(text_msg(&req3)).await.unwrap();
    let resp3 = recv_msg(&mut rx, 2000).await.unwrap();
    assert_eq!(resp3[0], "CLOSED");
    assert!(resp3[2].as_str().unwrap().contains("too many subscriptions"));
}

/// max_filters 制限テスト
#[tokio::test]
async fn test_limitation_max_filters() {
    let config = relay::config::LimitationConfig {
        max_filters: 2, // フィルタ最大2個
        ..Default::default()
    };
    let addr = start_relay_with_config(config).await;
    let url = format!("ws://127.0.0.1:{}/", addr.port());

    let (ws, _) = connect_async(&url).await.unwrap();
    let (mut tx, mut rx) = ws.split();

    // 3個のフィルタ → 拒否
    let req = json!(["REQ", "sub1", {"kinds": [1]}, {"kinds": [2]}, {"kinds": [3]}]);
    tx.send(text_msg(&req)).await.unwrap();

    let resp = recv_msg(&mut rx, 2000).await.unwrap();
    assert_eq!(resp[0], "CLOSED");
    assert!(resp[2].as_str().unwrap().contains("too many filters"));
}

/// created_at_lower_limit 制限テスト
#[tokio::test]
async fn test_limitation_created_at_too_old() {
    let config = relay::config::LimitationConfig {
        created_at_lower_limit: 3600, // 1時間前まで
        ..Default::default()
    };
    let addr = start_relay_with_config(config).await;
    let url = format!("ws://127.0.0.1:{}/", addr.port());

    let (ws, _) = connect_async(&url).await.unwrap();
    let (mut tx, mut rx) = ws.split();

    // 2時間前のイベント → 拒否
    let two_hours_ago = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() - 7200;
    let event = make_test_event_with_timestamp("old event", 1, two_hours_ago);
    let msg = json!(["EVENT", event]);
    tx.send(text_msg(&msg)).await.unwrap();

    let resp = recv_msg(&mut rx, 2000).await.expect("OK(false)が返るべき");
    assert_eq!(resp[0], "OK");
    assert_eq!(resp[2], false);
    assert!(resp[3].as_str().unwrap().contains("too old"));
}

/// created_at_upper_limit 制限テスト
#[tokio::test]
async fn test_limitation_created_at_too_future() {
    let config = relay::config::LimitationConfig {
        created_at_upper_limit: 60, // 1分先まで
        ..Default::default()
    };
    let addr = start_relay_with_config(config).await;
    let url = format!("ws://127.0.0.1:{}/", addr.port());

    let (ws, _) = connect_async(&url).await.unwrap();
    let (mut tx, mut rx) = ws.split();

    // 5分後のイベント → 拒否
    let five_min_future = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() + 300;
    let event = make_test_event_with_timestamp("future event", 1, five_min_future);
    let msg = json!(["EVENT", event]);
    tx.send(text_msg(&msg)).await.unwrap();

    let resp = recv_msg(&mut rx, 2000).await.expect("OK(false)が返るべき");
    assert_eq!(resp[0], "OK");
    assert_eq!(resp[2], false);
    assert!(resp[3].as_str().unwrap().contains("too far in the future"));
}

/// max_subscriptions: 既存IDの上書きはカウントしないテスト
#[tokio::test]
async fn test_limitation_subscription_overwrite_not_counted() {
    let config = relay::config::LimitationConfig {
        max_subscriptions: 1, // 最大1サブスクリプション
        ..Default::default()
    };
    let addr = start_relay_with_config(config).await;
    let url = format!("ws://127.0.0.1:{}/", addr.port());

    let (ws, _) = connect_async(&url).await.unwrap();
    let (mut tx, mut rx) = ws.split();

    // サブスクリプション1
    let req1 = json!(["REQ", "sub1", {"kinds": [1]}]);
    tx.send(text_msg(&req1)).await.unwrap();
    let resp1 = recv_msg(&mut rx, 2000).await.unwrap();
    assert_eq!(resp1[0], "EOSE");

    // 同じIDで上書き → 成功するべき
    let req2 = json!(["REQ", "sub1", {"kinds": [2]}]);
    tx.send(text_msg(&req2)).await.unwrap();
    let resp2 = recv_msg(&mut rx, 2000).await.unwrap();
    assert_eq!(resp2[0], "EOSE");
}
