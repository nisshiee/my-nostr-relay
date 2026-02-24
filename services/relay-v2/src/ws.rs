//! WebSocket 処理

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use futures::{SinkExt, StreamExt};
use tokio::sync::broadcast::error::RecvError;
use tracing::{debug, error, info, instrument, trace, warn};

use crate::config::LimitationConfig;
use crate::models::{ClientMessage, Event, Filter, RelayMessage, SubscriptionId};
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

/// イベントのタグ数を検証する。制限超過時は拒否メッセージを返す。
fn check_event_tags(event: &Event, limitation: &LimitationConfig) -> Option<RelayMessage> {
    if event.tags.len() > limitation.max_event_tags as usize {
        warn!(
            event_id = %event.id,
            tag_count = event.tags.len(),
            max = limitation.max_event_tags,
            "タグ数が制限を超過"
        );
        Some(RelayMessage::Ok {
            event_id: event.id,
            success: false,
            message: format!(
                "invalid: too many tags ({}, max {})",
                event.tags.len(), limitation.max_event_tags
            ),
        })
    } else {
        None
    }
}

/// イベントのコンテンツ長を検証する。制限超過時は拒否メッセージを返す。
fn check_content_length(event: &Event, limitation: &LimitationConfig) -> Option<RelayMessage> {
    let content_chars = event.content.chars().count();
    if content_chars > limitation.max_content_length as usize {
        warn!(
            event_id = %event.id,
            content_length = content_chars,
            max = limitation.max_content_length,
            "コンテンツ長が制限を超過"
        );
        Some(RelayMessage::Ok {
            event_id: event.id,
            success: false,
            message: format!(
                "invalid: content too long ({} chars, max {})",
                content_chars, limitation.max_content_length
            ),
        })
    } else {
        None
    }
}

/// イベントのcreated_atを検証する。範囲外の場合は拒否メッセージを返す。
fn check_created_at(event: &Event, limitation: &LimitationConfig) -> Option<RelayMessage> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let event_ts = event.created_at.as_i64();

    // 過去制限
    let lower_bound = now.saturating_sub(limitation.created_at_lower_limit);
    if event_ts < lower_bound as i64 {
        warn!(
            event_id = %event.id,
            created_at = event_ts,
            lower_bound = lower_bound,
            "created_atが古すぎる"
        );
        return Some(RelayMessage::Ok {
            event_id: event.id,
            success: false,
            message: format!(
                "invalid: event is too old (created_at_lower_limit: {}s)",
                limitation.created_at_lower_limit
            ),
        });
    }

    // 未来制限
    let upper_bound = now.saturating_add(limitation.created_at_upper_limit);
    if event_ts > upper_bound as i64 {
        warn!(
            event_id = %event.id,
            created_at = event_ts,
            upper_bound = upper_bound,
            "created_atが未来すぎる"
        );
        return Some(RelayMessage::Ok {
            event_id: event.id,
            success: false,
            message: format!(
                "invalid: event is too far in the future (created_at_upper_limit: {}s)",
                limitation.created_at_upper_limit
            ),
        });
    }

    None
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
#[instrument(skip(socket, relay, limitation), fields(connection_id = %conn_id))]
pub async fn handle_socket(socket: WebSocket, relay: Arc<Relay>, conn_id: String, limitation: Arc<LimitationConfig>) {
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

                // max_message_length チェック
                let msg_len = text.len();
                if msg_len > limitation.max_message_length as usize {
                    warn!(
                        message_length = msg_len,
                        max = limitation.max_message_length,
                        "メッセージ長が制限を超過"
                    );
                    let notice = RelayMessage::Notice(
                        format!("メッセージが長すぎます: {}バイト（上限: {}バイト）", msg_len, limitation.max_message_length)
                    );
                    if send_message(&mut ws_tx, &notice).await.is_err() {
                        return;
                    }
                    continue;
                }

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

                        // 制限値チェック: タグ数
                        if let Some(reject) = check_event_tags(&event, &limitation) {
                            if send_message(&mut ws_tx, &reject).await.is_err() {
                                return;
                            }
                            continue;
                        }

                        // 制限値チェック: コンテンツ長
                        if let Some(reject) = check_content_length(&event, &limitation) {
                            if send_message(&mut ws_tx, &reject).await.is_err() {
                                return;
                            }
                            continue;
                        }

                        // 制限値チェック: created_at（過去・未来）
                        if let Some(reject) = check_created_at(&event, &limitation) {
                            if send_message(&mut ws_tx, &reject).await.is_err() {
                                return;
                            }
                            continue;
                        }

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

                        // NIP-70: 保護イベントチェック
                        // `["-"]` タグ付きイベントはNIP-42認証済みの著者のみが投稿可能。
                        // NIP-42未実装のため、保護イベントはすべて拒否する。
                        if verified.is_protected() {
                            warn!(
                                event_id = %event_id,
                                "保護イベントを拒否（NIP-42未実装）"
                            );
                            let ok_msg = RelayMessage::Ok {
                                event_id,
                                success: false,
                                message: "blocked: this relay does not accept protected events. NIP-42 authentication is not supported.".to_string(),
                            };
                            if send_message(&mut ws_tx, &ok_msg).await.is_err() {
                                return;
                            }
                            continue;
                        }

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
                            Ok(SaveResult::Ephemeral) => {
                                debug!(
                                    event_id = %event_id,
                                    kind = kind,
                                    "ephemeralイベント配信完了"
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

                        // 制限値チェック: フィルタ数
                        if filters.len() > limitation.max_filters as usize {
                            warn!(
                                subscription_id = %subscription_id,
                                filter_count = filters.len(),
                                max = limitation.max_filters,
                                "フィルタ数が制限を超過"
                            );
                            let closed = RelayMessage::Closed {
                                subscription_id,
                                message: format!(
                                    "error: too many filters ({}, max {})",
                                    filters.len(), limitation.max_filters
                                ),
                            };
                            if send_message(&mut ws_tx, &closed).await.is_err() {
                                return;
                            }
                            continue;
                        }

                        // 制限値チェック: サブスクリプション数
                        // 同じIDの上書きは数に含めない
                        if !state.subscriptions.contains_key(&subscription_id)
                            && state.subscriptions.len() >= limitation.max_subscriptions as usize
                        {
                            warn!(
                                subscription_id = %subscription_id,
                                current = state.subscriptions.len(),
                                max = limitation.max_subscriptions,
                                "サブスクリプション数が制限を超過"
                            );
                            let closed = RelayMessage::Closed {
                                subscription_id,
                                message: format!(
                                    "error: too many subscriptions ({}, max {})",
                                    state.subscriptions.len(), limitation.max_subscriptions
                                ),
                            };
                            if send_message(&mut ws_tx, &closed).await.is_err() {
                                return;
                            }
                            continue;
                        }

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
