//! WebSocket 処理

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use futures::{SinkExt, StreamExt};
use tokio::sync::broadcast::error::RecvError;
use tracing::{debug, error, info, instrument, trace, warn};

use crate::models::{ClientMessage, Filter, RelayMessage, SubscriptionId};
use crate::relay::Relay;
use crate::store::SaveResult;

/// contentを50文字に切り詰め
fn truncate_content(content: &str) -> String {
    if content.chars().count() <= 50 {
        content.to_string()
    } else {
        format!("{}...", content.chars().take(50).collect::<String>())
    }
}

/// 各接続が保持するサブスクリプション状態
struct ConnectionState {
    subscriptions: HashMap<SubscriptionId, Vec<Filter>>,
}

impl ConnectionState {
    fn new() -> Self {
        Self {
            subscriptions: HashMap::new(),
        }
    }
}

/// WebSocket 接続を処理
#[instrument(skip(socket, relay), fields(connection_id = %conn_id))]
pub async fn handle_socket(socket: WebSocket, relay: Arc<Relay>, conn_id: String) {
    info!("WebSocket接続を確立");

    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut event_rx = relay.subscribe();
    let mut state = ConnectionState::new();

    loop {
        tokio::select! {
            // WebSocket からのメッセージ受信
            msg = ws_rx.next() => {
                let msg = match msg {
                    Some(Ok(msg)) => msg,
                    Some(Err(e)) => {
                        // WebSocket エラー
                        warn!(error = %e, "WebSocket受信エラー");
                        info!("WebSocket接続を切断");
                        return;
                    }
                    None => {
                        // クライアント切断
                        info!("WebSocket接続を切断");
                        return;
                    }
                };

                // Text メッセージのみ処理
                let text = match msg {
                    Message::Text(text) => text,
                    Message::Close(_) => {
                        info!("WebSocket接続を切断（クライアントからのClose）");
                        return;
                    }
                    Message::Ping(_) => {
                        trace!("Ping受信");
                        continue;
                    }
                    Message::Pong(_) => {
                        trace!("Pong受信");
                        continue;
                    }
                    _ => continue, // Binary は無視
                };

                trace!(raw_message = %text, "生メッセージ受信");

                // ClientMessage をパース
                let client_msg: ClientMessage = match serde_json::from_str(&text) {
                    Ok(msg) => msg,
                    Err(e) => {
                        // パースエラー時は NOTICE を送信
                        warn!(error = %e, "メッセージパースエラー");
                        let notice = RelayMessage::Notice(format!("パースエラー: {e}"));
                        if send_message(&mut ws_tx, &notice).await.is_err() {
                            return;
                        }
                        continue;
                    }
                };

                // メッセージ種別に応じた処理
                match client_msg {
                    ClientMessage::Event(event) => {
                        let event_id = event.id;
                        let kind = event.kind.as_u16();
                        let pubkey = event.pubkey.to_hex();
                        let content_preview = truncate_content(&event.content);

                        debug!(
                            event_id = %event_id,
                            kind = kind,
                            pubkey = %pubkey,
                            content = %content_preview,
                            "EVENTメッセージ受信"
                        );

                        // 署名検証
                        let verified = match event.verify() {
                            Ok(v) => v,
                            Err(e) => {
                                // 検証失敗
                                warn!(
                                    event_id = %event_id,
                                    error = %e,
                                    "署名検証失敗"
                                );
                                let ok_msg = RelayMessage::Ok {
                                    event_id,
                                    success: false,
                                    message: format!("invalid: {e}"),
                                };
                                if send_message(&mut ws_tx, &ok_msg).await.is_err() {
                                    return;
                                }
                                continue;
                            }
                        };

                        // 保存 & broadcast
                        match relay.publish(verified).await {
                            Ok(SaveResult::Saved) => {
                                info!(
                                    event_id = %event_id,
                                    kind = kind,
                                    "イベント保存成功"
                                );
                                let ok_msg = RelayMessage::Ok {
                                    event_id,
                                    success: true,
                                    message: String::new(),
                                };
                                if send_message(&mut ws_tx, &ok_msg).await.is_err() {
                                    return;
                                }
                            }
                            Ok(SaveResult::Duplicate) => {
                                debug!(
                                    event_id = %event_id,
                                    "重複イベント検出"
                                );
                                let ok_msg = RelayMessage::Ok {
                                    event_id,
                                    success: true,
                                    message: "duplicate: already have this event".to_string(),
                                };
                                if send_message(&mut ws_tx, &ok_msg).await.is_err() {
                                    return;
                                }
                            }
                            Ok(SaveResult::Replaced) => {
                                info!(
                                    event_id = %event_id,
                                    kind = kind,
                                    "イベント置換成功"
                                );
                                let ok_msg = RelayMessage::Ok {
                                    event_id,
                                    success: true,
                                    message: "replaced: updated existing event".to_string(),
                                };
                                if send_message(&mut ws_tx, &ok_msg).await.is_err() {
                                    return;
                                }
                            }
                            Ok(SaveResult::Ignored) => {
                                debug!(
                                    event_id = %event_id,
                                    "イベント無視（古いバージョン）"
                                );
                                let ok_msg = RelayMessage::Ok {
                                    event_id,
                                    success: true,
                                    message: "ignored: newer event exists".to_string(),
                                };
                                if send_message(&mut ws_tx, &ok_msg).await.is_err() {
                                    return;
                                }
                            }
                            Err(e) => {
                                error!(
                                    event_id = %event_id,
                                    error = %e,
                                    "イベント保存エラー"
                                );
                                let ok_msg = RelayMessage::Ok {
                                    event_id,
                                    success: false,
                                    message: format!("error: {e}"),
                                };
                                if send_message(&mut ws_tx, &ok_msg).await.is_err() {
                                    return;
                                }
                            }
                        }
                    }

                    ClientMessage::Req { subscription_id, filters } => {
                        debug!(
                            subscription_id = %subscription_id,
                            filter_count = filters.len(),
                            "REQメッセージ受信"
                        );

                        // サブスクリプション登録（既存は上書き）
                        state.subscriptions.insert(subscription_id.clone(), filters.clone());
                        info!(
                            subscription_id = %subscription_id,
                            filter_count = filters.len(),
                            "サブスクリプション作成"
                        );

                        // 既存イベントをクエリして送信
                        match relay.query(&filters).await {
                            Ok(events) => {
                                debug!(
                                    subscription_id = %subscription_id,
                                    result_count = events.len(),
                                    "クエリ結果送信"
                                );
                                for event in events {
                                    let event_msg = RelayMessage::Event {
                                        subscription_id: subscription_id.clone(),
                                        event,
                                    };
                                    if send_message(&mut ws_tx, &event_msg).await.is_err() {
                                        return;
                                    }
                                }
                            }
                            Err(e) => {
                                error!(
                                    subscription_id = %subscription_id,
                                    error = %e,
                                    "クエリエラー"
                                );
                                // NIP-01: REQエラー時はCLOSEDを送信
                                let closed = RelayMessage::Closed {
                                    subscription_id: subscription_id.clone(),
                                    message: format!("error: {e}"),
                                };
                                if send_message(&mut ws_tx, &closed).await.is_err() {
                                    return;
                                }
                                // エラー時はサブスクリプションを削除
                                state.subscriptions.remove(&subscription_id);
                                continue;
                            }
                        }

                        // EOSE を送信
                        trace!(subscription_id = %subscription_id, "EOSE送信");
                        let eose = RelayMessage::Eose(subscription_id);
                        if send_message(&mut ws_tx, &eose).await.is_err() {
                            return;
                        }
                    }

                    ClientMessage::Close(subscription_id) => {
                        debug!(subscription_id = %subscription_id, "CLOSEメッセージ受信");

                        // サブスクリプション削除
                        state.subscriptions.remove(&subscription_id);
                        info!(subscription_id = %subscription_id, "サブスクリプション削除");

                        // CLOSED を送信
                        let closed = RelayMessage::Closed {
                            subscription_id,
                            message: String::new(),
                        };
                        if send_message(&mut ws_tx, &closed).await.is_err() {
                            return;
                        }
                    }
                }
            }

            // broadcast からのイベント受信
            result = event_rx.recv() => {
                let event = match result {
                    Ok(event) => event,
                    Err(RecvError::Lagged(count)) => {
                        // メッセージ取りこぼし（キャパシティ超過）
                        warn!(
                            lagged_count = count,
                            "broadcastメッセージ取りこぼし"
                        );
                        continue;
                    }
                    Err(RecvError::Closed) => {
                        // チャネル閉鎖（通常は起こらない）
                        error!("broadcastチャネル閉鎖");
                        return;
                    }
                };

                // 自分のサブスクリプションとマッチング
                for (sub_id, filters) in &state.subscriptions {
                    if filters.iter().any(|f| f.matches(&event)) {
                        trace!(
                            subscription_id = %sub_id,
                            event_id = %event.id,
                            "broadcastイベントをクライアントに転送"
                        );
                        let event_msg = RelayMessage::Event {
                            subscription_id: sub_id.clone(),
                            event: event.clone(),
                        };
                        if send_message(&mut ws_tx, &event_msg).await.is_err() {
                            return;
                        }
                    }
                }
            }
        }
    }
}

