use serde::{
    de::{self, Visitor},
    ser::SerializeSeq,
    Deserialize, Serialize,
};
use thiserror::Error;

/// クライアントメッセージのパースエラー
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ClientMessageParseError {
    /// メッセージ配列が空
    #[error("メッセージ配列が空です")]
    EmptyArray,

    /// 未知のメッセージタイプ
    #[error("未知のメッセージタイプ: {0}")]
    UnknownMessageType(String),

    /// EVENTメッセージにイベントがない
    #[error("EVENTメッセージにイベントがありません")]
    EventMissingEvent,

    /// EVENTメッセージに余分な要素がある
    #[error("EVENTメッセージに余分な要素があります")]
    EventExtraElements,

    /// REQメッセージにsubscription_idがない
    #[error("REQメッセージにsubscription_idがありません")]
    ReqMissingSubscriptionId,

    /// REQメッセージにフィルターがない
    #[error("REQメッセージには少なくとも1つのフィルターが必要です")]
    ReqMissingFilter,

    /// CLOSEメッセージにsubscription_idがない
    #[error("CLOSEメッセージにsubscription_idがありません")]
    CloseMissingSubscriptionId,

    /// CLOSEメッセージに余分な要素がある
    #[error("CLOSEメッセージに余分な要素があります")]
    CloseExtraElements,
}

/// NIP-01 クライアントからリレーへのメッセージ
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientMessage {
    /// イベント発行: ["EVENT", <event JSON>]
    Event(super::Event),

    /// 購読要求: ["REQ", <subscription_id>, <filters...>]
    Req {
        subscription_id: super::SubscriptionId,
        filters: Vec<super::Filter>,
    },

    /// 購読終了: ["CLOSE", <subscription_id>]
    Close(super::SubscriptionId),
}

impl Serialize for ClientMessage {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            ClientMessage::Event(event) => {
                let mut seq = serializer.serialize_seq(Some(2))?;
                seq.serialize_element("EVENT")?;
                seq.serialize_element(event)?;
                seq.end()
            }
            ClientMessage::Req {
                subscription_id,
                filters,
            } => {
                let mut seq = serializer.serialize_seq(Some(2 + filters.len()))?;
                seq.serialize_element("REQ")?;
                seq.serialize_element(subscription_id)?;
                for filter in filters {
                    seq.serialize_element(filter)?;
                }
                seq.end()
            }
            ClientMessage::Close(subscription_id) => {
                let mut seq = serializer.serialize_seq(Some(2))?;
                seq.serialize_element("CLOSE")?;
                seq.serialize_element(subscription_id)?;
                seq.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for ClientMessage {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct ClientMessageVisitor;

        impl<'de> Visitor<'de> for ClientMessageVisitor {
            type Value = ClientMessage;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a Nostr client message array")
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: de::SeqAccess<'de>,
            {
                // 最初の要素（メッセージタイプ）を取得
                let message_type: String = seq
                    .next_element()?
                    .ok_or_else(|| de::Error::custom(ClientMessageParseError::EmptyArray))?;

                match message_type.as_str() {
                    "EVENT" => {
                        // イベントを取得
                        let event: super::Event = seq.next_element()?.ok_or_else(|| {
                            de::Error::custom(ClientMessageParseError::EventMissingEvent)
                        })?;

                        // 余分な要素がないか確認
                        if seq.next_element::<serde::de::IgnoredAny>()?.is_some() {
                            return Err(de::Error::custom(
                                ClientMessageParseError::EventExtraElements,
                            ));
                        }

                        Ok(ClientMessage::Event(event))
                    }
                    "REQ" => {
                        // subscription_idを取得
                        let subscription_id: super::SubscriptionId =
                            seq.next_element()?.ok_or_else(|| {
                                de::Error::custom(ClientMessageParseError::ReqMissingSubscriptionId)
                            })?;

                        // フィルターを収集
                        let mut filters = Vec::new();
                        while let Some(filter) = seq.next_element::<super::Filter>()? {
                            filters.push(filter);
                        }

                        // 少なくとも1つのフィルターが必要
                        if filters.is_empty() {
                            return Err(de::Error::custom(
                                ClientMessageParseError::ReqMissingFilter,
                            ));
                        }

                        Ok(ClientMessage::Req {
                            subscription_id,
                            filters,
                        })
                    }
                    "CLOSE" => {
                        // subscription_idを取得
                        let subscription_id: super::SubscriptionId =
                            seq.next_element()?.ok_or_else(|| {
                                de::Error::custom(
                                    ClientMessageParseError::CloseMissingSubscriptionId,
                                )
                            })?;

                        // 余分な要素がないか確認
                        if seq.next_element::<serde::de::IgnoredAny>()?.is_some() {
                            return Err(de::Error::custom(
                                ClientMessageParseError::CloseExtraElements,
                            ));
                        }

                        Ok(ClientMessage::Close(subscription_id))
                    }
                    _ => Err(de::Error::custom(ClientMessageParseError::UnknownMessageType(
                        message_type,
                    ))),
                }
            }
        }

        deserializer.deserialize_seq(ClientMessageVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ========== テスト用ヘルパー ==========

    /// 有効なテストイベントを作成
    fn create_test_event() -> super::super::Event {
        use secp256k1::{Keypair, Secp256k1, SecretKey};
        use sha2::{Digest, Sha256};

        let secret_bytes = [
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
            0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
            0x1d, 0x1e, 0x1f, 0x20,
        ];
        let secret_key = SecretKey::from_byte_array(secret_bytes).unwrap();
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret_key);
        let (x_only_pubkey, _parity) = keypair.x_only_public_key();

        let pubkey_hex = hex::encode(x_only_pubkey.serialize());
        let created_at: i64 = 1234567890;
        let kind: u16 = 1;
        let tags: Vec<Vec<String>> = vec![];
        let content = "Hello, Nostr!";

        let serializable = serde_json::json!([0, pubkey_hex, created_at, kind, tags, content,]);
        let json_str = serde_json::to_string(&serializable).unwrap();
        let mut hasher = Sha256::new();
        hasher.update(json_str.as_bytes());
        let id_bytes: [u8; 32] = hasher.finalize().into();

        let sig = secp.sign_schnorr_no_aux_rand(&id_bytes, &keypair);

        let event_json = serde_json::json!({
            "id": hex::encode(id_bytes),
            "pubkey": pubkey_hex,
            "created_at": created_at,
            "kind": kind,
            "tags": tags,
            "content": content,
            "sig": hex::encode(sig.to_byte_array())
        });

        serde_json::from_value(event_json).unwrap()
    }

    // ========== EVENT 正常系 ==========

    #[test]
    fn test_event_deserialize() {
        let event = create_test_event();
        let event_json = serde_json::to_value(&event).unwrap();
        let message_json = serde_json::json!(["EVENT", event_json]);

        let message: ClientMessage = serde_json::from_value(message_json).unwrap();
        match message {
            ClientMessage::Event(e) => assert_eq!(e, event),
            _ => panic!("Expected Event message"),
        }
    }

    #[test]
    fn test_event_serialize() {
        let event = create_test_event();
        let message = ClientMessage::Event(event.clone());

        let json = serde_json::to_value(&message).unwrap();
        assert!(json.is_array());
        let arr = json.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0], "EVENT");

        // イベント部分が正しくシリアライズされているか確認
        let serialized_event: super::super::Event = serde_json::from_value(arr[1].clone()).unwrap();
        assert_eq!(serialized_event, event);
    }

