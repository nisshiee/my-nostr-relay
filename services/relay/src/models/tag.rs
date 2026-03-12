use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Nostrイベントのタグを表す構造体
/// 1つ以上の要素を持つことが保証されている
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "Vec<String>", into = "Vec<String>")]
pub struct Tag(Vec<String>);

/// タグが空の場合のエラー
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("タグは1つ以上の要素が必要です")]
pub struct EmptyTagError;

impl TryFrom<Vec<String>> for Tag {
    type Error = EmptyTagError;

    fn try_from(value: Vec<String>) -> Result<Self, Self::Error> {
        if value.is_empty() {
            Err(EmptyTagError)
        } else {
            Ok(Tag(value))
        }
    }
}

impl From<Tag> for Vec<String> {
    fn from(tag: Tag) -> Self {
        tag.0
    }
}

impl Tag {
    /// 内部のスライスへの参照を返す
    pub fn as_slice(&self) -> &[String] {
        &self.0
    }

    /// タグ名を返す（最初の要素）
    pub fn name(&self) -> &str {
        &self.0[0]
    }

    /// タグの値を返す（2番目の要素）
    pub fn value(&self) -> Option<&str> {
        self.0.get(1).map(|s| s.as_str())
    }

    /// "d" タグかどうか
    pub fn is_d_tag(&self) -> bool {
        self.name() == "d"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_try_from_non_empty_vec() {
        let vec = vec!["e".to_string(), "abc123".to_string()];
        let tag = Tag::try_from(vec);
        assert!(tag.is_ok());
    }

    #[test]
    fn test_try_from_single_element() {
        let vec = vec!["p".to_string()];
        let tag = Tag::try_from(vec);
        assert!(tag.is_ok());
    }

    #[test]
    fn test_try_from_empty_vec() {
        let vec: Vec<String> = vec![];
        let tag = Tag::try_from(vec);
        assert!(tag.is_err());
        assert_eq!(tag.unwrap_err(), EmptyTagError);
    }

    #[test]
    fn test_serialize() {
        let tag = Tag::try_from(vec!["e".to_string(), "abc123".to_string()]).unwrap();
        let json = serde_json::to_string(&tag).unwrap();
        assert_eq!(json, r#"["e","abc123"]"#);
    }

    #[test]
    fn test_deserialize() {
        let json = r#"["p","pubkey123"]"#;
        let tag: Tag = serde_json::from_str(json).unwrap();
        assert_eq!(
            tag,
            Tag::try_from(vec!["p".to_string(), "pubkey123".to_string()]).unwrap()
        );
    }

    #[test]
    fn test_deserialize_empty_fails() {
        let json = r#"[]"#;
        let result: Result<Tag, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    #[test]
    fn test_name() {
        let tag = Tag::try_from(vec!["e".to_string(), "abc123".to_string()]).unwrap();
        assert_eq!(tag.name(), "e");
    }

    #[test]
    fn test_value() {
        let tag = Tag::try_from(vec!["e".to_string(), "abc123".to_string()]).unwrap();
        assert_eq!(tag.value(), Some("abc123"));
    }

    #[test]
    fn test_value_none_when_single_element() {
        let tag = Tag::try_from(vec!["p".to_string()]).unwrap();
        assert_eq!(tag.value(), None);
    }

    #[test]
    fn test_is_d_tag() {
        let d_tag = Tag::try_from(vec!["d".to_string(), "identifier".to_string()]).unwrap();
        assert!(d_tag.is_d_tag());

        let e_tag = Tag::try_from(vec!["e".to_string(), "event_id".to_string()]).unwrap();
        assert!(!e_tag.is_d_tag());
    }
}
