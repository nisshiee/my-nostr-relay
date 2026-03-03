use std::fmt;
use std::str::FromStr;

/// Nostrイベントの一意識別子（32バイト）
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, serde_with::SerializeDisplay, serde_with::DeserializeFromStr,
)]
pub struct EventId([u8; 32]);

/// EventIdのパースエラー
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum EventIdParseError {
    /// hex文字列のデコードに失敗
    #[error("invalid hex: {0}")]
    InvalidHex(#[from] hex::FromHexError),

    /// バイト長が32でない
    #[error("invalid length: expected 32 bytes, got {0}")]
    InvalidLength(usize),
}

impl fmt::Display for EventId {
    /// lowercase hex-encoded 文字列として表示
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", hex::encode(self.0))
    }
}

impl FromStr for EventId {
    type Err = EventIdParseError;

    /// lowercase hex-encoded 文字列からパース
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let bytes = hex::decode(s)?;
        let len = bytes.len();
        let arr: [u8; 32] = bytes
            .try_into()
            .map_err(|_| EventIdParseError::InvalidLength(len))?;
        Ok(EventId(arr))
    }
}

impl EventId {
    /// 内部のバイト配列への参照を返す
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// バイト配列からEventIdを生成
    #[allow(dead_code)]
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        EventId(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// テスト用のEventIdを生成するヘルパー
    fn create_test_event_id() -> EventId {
        let bytes: [u8; 32] = [
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
            0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
            0x1d, 0x1e, 0x1f, 0x20,
        ];
        EventId(bytes)
    }

    #[test]
    fn test_event_id_serialize() {
        // シリアライズのテスト
        let event_id = create_test_event_id();
        let serialized = serde_json::to_string(&event_id).unwrap();

        // hex文字列形式でシリアライズされる
        assert!(serialized.starts_with('"'));
        assert!(serialized.ends_with('"'));

        // 32バイト = 64文字のhex
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
    fn test_event_id_deserialize() {
        // デシリアライズのテスト
        let event_id = create_test_event_id();
        let serialized = serde_json::to_string(&event_id).unwrap();

        let deserialized: EventId = serde_json::from_str(&serialized).unwrap();
        assert_eq!(event_id, deserialized);
    }

    #[test]
    fn test_event_id_roundtrip() {
        // ラウンドトリップテスト
        let original = create_test_event_id();
        let json = serde_json::to_string(&original).unwrap();
        let restored: EventId = serde_json::from_str(&json).unwrap();
        assert_eq!(original, restored);
    }

    #[test]
    fn test_event_id_deserialize_invalid_format() {
        // 無効な形式のデシリアライズがエラーになることを確認
        let invalid_json = "\"not-a-valid-event-id\"";
        let result: Result<EventId, _> = serde_json::from_str(invalid_json);
        assert!(result.is_err());
    }

    #[test]
    fn test_event_id_deserialize_invalid_hex() {
        // 無効な16進数のデシリアライズがエラーになることを確認
        // 64文字だが無効な16進数
        let invalid_json = "\"gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg\"";
        let result: Result<EventId, _> = serde_json::from_str(invalid_json);
        assert!(result.is_err());
    }

    #[test]
    fn test_event_id_deserialize_wrong_length() {
        // 長さが間違っている場合のデシリアライズがエラーになることを確認
        let invalid_json = "\"abcd1234\"";
        let result: Result<EventId, _> = serde_json::from_str(invalid_json);
        assert!(result.is_err());
    }

    #[test]
    fn test_event_id_display_and_serde_consistency() {
        // Display と serde が同じ形式を使用することを確認
        let event_id = create_test_event_id();
        let display_str = event_id.to_string();
        let serde_str = serde_json::to_string(&event_id).unwrap();

        // serde は引用符で囲まれている
        assert_eq!(format!("\"{}\"", display_str), serde_str);
    }

    #[test]
    fn test_event_id_from_str() {
        // FromStr のテスト
        let hex_str = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
        let event_id: EventId = hex_str.parse().unwrap();
        assert_eq!(event_id, create_test_event_id());
    }

    #[test]
    fn test_event_id_from_str_invalid_hex() {
        // 無効なhex文字列
        let result: Result<EventId, _> = "not-valid-hex".parse();
        assert!(matches!(result, Err(EventIdParseError::InvalidHex(_))));
    }

    #[test]
    fn test_event_id_from_str_wrong_length() {
        // 長さが間違っている
        let result: Result<EventId, _> = "abcd1234".parse();
        assert!(matches!(result, Err(EventIdParseError::InvalidLength(4))));
    }
}