    #[test]
    fn test_event_roundtrip() {
        let event = create_test_event();
        let original = ClientMessage::Event(event);

        let json = serde_json::to_string(&original).unwrap();
        let restored: ClientMessage = serde_json::from_str(&json).unwrap();

        assert_eq!(original, restored);
    }

    // ========== REQ 正常系 ==========

    #[test]
    fn test_req_single_filter_deserialize() {
        let json = r#"["REQ", "sub1", {"kinds": [1]}]"#;
        let message: ClientMessage = serde_json::from_str(json).unwrap();

        match message {
            ClientMessage::Req {
                subscription_id,
                filters,
            } => {
                assert_eq!(subscription_id.as_str(), "sub1");
                assert_eq!(filters.len(), 1);
                assert!(filters[0].kinds.is_some());
            }
            _ => panic!("Expected Req message"),
        }
    }

    #[test]
    fn test_req_multiple_filters_deserialize() {
        let json = r#"["REQ", "sub1", {"kinds": [1]}, {"kinds": [2]}, {"authors": []}]"#;
        let message: ClientMessage = serde_json::from_str(json).unwrap();

        match message {
            ClientMessage::Req {
                subscription_id,
                filters,
            } => {
                assert_eq!(subscription_id.as_str(), "sub1");
                assert_eq!(filters.len(), 3);
            }
            _ => panic!("Expected Req message"),
        }
    }

    #[test]
    fn test_req_empty_filter_deserialize() {
        // 空のフィルター {} も有効
        let json = r#"["REQ", "sub1", {}]"#;
        let message: ClientMessage = serde_json::from_str(json).unwrap();

        match message {
            ClientMessage::Req {
                subscription_id,
                filters,
            } => {
                assert_eq!(subscription_id.as_str(), "sub1");
                assert_eq!(filters.len(), 1);
                assert_eq!(filters[0], super::super::Filter::default());
            }
            _ => panic!("Expected Req message"),
        }
    }

    #[test]
    fn test_req_serialize() {
        let subscription_id: super::super::SubscriptionId = "my-sub".parse().unwrap();
        let filter = super::super::Filter {
            kinds: Some(vec![serde_json::from_str("1").unwrap()]),
            ..Default::default()
        };
        let message = ClientMessage::Req {
            subscription_id,
            filters: vec![filter],
        };

        let json = serde_json::to_value(&message).unwrap();
        assert!(json.is_array());
        let arr = json.as_array().unwrap();
        assert_eq!(arr[0], "REQ");
        assert_eq!(arr[1], "my-sub");
        assert!(arr[2].is_object());
    }

