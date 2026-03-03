use serde::ser::SerializeSeq;
use serde::Serialize;

/// NIP-01 リレーからクライアントへのメッセージ
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayMessage {
    /// イベント送信: ["EVENT", <subscription_id>, <event>]
    Event {
        subscription_id: super::SubscriptionId,
        event: super::Event,
    },

    /// EVENT受理/拒否: ["OK", <event_id>, <true|false>, <message>]
    Ok {
        event_id: super::EventId,
        success: bool,
        message: String,
    },

    /// stored events終了: ["EOSE", <subscription_id>]
    Eose(super::SubscriptionId),

    /// サブスクリプション終了: ["CLOSED", <subscription_id>, <message>]
    Closed {
        subscription_id: super::SubscriptionId,
        message: String,
    },

    /// 通知メッセージ: ["NOTICE", <message>]
    Notice(String),
}

impl Serialize for RelayMessage {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            RelayMessage::Event {
                subscription_id,
                event,
            } => {
                let mut seq = serializer.serialize_seq(Some(3))?;
                seq.serialize_element("EVENT")?;
                seq.serialize_element(subscription_id)?;
                seq.serialize_element(event)?;
                seq.end()
            }
            RelayMessage::Ok {
                event_id,
                success,
                message,
            } => {
                let mut seq = serializer.serialize_seq(Some(4))?;
                seq.serialize_element("OK")?;
                seq.serialize_element(event_id)?;
                seq.serialize_element(success)?;
                seq.serialize_element(message)?;
                seq.end()
            }
            RelayMessage::Eose(subscription_id) => {
                let mut seq = serializer.serialize_seq(Some(2))?;
                seq.serialize_element("EOSE")?;
                seq.serialize_element(subscription_id)?;
                seq.end()
            }
            RelayMessage::Closed {
                subscription_id,
                message,
            } => {
                let mut seq = serializer.serialize_seq(Some(3))?;
                seq.serialize_element("CLOSED")?;
                seq.serialize_element(subscription_id)?;
                seq.serialize_element(message)?;
                seq.end()
            }
            RelayMessage::Notice(message) => {
                let mut seq = serializer.serialize_seq(Some(2))?;
                seq.serialize_element("NOTICE")?;
                seq.serialize_element(message)?;
                seq.end()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn test_event_serialize() {
        let event = create_test_event();
        let subscription_id: super::super::SubscriptionId = "sub1".parse().unwrap();

        let message = RelayMessage::Event {
            subscription_id: subscription_id.clone(),
            event: event.clone(),
        };

        let json = serde_json::to_value(&message).unwrap();
        assert!(json.is_array());
        let arr = json.as_array().unwrap();
        assert_eq!(arr.len(), 3);
        assert_eq!(arr[0], "EVENT");
        assert_eq!(arr[1], "sub1");

        // イベント部分が正しくシリアライズされているか確認
        let serialized_event: super::super::Event = serde_json::from_value(arr[2].clone()).unwrap();
        assert_eq!(serialized_event, event);
    }

    #[test]
    fn test_ok_success_serialize() {
        let event_id: super::super::EventId =
            "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
                .parse()
                .unwrap();

        let message = RelayMessage::Ok {
            event_id,
            success: true,
            message: "".to_string(),
        };

        let json = serde_json::to_value(&message).unwrap();
        assert!(json.is_array());
        let arr = json.as_array().unwrap();
        assert_eq!(arr.len(), 4);
        assert_eq!(arr[0], "OK");
        assert_eq!(
            arr[1],
            "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
        );
        assert_eq!(arr[2], true);
        assert_eq!(arr[3], "");
    }

    #[test]
    fn test_ok_failure_serialize() {
        let event_id: super::super::EventId =
            "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
                .parse()
                .unwrap();

        let message = RelayMessage::Ok {
            event_id,
            success: false,
            message: "duplicate: already have this event".to_string(),
        };

        let json = serde_json::to_value(&message).unwrap();
        assert!(json.is_array());
        let arr = json.as_array().unwrap();
        assert_eq!(arr.len(), 4);
        assert_eq!(arr[0], "OK");
        assert_eq!(
            arr[1],
            "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
        );
        assert_eq!(arr[2], false);
        assert_eq!(arr[3], "duplicate: already have this event");
    }

    #[test]
    fn test_eose_serialize() {
        let subscription_id: super::super::SubscriptionId = "sub1".parse().unwrap();

        let message = RelayMessage::Eose(subscription_id);

        let json = serde_json::to_value(&message).unwrap();
        assert!(json.is_array());
        let arr = json.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0], "EOSE");
        assert_eq!(arr[1], "sub1");
    }

    #[test]
    fn test_closed_serialize() {
        let subscription_id: super::super::SubscriptionId = "sub1".parse().unwrap();

        let message = RelayMessage::Closed {
            subscription_id,
            message: "error: subscription not found".to_string(),
        };

        let json = serde_json::to_value(&message).unwrap();
        assert!(json.is_array());
        let arr = json.as_array().unwrap();
        assert_eq!(arr.len(), 3);
        assert_eq!(arr[0], "CLOSED");
        assert_eq!(arr[1], "sub1");
        assert_eq!(arr[2], "error: subscription not found");
    }

    #[test]
    fn test_notice_serialize() {
        let message = RelayMessage::Notice("This is a notice message".to_string());

        let json = serde_json::to_value(&message).unwrap();
        assert!(json.is_array());
        let arr = json.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0], "NOTICE");
        assert_eq!(arr[1], "This is a notice message");
    }
}