/// RelayMessage を WebSocket で送信するヘルパー
async fn send_message<S>(ws_tx: &mut S, msg: &RelayMessage) -> Result<(), ()>
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::fmt::Debug,
{
    let json = serde_json::to_string(msg).map_err(|_| ())?;
    ws_tx.send(Message::Text(json.into())).await.map_err(|_| ())
}

#[cfg(test)]
mod tests {
    // WebSocket のテストは統合テストで行う
    // ユニットテストでは ConnectionState のみテスト

    use super::*;

    #[test]
    fn test_connection_state_new() {
        let state = ConnectionState::new();
        assert!(state.subscriptions.is_empty());
    }

    #[test]
    fn test_connection_state_insert_subscription() {
        let mut state = ConnectionState::new();
        let sub_id: SubscriptionId = "sub1".parse().unwrap();
        let filters = vec![Filter::default()];

        state.subscriptions.insert(sub_id.clone(), filters);
        assert!(state.subscriptions.contains_key(&sub_id));
    }

    #[test]
    fn test_connection_state_remove_subscription() {
        let mut state = ConnectionState::new();
        let sub_id: SubscriptionId = "sub1".parse().unwrap();
        let filters = vec![Filter::default()];

        state.subscriptions.insert(sub_id.clone(), filters);
        state.subscriptions.remove(&sub_id);
        assert!(!state.subscriptions.contains_key(&sub_id));
    }

    #[test]
    fn test_connection_state_overwrite_subscription() {
        let mut state = ConnectionState::new();
        let sub_id: SubscriptionId = "sub1".parse().unwrap();

        let filters1 = vec![Filter::default()];
        state.subscriptions.insert(sub_id.clone(), filters1);

        let filters2 = vec![
            Filter {
                limit: Some(10),
                ..Default::default()
            },
            Filter::default(),
        ];
        state.subscriptions.insert(sub_id.clone(), filters2);

        // 上書きされている
        let filters = state.subscriptions.get(&sub_id).unwrap();
        assert_eq!(filters.len(), 2);
        assert_eq!(filters[0].limit, Some(10));
    }
}