    #[test]
    fn test_req_roundtrip() {
        let subscription_id: super::super::SubscriptionId = "roundtrip-sub".parse().unwrap();
        let filter1 = super::super::Filter {
            kinds: Some(vec![serde_json::from_str("1").unwrap()]),
            ..Default::default()
        };
        let filter2 = super::super::Filter {
            limit: Some(100),
            ..Default::default()
        };
        let original = ClientMessage::Req {
            subscription_id,
            filters: vec![filter1, filter2],
        };

        let json = serde_json::to_string(&original).unwrap();
        let restored: ClientMessage = serde_json::from_str(&json).unwrap();

        assert_eq!(original, restored);
    }

    // ========== CLOSE 正常系 ==========

    #[test]
    fn test_close_deserialize() {
        let json = r#"["CLOSE", "sub1"]"#;
        let message: ClientMessage = serde_json::from_str(json).unwrap();

        match message {
            ClientMessage::Close(subscription_id) => {
                assert_eq!(subscription_id.as_str(), "sub1");
            }
            _ => panic!("Expected Close message"),
        }
    }

    #[test]
    fn test_close_serialize() {
        let subscription_id: super::super::SubscriptionId = "close-sub".parse().unwrap();
        let message = ClientMessage::Close(subscription_id);

        let json = serde_json::to_value(&message).unwrap();
        assert!(json.is_array());
        let arr = json.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0], "CLOSE");
        assert_eq!(arr[1], "close-sub");
    }

    #[test]
    fn test_close_roundtrip() {
        let subscription_id: super::super::SubscriptionId = "roundtrip-close".parse().unwrap();
        let original = ClientMessage::Close(subscription_id);

        let json = serde_json::to_string(&original).unwrap();
        let restored: ClientMessage = serde_json::from_str(&json).unwrap();

        assert_eq!(original, restored);
    }

    // ========== 異常系テスト ==========

    #[test]
    fn test_empty_array_error() {
        let json = r#"[]"#;
        let result: Result<ClientMessage, _> = serde_json::from_str(json);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("メッセージ配列が空です"));
    }

    #[test]
    fn test_unknown_message_type_error() {
        let json = r#"["UNKNOWN", "data"]"#;
        let result: Result<ClientMessage, _> = serde_json::from_str(json);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("未知のメッセージタイプ"));
        assert!(err.contains("UNKNOWN"));
    }

    #[test]
    fn test_event_missing_event_error() {
        let json = r#"["EVENT"]"#;
        let result: Result<ClientMessage, _> = serde_json::from_str(json);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("EVENTメッセージにイベントがありません"));
    }

    #[test]
    fn test_event_extra_elements_error() {
        let event = create_test_event();
        let event_json = serde_json::to_value(&event).unwrap();
        let message_json = serde_json::json!(["EVENT", event_json, "extra"]);

        let result: Result<ClientMessage, _> = serde_json::from_value(message_json);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("EVENTメッセージに余分な要素があります"));
    }

    #[test]
    fn test_req_missing_subscription_id_error() {
        let json = r#"["REQ"]"#;
        let result: Result<ClientMessage, _> = serde_json::from_str(json);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("REQメッセージにsubscription_idがありません"));
    }

    #[test]
    fn test_req_missing_filter_error() {
        let json = r#"["REQ", "sub1"]"#;
        let result: Result<ClientMessage, _> = serde_json::from_str(json);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("REQメッセージには少なくとも1つのフィルターが必要です"));
    }

    #[test]
    fn test_close_missing_subscription_id_error() {
        let json = r#"["CLOSE"]"#;
        let result: Result<ClientMessage, _> = serde_json::from_str(json);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("CLOSEメッセージにsubscription_idがありません"));
    }

    #[test]
    fn test_close_extra_elements_error() {
        let json = r#"["CLOSE", "sub1", "extra"]"#;
        let result: Result<ClientMessage, _> = serde_json::from_str(json);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("CLOSEメッセージに余分な要素があります"));
    }

    // ========== SubscriptionIdバリデーションの伝播テスト ==========

    #[test]
    fn test_req_empty_subscription_id_error() {
        // 空のsubscription_idはSubscriptionIdParseErrorが伝播する
        let json = r#"["REQ", "", {}]"#;
        let result: Result<ClientMessage, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    #[test]
    fn test_close_empty_subscription_id_error() {
        let json = r#"["CLOSE", ""]"#;
        let result: Result<ClientMessage, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    #[test]
    fn test_req_too_long_subscription_id_error() {
        // 65文字のsubscription_id
        let long_id = "a".repeat(65);
        let json = format!(r#"["REQ", "{}", {{}}]"#, long_id);
        let result: Result<ClientMessage, _> = serde_json::from_str(&json);
        assert!(result.is_err());
    }
}
