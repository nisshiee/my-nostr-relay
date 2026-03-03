/// Nostrイベントの署名（NIP-01準拠のSchnorr署名）
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct Sig(secp256k1::schnorr::Signature);

impl Sig {
    /// 内部のSignatureへの参照を返す
    pub fn as_signature(&self) -> &secp256k1::schnorr::Signature {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// テスト用のSigを生成するヘルパー
    fn create_test_sig() -> Sig {
        let bytes: [u8; 64] = [
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
            0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
            0x1d, 0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a,
            0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38,
            0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x40,
        ];
        Sig(secp256k1::schnorr::Signature::from_byte_array(bytes))
    }

    #[test]
    fn test_sig_serialize() {
        let sig = create_test_sig();
        let serialized = serde_json::to_string(&sig).unwrap();

        // hex文字列形式でシリアライズされる
        assert!(serialized.starts_with('"'));
        assert!(serialized.ends_with('"'));

        // 64バイト = 128文字のhex
        let inner = &serialized[1..serialized.len() - 1];
        assert_eq!(inner.len(), 128);
        // 全て小文字の16進数であること
        assert!(inner.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn test_sig_deserialize() {
        let sig = create_test_sig();
        let serialized = serde_json::to_string(&sig).unwrap();

        let deserialized: Sig = serde_json::from_str(&serialized).unwrap();
        assert_eq!(sig, deserialized);
    }

    #[test]
    fn test_sig_roundtrip() {
        let original = create_test_sig();
        let json = serde_json::to_string(&original).unwrap();
        let restored: Sig = serde_json::from_str(&json).unwrap();
        assert_eq!(original, restored);
    }

    #[test]
    fn test_sig_deserialize_invalid_format() {
        let invalid_json = "\"not-a-valid-sig\"";
        let result: Result<Sig, _> = serde_json::from_str(invalid_json);
        assert!(result.is_err());
    }

    #[test]
    fn test_sig_deserialize_invalid_hex() {
        // 128文字だが無効な16進数
        let invalid_json = "\"gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg\"";
        let result: Result<Sig, _> = serde_json::from_str(invalid_json);
        assert!(result.is_err());
    }

    #[test]
    fn test_sig_deserialize_wrong_length() {
        let invalid_json = "\"abcd1234\"";
        let result: Result<Sig, _> = serde_json::from_str(invalid_json);
        assert!(result.is_err());
    }
}
