//! テスト用ヘルパー関数（共通化）

use crate::models::Event;

/// テスト用の有効なイベントを作成（デフォルト: kind=1, content="Hello, Nostr!"）
pub fn create_test_event() -> Event {
    create_custom_event(1, 1234567890, "Hello, Nostr!", vec![])
}

/// 異なるイベントを作成（contentを変えて）
pub fn create_test_event_with_content(content: &str) -> Event {
    create_custom_event(1, 1234567890, content, vec![])
}

/// カスタマイズ可能なテストイベント作成
pub fn create_custom_event(
    kind: u16,
    created_at: i64,
    content: &str,
    tags: Vec<Vec<&str>>,
) -> Event {
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

/// 異なるキーペアでテストイベントを作成（pubkeyが異なるイベントが必要なテスト用）
pub fn create_custom_event_with_keypair(
    kind: u16,
    created_at: i64,
    content: &str,
    tags: Vec<Vec<&str>>,
    secret_bytes: [u8; 32],
) -> Event {
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use sha2::{Digest, Sha256};

    let secret_key = SecretKey::from_byte_array(secret_bytes).unwrap();
    let secp = Secp256k1::new();
    let keypair = Keypair::from_secret_key(&secp, &secret_key);
    let (x_only_pubkey, _parity) = keypair.x_only_public_key();

    let pubkey_hex = hex::encode(x_only_pubkey.serialize());

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
