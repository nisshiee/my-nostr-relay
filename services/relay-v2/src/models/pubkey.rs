/// Nostrの公開鍵（NIP-01準拠）
///
/// BIP-340に従い、x座標のみの32バイト（64文字のhex）で表現される。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct Pubkey(secp256k1::XOnlyPublicKey);

impl Pubkey {
    /// 内部のXOnlyPublicKeyへの参照を返す
    pub fn as_xonly_public_key(&self) -> &secp256k1::XOnlyPublicKey {
        &self.0
    }

    /// lowercase hex文字列として返す
    pub fn to_hex(self) -> String {
        hex::encode(self.0.serialize())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use secp256k1::{Keypair, Secp256k1, SecretKey};

    /// テスト用の公開鍵を生成するヘルパー
    fn create_test_pubkey() -> Pubkey {
        let secp = Secp256k1::new();
        // 固定の秘密鍵（テスト用）
        let secret_bytes = [
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
            0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
            0x1d, 0x1e, 0x1f, 0x20,
        ];
        let secret_key = SecretKey::from_byte_array(secret_bytes).unwrap();
        let keypair = Keypair::from_secret_key(&secp, &secret_key);
        let (x_only_pubkey, _parity) = keypair.x_only_public_key();
        Pubkey(x_only_pubkey)
    }

    #[test]
    fn test_pubkey_serialize() {
        // シリアライズのテスト
        let pubkey = create_test_pubkey();
        let serialized = serde_json::to_string(&pubkey).unwrap();

        // DisplayFromStrを使っているので、文字列形式でシリアライズされる
        assert!(serialized.starts_with('"'));
        assert!(serialized.ends_with('"'));

        // NIP-01準拠: x座標のみの32バイト = 64文字のhex
        let inner = &serialized[1..serialized.len() - 1];
        assert_eq!(inner.len(), 64);
        // 全て小文字の16進数であること
        assert!(
            inner
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
    }

    #[test]
    fn test_pubkey_deserialize() {
        // デシリアライズのテスト
        let pubkey = create_test_pubkey();
        let serialized = serde_json::to_string(&pubkey).unwrap();

        let deserialized: Pubkey = serde_json::from_str(&serialized).unwrap();
        assert_eq!(pubkey, deserialized);
    }

    #[test]
    fn test_pubkey_roundtrip() {
        // ラウンドトリップテスト
        let original = create_test_pubkey();
        let json = serde_json::to_string(&original).unwrap();
        let restored: Pubkey = serde_json::from_str(&json).unwrap();
        assert_eq!(original, restored);
    }

    #[test]
    fn test_pubkey_deserialize_invalid_format() {
        // 無効な形式のデシリアライズがエラーになることを確認
        let invalid_json = "\"not-a-valid-pubkey\"";
        let result: Result<Pubkey, _> = serde_json::from_str(invalid_json);
        assert!(result.is_err());
    }

    #[test]
    fn test_pubkey_deserialize_invalid_hex() {
        // 無効な16進数のデシリアライズがエラーになることを確認
        // 64文字だが無効な16進数
        let invalid_json = "\"gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg\"";
        let result: Result<Pubkey, _> = serde_json::from_str(invalid_json);
        assert!(result.is_err());
    }

    #[test]
    fn test_pubkey_deserialize_wrong_length() {
        // 長さが間違っている場合のデシリアライズがエラーになることを確認
        let invalid_json = "\"abcd1234\"";
        let result: Result<Pubkey, _> = serde_json::from_str(invalid_json);
        assert!(result.is_err());
    }

    #[test]
    fn test_pubkey_nip01_format() {
        // NIP-01で使われている実際の公開鍵フォーマットでデシリアライズできることを確認
        // NIP-01の例から取得したpubkey
        let nip01_pubkey_json =
            "\"f7234bd4c1394dda46d09f35bd384dd30cc552ad5541990f98844fb06676e9ca\"";
        let result: Result<Pubkey, _> = serde_json::from_str(nip01_pubkey_json);
        assert!(result.is_ok());

        // シリアライズしても同じ形式になることを確認
        let pubkey = result.unwrap();
        let serialized = serde_json::to_string(&pubkey).unwrap();
        assert_eq!(serialized, nip01_pubkey_json);
    }
}
