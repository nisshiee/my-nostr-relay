use std::sync::LazyLock;

use secp256k1::Secp256k1;
use sha2::{Digest, Sha256};

/// 署名検証用のSecp256k1コンテキスト（モジュール内で共有）
static SECP: LazyLock<Secp256k1<secp256k1::VerifyOnly>> = LazyLock::new(Secp256k1::verification_only);

/// Nostrイベント（NIP-01準拠）
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Event {
    pub id: super::EventId,
    pub pubkey: super::Pubkey,
    pub created_at: super::Timestamp,
    pub kind: super::Kind,
    pub tags: Vec<super::Tag>,
    pub content: String,
    pub sig: super::Sig,
}

/// イベント検証エラー
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum VerificationError {
    /// イベントIDが一致しない
    #[error("イベントIDが一致しません: 期待値 {expected}, 実際 {actual}")]
    IdMismatch {
        /// 計算されたID
        expected: String,
        /// イベントに記録されているID
        actual: String,
    },

    /// 署名が無効（将来の拡張用に予約）
    #[allow(dead_code)]
    #[error("署名が無効です: {0}")]
    InvalidSignature(String),

    /// 署名検証に失敗
    #[error("署名検証に失敗しました")]
    SignatureVerificationFailed,
}

/// 検証済みNostrイベント
///
/// `Event::verify()` を通過したイベントのみがこの型を持つ。
/// デシリアライズ不可により、検証をバイパスすることはできない。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(transparent)]
pub struct VerifiedEvent(Event);

impl VerifiedEvent {
    /// 内部のEventへの参照を返す
    pub fn inner(&self) -> &Event {
        &self.0
    }

    /// 内部のEventを取り出す
    pub fn into_inner(self) -> Event {
        self.0
    }
}

