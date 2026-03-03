use std::fmt;
use std::str::FromStr;

/// サブスクリプションIDの最大文字数（NIP-01準拠）
pub const MAX_SUBSCRIPTION_ID_LENGTH: usize = 64;

/// Nostrサブスクリプションの識別子
#[derive(
    Debug,
    Clone,
    PartialEq,
    Eq,
    Hash,
    serde_with::SerializeDisplay,
    serde_with::DeserializeFromStr,
)]
pub struct SubscriptionId(String);

/// SubscriptionIdのパースエラー
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SubscriptionIdParseError {
    /// 空文字列
    #[error("サブスクリプションIDは空にできません")]
    Empty,

    /// 文字数が64文字を超えている
    #[error("サブスクリプションIDが長すぎます: {0}文字（最大{1}文字）")]
    TooLong(usize, usize),
}

impl fmt::Display for SubscriptionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for SubscriptionId {
    type Err = SubscriptionIdParseError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        if s.is_empty() {
            return Err(SubscriptionIdParseError::Empty);
        }

        let char_count = s.chars().count();
        if char_count > MAX_SUBSCRIPTION_ID_LENGTH {
            return Err(SubscriptionIdParseError::TooLong(
                char_count,
                MAX_SUBSCRIPTION_ID_LENGTH,
            ));
        }

        Ok(SubscriptionId(s.to_string()))
    }
}

impl SubscriptionId {
    /// 内部文字列への参照を返す
    #[allow(dead_code)]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_subscription_id_serialize() {
        // シリアライズのテスト
        let sub_id: SubscriptionId = "test-sub".parse().unwrap();
        let serialized = serde_json::to_string(&sub_id).unwrap();

        assert_eq!(serialized, "\"test-sub\"");
    }

    #[test]
    fn test_subscription_id_deserialize() {
        // デシリアライズのテスト
        let json = "\"my-subscription\"";
        let sub_id: SubscriptionId = serde_json::from_str(json).unwrap();

        assert_eq!(sub_id.as_str(), "my-subscription");
    }

    #[test]
    fn test_subscription_id_roundtrip() {
        // ラウンドトリップテスト
        let original: SubscriptionId = "roundtrip-test".parse().unwrap();
        let json = serde_json::to_string(&original).unwrap();
        let restored: SubscriptionId = serde_json::from_str(&json).unwrap();

        assert_eq!(original, restored);
    }

    #[test]
    fn test_subscription_id_empty_error() {
        // 空文字列はエラー
        let result: Result<SubscriptionId, _> = "".parse();
        assert!(matches!(result, Err(SubscriptionIdParseError::Empty)));
    }

    #[test]
    fn test_subscription_id_too_long_error() {
        // 65文字はエラー
        let long_str = "a".repeat(65);
        let result: Result<SubscriptionId, _> = long_str.parse();
        assert!(matches!(
            result,
            Err(SubscriptionIdParseError::TooLong(65, 64))
        ));
    }

    #[test]
    fn test_subscription_id_boundary_63_chars() {
        // 63文字はOK
        let str_63 = "a".repeat(63);
        let result: Result<SubscriptionId, _> = str_63.parse();
        assert!(result.is_ok());
        assert_eq!(result.unwrap().as_str().chars().count(), 63);
    }

    #[test]
    fn test_subscription_id_boundary_64_chars() {
        // 64文字はOK（境界）
        let str_64 = "a".repeat(64);
        let result: Result<SubscriptionId, _> = str_64.parse();
        assert!(result.is_ok());
        assert_eq!(result.unwrap().as_str().chars().count(), 64);
    }

    #[test]
    fn test_subscription_id_boundary_65_chars() {
        // 65文字はエラー
        let str_65 = "a".repeat(65);
        let result: Result<SubscriptionId, _> = str_65.parse();
        assert!(matches!(
            result,
            Err(SubscriptionIdParseError::TooLong(65, 64))
        ));
    }

    #[test]
    fn test_subscription_id_with_emoji() {
        // 絵文字を含む文字列（文字数カウント確認）
        // 👍 は1 codepoint
        let with_emoji = "sub👍";
        let result: Result<SubscriptionId, _> = with_emoji.parse();
        assert!(result.is_ok());
        assert_eq!(result.unwrap().as_str().chars().count(), 4);
    }

    #[test]
    fn test_subscription_id_with_multibyte() {
        // マルチバイト文字（日本語）
        let japanese = "テスト";
        let result: Result<SubscriptionId, _> = japanese.parse();
        assert!(result.is_ok());
        assert_eq!(result.unwrap().as_str().chars().count(), 3);
    }

    #[test]
    fn test_subscription_id_with_control_chars() {
        // 改行・制御文字を含む文字列（許可される）
        let with_newline = "sub\nid";
        let result: Result<SubscriptionId, _> = with_newline.parse();
        assert!(result.is_ok());
    }

    #[test]
    fn test_subscription_id_display_and_serde_consistency() {
        // Display と serde が同じ形式を使用することを確認
        let sub_id: SubscriptionId = "consistency-test".parse().unwrap();
        let display_str = sub_id.to_string();
        let serde_str = serde_json::to_string(&sub_id).unwrap();

        // serde は引用符で囲まれている
        assert_eq!(format!("\"{}\"", display_str), serde_str);
    }

    #[test]
    fn test_subscription_id_deserialize_empty_error() {
        // 空文字列のデシリアライズはエラー
        let json = "\"\"";
        let result: Result<SubscriptionId, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    #[test]
    fn test_subscription_id_deserialize_too_long_error() {
        // 長すぎる文字列のデシリアライズはエラー
        let long_str = "a".repeat(65);
        let json = format!("\"{}\"", long_str);
        let result: Result<SubscriptionId, _> = serde_json::from_str(&json);
        assert!(result.is_err());
    }
}