impl std::ops::Deref for VerifiedEvent {
    type Target = Event;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Event {
    /// Addressable event 用の "d" タグ値を取得
    /// "d" タグが無い場合は空文字列を返す（NIP-01 仕様）
    pub fn d_tag_value(&self) -> &str {
        self.tags
            .iter()
            .find(|t| t.is_d_tag())
            .and_then(|t| t.value())
            .unwrap_or("")
    }

    /// NIP-70: 保護イベントかどうか（`["-"]` タグの存在で判定）
    pub fn is_protected(&self) -> bool {
        self.tags.iter().any(|t| t.name() == "-")
    }

    /// "e" タグの値（イベントID）を抽出
    pub fn e_tag_values(&self) -> Vec<&str> {
        self.tags
            .iter()
            .filter(|t| t.name() == "e")
            .filter_map(|t| t.value())
            .collect()
    }

    /// "a" タグの値を (kind, pubkey, d-identifier) として抽出
    /// フォーマット: "<kind>:<pubkey>:<d-identifier>"
    pub fn a_tag_values(&self) -> Vec<(&str, &str, &str)> {
        self.tags
            .iter()
            .filter(|t| t.name() == "a")
            .filter_map(|t| t.value())
            .filter_map(|v| {
                let parts: Vec<&str> = v.splitn(3, ':').collect();
                if parts.len() == 3 {
                    Some((parts[0], parts[1], parts[2]))
                } else {
                    None
                }
            })
            .collect()
    }

    /// NIP-01準拠でイベントIDを計算（プライベート）
    fn compute_id(&self) -> [u8; 32] {
        // [0, pubkey, created_at, kind, tags, content] をシリアライズ
        let serializable = serde_json::json!([
            0,
            self.pubkey.to_hex(),
            self.created_at.as_i64(),
            self.kind.as_u16(),
            self.tags.iter().map(|t| t.as_slice()).collect::<Vec<_>>(),
            &self.content,
        ]);

        let json = serde_json::to_string(&serializable).expect("JSONシリアライズは常に成功する");

        let mut hasher = Sha256::new();
        hasher.update(json.as_bytes());
        hasher.finalize().into()
    }

    /// NIP-01準拠でイベントを検証する
    ///
    /// 1. イベントIDが正しいか検証
    /// 2. Schnorr署名が正しいか検証
    ///
    /// # エラー
    ///
    /// - `VerificationError::IdMismatch`: 計算されたIDとイベントのIDが一致しない
    /// - `VerificationError::InvalidSignature`: 署名のフォーマットが不正
    /// - `VerificationError::SignatureVerificationFailed`: 署名検証に失敗
    pub fn verify(self) -> Result<VerifiedEvent, VerificationError> {
        // Step 1: イベントID検証
        let computed_id = self.compute_id();
        if computed_id != *self.id.as_bytes() {
            return Err(VerificationError::IdMismatch {
                expected: hex::encode(computed_id),
                actual: self.id.to_string(),
            });
        }

        // Step 2: Schnorr署名検証（共有コンテキスト使用）
        SECP.verify_schnorr(self.sig.as_signature(), &computed_id, self.pubkey.as_xonly_public_key())
            .map_err(|_| VerificationError::SignatureVerificationFailed)?;

        Ok(VerifiedEvent(self))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 実際に有効なテストベクトル（手動計算）
    fn create_actually_valid_event() -> Event {
        use secp256k1::{Keypair, SecretKey};

        // 固定の秘密鍵
        let secret_bytes = [
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
            0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
            0x1d, 0x1e, 0x1f, 0x20,
        ];
        let secret_key = SecretKey::from_byte_array(secret_bytes).unwrap();
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret_key);
        let (x_only_pubkey, _parity) = keypair.x_only_public_key();

        // イベントデータを構築
        let pubkey_hex = hex::encode(x_only_pubkey.serialize());
        let created_at: i64 = 1234567890;
        let kind: u16 = 1;
        let tags: Vec<Vec<String>> = vec![];
        let content = "Hello, Nostr!";

        // イベントIDを計算
        let serializable = serde_json::json!([0, pubkey_hex, created_at, kind, tags, content,]);
        let json_str = serde_json::to_string(&serializable).unwrap();
        let mut hasher = Sha256::new();
        hasher.update(json_str.as_bytes());
        let id_bytes: [u8; 32] = hasher.finalize().into();

        // 署名を生成
        let sig = secp.sign_schnorr_no_aux_rand(&id_bytes, &keypair);

        // JSONを構築してパース
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
    fn test_verify_valid_event() {
        let event = create_actually_valid_event();
        let result = event.verify();
        assert!(result.is_ok());
    }

    #[test]
    fn test_verify_id_mismatch() {
        let mut event = create_actually_valid_event();
        // IDを改ざん
        let tampered_id: super::super::EventId =
            "0000000000000000000000000000000000000000000000000000000000000000"
                .parse()
                .unwrap();
        event.id = tampered_id;

        let result = event.verify();
        assert!(matches!(result, Err(VerificationError::IdMismatch { .. })));
    }

    #[test]
    fn test_verify_invalid_signature() {
        let mut event = create_actually_valid_event();
        // 署名を改ざん（contentを変更してIDを再計算、しかし署名はそのまま）
        event.content = "Tampered content!".to_string();

        // IDも再計算して更新（そうしないとIdMismatchになる）
        let serializable = serde_json::json!([
            0,
            event.pubkey.to_hex(),
            event.created_at.as_i64(),
            event.kind.as_u16(),
            event.tags.iter().map(|t| t.as_slice()).collect::<Vec<_>>(),
            &event.content,
        ]);
        let json_str = serde_json::to_string(&serializable).unwrap();
        let mut hasher = Sha256::new();
        hasher.update(json_str.as_bytes());
        let id_bytes: [u8; 32] = hasher.finalize().into();
        event.id = super::super::EventId::from_bytes(id_bytes);

        let result = event.verify();
        assert!(matches!(
            result,
            Err(VerificationError::SignatureVerificationFailed)
        ));
    }

    #[test]
    fn test_verify_special_characters_in_content() {
        use secp256k1::{Keypair, SecretKey};

        // 特殊文字を含むcontent
        let content = "Hello\nWorld\t\"test\"\\backslash";

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

        let event: Event = serde_json::from_value(event_json).unwrap();
        let result = event.verify();
        assert!(result.is_ok());
    }

    #[test]
    fn test_verify_with_tags() {
        use secp256k1::{Keypair, SecretKey};

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
        let tags = vec![
            vec!["e", "abc123"],
            vec!["p", "def456", "relay.example.com"],
        ];
        let content = "Hello with tags!";

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

        let event: Event = serde_json::from_value(event_json).unwrap();
        let result = event.verify();
        assert!(result.is_ok());
    }

    #[test]
    fn test_is_protected_with_dash_tag() {
        use secp256k1::{Keypair, Secp256k1, SecretKey};

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
        let tags = vec![vec!["-"]];
        let content = "protected event";

        let serializable = serde_json::json!([0, pubkey_hex, created_at, kind, tags, content]);
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
        let event: Event = serde_json::from_value(event_json).unwrap();
        assert!(event.is_protected());
    }

    #[test]
    fn test_is_protected_without_dash_tag() {
        let event = create_actually_valid_event();
        assert!(!event.is_protected());
    }

    #[test]
    fn test_verified_event_deref() {
        let event = create_actually_valid_event();
        let original_id = event.id;
        let verified = event.verify().unwrap();

        // Deref経由でフィールドにアクセスできる
        assert_eq!(verified.id, original_id);
        assert_eq!(verified.content, "Hello, Nostr!");
    }

    #[test]
    fn test_verified_event_serialize() {
        let event = create_actually_valid_event();
        let event_json = serde_json::to_string(&event).unwrap();

        let verified = event.verify().unwrap();
        let verified_json = serde_json::to_string(&verified).unwrap();

        // VerifiedEventとEventは同じ形式でシリアライズされる
        assert_eq!(event_json, verified_json);
    }

    #[test]
    fn test_verified_event_inner() {
        let event = create_actually_valid_event();
        let original_content = event.content.clone();

        let verified = event.verify().unwrap();
        assert_eq!(verified.inner().content, original_content);
    }

    #[test]
    fn test_verified_event_into_inner() {
        let event = create_actually_valid_event();
        let original_content = event.content.clone();

        let verified = event.verify().unwrap();
        let inner = verified.into_inner();
        assert_eq!(inner.content, original_content);
    }
}
