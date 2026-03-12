use std::collections::HashMap;

use serde::{Deserialize, Serialize, de::Visitor};
use thiserror::Error;

/// フィルタのパースエラー
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum FilterParseError {
    /// 無効なタグキー（#の後に1文字の英字以外）
    #[error("無効なタグキー: {0}（有効なキーは #a-zA-Z のみ）")]
    InvalidTagKey(String),
}

/// タグフィルタ（#a-zA-Z の動的キー）
/// キーは単一の英字（a-z, A-Z）のみ有効
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TagFilters(HashMap<char, Vec<String>>);

impl TagFilters {
    /// 新しい空のTagFiltersを作成
    #[allow(dead_code)]
    pub fn new() -> Self {
        Self(HashMap::new())
    }

    /// 指定されたタグ名のフィルタ値を取得
    #[allow(dead_code)]
    pub fn get(&self, tag_name: char) -> Option<&Vec<String>> {
        self.0.get(&tag_name)
    }

    /// タグフィルタを挿入
    #[allow(dead_code)]
    pub fn insert(&mut self, tag_name: char, values: Vec<String>) {
        self.0.insert(tag_name, values);
    }

    /// タグフィルタが空かどうか
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// タグフィルタのイテレータを返す
    pub fn iter(&self) -> impl Iterator<Item = (&char, &Vec<String>)> {
        self.0.iter()
    }
}

impl Serialize for TagFilters {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, values) in &self.0 {
            let key_str = format!("#{}", key);
            map.serialize_entry(&key_str, values)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for TagFilters {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct TagFiltersVisitor;

        impl<'de> Visitor<'de> for TagFiltersVisitor {
            type Value = TagFilters;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a map with #<single-letter> keys")
            }

            fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
            where
                M: serde::de::MapAccess<'de>,
            {
                let mut result = HashMap::new();

                while let Some(key) = map.next_key::<String>()? {
                    // #で始まるキーのみを処理
                    if let Some(tag_key) = key.strip_prefix('#') {
                        // 単一の英字のみ有効
                        let chars: Vec<char> = tag_key.chars().collect();
                        if chars.len() == 1 && chars[0].is_ascii_alphabetic() {
                            let values: Vec<String> = map.next_value()?;
                            result.insert(chars[0], values);
                        } else {
                            // 無効なタグキー形式
                            return Err(serde::de::Error::custom(FilterParseError::InvalidTagKey(
                                key,
                            )));
                        }
                    } else {
                        // #で始まらないキーはスキップ（他のフィールド用）
                        let _ = map.next_value::<serde::de::IgnoredAny>()?;
                    }
                }

                Ok(TagFilters(result))
            }
        }

        deserializer.deserialize_map(TagFiltersVisitor)
    }
}

/// NIP-01 で定義されたフィルタ
/// イベントの購読やクエリに使用する
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Filter {
    /// イベントIDのリストでフィルタ
    /// 空のリストは「何もマッチしない」を意味する
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ids: Option<Vec<super::EventId>>,

    /// 作成者の公開鍵リストでフィルタ
    /// 空のリストは「何もマッチしない」を意味する
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authors: Option<Vec<super::Pubkey>>,

    /// イベント種別リストでフィルタ
    /// 空のリストは「何もマッチしない」を意味する
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kinds: Option<Vec<super::Kind>>,

    /// タグフィルタ（#e, #p など）
    /// キーはタグ名（"e", "p" など、#は含まない）
    #[serde(flatten, default)]
    pub tags: TagFilters,

    /// created_at >= since
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<super::Timestamp>,

    /// created_at <= until
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<super::Timestamp>,

    /// 最大イベント数（初回クエリのみ有効）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
}

impl Filter {
    /// イベントがこのフィルタにマッチするかを判定
    pub fn matches(&self, event: &super::Event) -> bool {
        self.matches_ids(event)
            && self.matches_authors(event)
            && self.matches_kinds(event)
            && self.matches_tags(event)
            && self.matches_since(event)
            && self.matches_until(event)
    }

    /// IDフィルタのマッチング
    fn matches_ids(&self, event: &super::Event) -> bool {
        match &self.ids {
            None => true,                         // 条件なし → マッチ
            Some(ids) if ids.is_empty() => false, // 空リスト → マッチしない
            Some(ids) => ids.contains(&event.id),
        }
    }

    /// 作成者フィルタのマッチング
    fn matches_authors(&self, event: &super::Event) -> bool {
        match &self.authors {
            None => true,
            Some(authors) if authors.is_empty() => false,
            Some(authors) => authors.contains(&event.pubkey),
        }
    }

    /// 種別フィルタのマッチング
    fn matches_kinds(&self, event: &super::Event) -> bool {
        match &self.kinds {
            None => true,
            Some(kinds) if kinds.is_empty() => false,
            Some(kinds) => kinds.contains(&event.kind),
        }
    }

    /// タグフィルタのマッチング
    /// イベントのタグの最初の値（tags[1]）とフィルタの値を完全一致で比較
    fn matches_tags(&self, event: &super::Event) -> bool {
        for (tag_name, filter_values) in self.tags.iter() {
            // 空のフィルタ値リストは何もマッチしない
            if filter_values.is_empty() {
                return false;
            }

            // イベントのタグから該当するタグ名のものを探す
            let has_match = event.tags.iter().any(|tag| {
                let tag_slice = tag.as_slice();
                // タグ名が一致し、かつ値が存在する場合
                if tag_slice.len() >= 2 {
                    let event_tag_name = &tag_slice[0];
                    let event_tag_value = &tag_slice[1];
                    // タグ名が一致（単一文字）
                    if event_tag_name.len() == 1 && event_tag_name.starts_with(*tag_name) {
                        // フィルタ値のいずれかと完全一致
                        return filter_values.iter().any(|v| v == event_tag_value);
                    }
                }
                false
            });

            if !has_match {
                return false;
            }
        }
        true
    }

    /// sinceフィルタのマッチング（created_at >= since）
    fn matches_since(&self, event: &super::Event) -> bool {
        match &self.since {
            None => true,
            Some(since) => event.created_at.as_i64() >= since.as_i64(),
        }
    }

    /// untilフィルタのマッチング（created_at <= until）
    fn matches_until(&self, event: &super::Event) -> bool {
        match &self.until {
            None => true,
            Some(until) => event.created_at.as_i64() <= until.as_i64(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ========== 基本テスト ==========

    #[test]
    fn test_empty_filter_parse() {
        // 空のフィルタ {} のパース → Default と一致
        let json = "{}";
        let filter: Filter = serde_json::from_str(json).unwrap();
        assert_eq!(filter, Filter::default());
    }

    #[test]
    fn test_filter_roundtrip() {
        // シリアライズ/デシリアライズのラウンドトリップ
        let filter = Filter {
            ids: Some(vec![
                "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
                    .parse()
                    .unwrap(),
            ]),
            authors: None,
            kinds: Some(vec![serde_json::from_str("1").unwrap()]),
            tags: TagFilters::new(),
            since: Some(serde_json::from_str("1234567890").unwrap()),
            until: None,
            limit: Some(100),
        };

        let json = serde_json::to_string(&filter).unwrap();
        let restored: Filter = serde_json::from_str(&json).unwrap();
        assert_eq!(filter, restored);
    }

    // ========== タグフィルタテスト ==========

    #[test]
    fn test_tag_filter_single() {
        // {"#e": ["abc..."]} の正常パース
        let json = r##"{"#e": ["abc123"]}"##;
        let filter: Filter = serde_json::from_str(json).unwrap();

        assert!(filter.tags.get('e').is_some());
        assert_eq!(filter.tags.get('e').unwrap(), &vec!["abc123".to_string()]);
    }

    #[test]
    fn test_tag_filter_multiple() {
        // {"#e": [...], "#p": [...]} の複数タグ
        let json = r##"{"#e": ["event1", "event2"], "#p": ["pubkey1"]}"##;
        let filter: Filter = serde_json::from_str(json).unwrap();

        assert_eq!(
            filter.tags.get('e').unwrap(),
            &vec!["event1".to_string(), "event2".to_string()]
        );
        assert_eq!(filter.tags.get('p').unwrap(), &vec!["pubkey1".to_string()]);
    }

    #[test]
    fn test_tag_filter_uppercase() {
        // 大文字タグキーも有効
        let json = r##"{"#A": ["value1"]}"##;
        let filter: Filter = serde_json::from_str(json).unwrap();

        assert!(filter.tags.get('A').is_some());
        assert_eq!(filter.tags.get('A').unwrap(), &vec!["value1".to_string()]);
    }

    #[test]
    fn test_tag_filter_invalid_two_chars() {
        // {"#ab": [...]} で FilterParseError（2文字以上）
        let json = r##"{"#ab": ["value"]}"##;
        let result: Result<Filter, _> = serde_json::from_str(json);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("無効なタグキー"));
    }

    #[test]
    fn test_tag_filter_invalid_digit() {
        // {"#1": [...]} で FilterParseError（数字）
        let json = r##"{"#1": ["value"]}"##;
        let result: Result<Filter, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    #[test]
    fn test_tag_filter_serialize() {
        // TagFiltersのシリアライズ
        let mut tags = TagFilters::new();
        tags.insert('e', vec!["event1".to_string()]);
        tags.insert('p', vec!["pubkey1".to_string()]);

        let filter = Filter {
            tags,
            ..Default::default()
        };

        let json = serde_json::to_string(&filter).unwrap();
        // #e, #p 形式でシリアライズされている
        assert!(json.contains("\"#e\"") || json.contains("\"#p\""));
    }

    // ========== 複合フィルタテスト ==========

    #[test]
    fn test_filter_with_all_fields() {
        let json = r##"{
            "ids": ["0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"],
            "authors": ["f7234bd4c1394dda46d09f35bd384dd30cc552ad5541990f98844fb06676e9ca"],
            "kinds": [1, 2],
            "#e": ["referenced_event"],
            "#p": ["mentioned_pubkey"],
            "since": 1234567890,
            "until": 1234567900,
            "limit": 50
        }"##;

        let filter: Filter = serde_json::from_str(json).unwrap();

        assert!(filter.ids.is_some());
        assert!(filter.authors.is_some());
        assert!(filter.kinds.is_some());
        assert!(!filter.tags.is_empty());
        assert!(filter.since.is_some());
        assert!(filter.until.is_some());
        assert_eq!(filter.limit, Some(50));
    }

    // ========== マッチングテスト用のヘルパー ==========

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
        let tags = vec![vec!["e", "event123"], vec!["p", "pubkey456"]];
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

    // ========== マッチングテスト ==========

    #[test]
    fn test_empty_filter_matches_all() {
        // 空フィルタは全イベントにマッチ
        let filter = Filter::default();
        let event = create_test_event();
        assert!(filter.matches(&event));
    }

    #[test]
    fn test_empty_ids_matches_none() {
        // {"ids": []} は何もマッチしない
        let filter = Filter {
            ids: Some(vec![]),
            ..Default::default()
        };
        let event = create_test_event();
        assert!(!filter.matches(&event));
    }

    #[test]
    fn test_ids_filter_match() {
        // {"ids": ["abc..."]} は該当IDにマッチ
        let event = create_test_event();
        let filter = Filter {
            ids: Some(vec![event.id]),
            ..Default::default()
        };
        assert!(filter.matches(&event));
    }

    #[test]
    fn test_ids_filter_no_match() {
        // IDが一致しない場合
        let event = create_test_event();
        let filter = Filter {
            ids: Some(vec![
                "0000000000000000000000000000000000000000000000000000000000000000"
                    .parse()
                    .unwrap(),
            ]),
            ..Default::default()
        };
        assert!(!filter.matches(&event));
    }

    #[test]
    fn test_authors_filter_match() {
        let event = create_test_event();
        let filter = Filter {
            authors: Some(vec![event.pubkey]),
            ..Default::default()
        };
        assert!(filter.matches(&event));
    }

    #[test]
    fn test_kinds_filter_match() {
        let event = create_test_event();
        let filter = Filter {
            kinds: Some(vec![event.kind]),
            ..Default::default()
        };
        assert!(filter.matches(&event));
    }

    #[test]
    fn test_kinds_filter_no_match() {
        let event = create_test_event();
        // イベントはkind=1なので、kind=2はマッチしない
        let filter = Filter {
            kinds: Some(vec![serde_json::from_str("2").unwrap()]),
            ..Default::default()
        };
        assert!(!filter.matches(&event));
    }

    #[test]
    fn test_compound_filter_and() {
        // 複合条件のAND動作
        let event = create_test_event();

        // すべての条件が一致
        let filter = Filter {
            ids: Some(vec![event.id]),
            authors: Some(vec![event.pubkey]),
            kinds: Some(vec![event.kind]),
            ..Default::default()
        };
        assert!(filter.matches(&event));

        // 1つでも不一致ならマッチしない
        let filter_no_match = Filter {
            ids: Some(vec![event.id]),
            authors: Some(vec![event.pubkey]),
            kinds: Some(vec![serde_json::from_str("2").unwrap()]), // kind不一致
            ..Default::default()
        };
        assert!(!filter_no_match.matches(&event));
    }

    #[test]
    fn test_tag_filter_match() {
        // タグフィルタのマッチング
        let event = create_test_event();

        let mut tags = TagFilters::new();
        tags.insert('e', vec!["event123".to_string()]);

        let filter = Filter {
            tags,
            ..Default::default()
        };
        assert!(filter.matches(&event));
    }

    #[test]
    fn test_tag_filter_no_match() {
        let event = create_test_event();

        let mut tags = TagFilters::new();
        tags.insert('e', vec!["different_event".to_string()]);

        let filter = Filter {
            tags,
            ..Default::default()
        };
        assert!(!filter.matches(&event));
    }

    #[test]
    fn test_tag_filter_multiple_values() {
        // フィルタ値のいずれかに一致すればマッチ
        let event = create_test_event();

        let mut tags = TagFilters::new();
        tags.insert('e', vec!["other".to_string(), "event123".to_string()]);

        let filter = Filter {
            tags,
            ..Default::default()
        };
        assert!(filter.matches(&event));
    }

    #[test]
    fn test_tag_filter_empty_values_no_match() {
        // 空のタグフィルタ値は何もマッチしない
        let event = create_test_event();

        let mut tags = TagFilters::new();
        tags.insert('e', vec![]);

        let filter = Filter {
            tags,
            ..Default::default()
        };
        assert!(!filter.matches(&event));
    }

    #[test]
    fn test_tag_filter_multiple_tags_and() {
        // 複数タグフィルタはAND
        let event = create_test_event();

        let mut tags = TagFilters::new();
        tags.insert('e', vec!["event123".to_string()]);
        tags.insert('p', vec!["pubkey456".to_string()]);

        let filter = Filter {
            tags,
            ..Default::default()
        };
        assert!(filter.matches(&event));

        // 1つでも不一致ならマッチしない
        let mut tags_no_match = TagFilters::new();
        tags_no_match.insert('e', vec!["event123".to_string()]);
        tags_no_match.insert('p', vec!["different".to_string()]);

        let filter_no_match = Filter {
            tags: tags_no_match,
            ..Default::default()
        };
        assert!(!filter_no_match.matches(&event));
    }

    #[test]
    fn test_since_filter_match() {
        let event = create_test_event();
        // created_at = 1234567890

        // since <= created_at でマッチ
        let filter = Filter {
            since: Some(serde_json::from_str("1234567890").unwrap()),
            ..Default::default()
        };
        assert!(filter.matches(&event));

        let filter_earlier = Filter {
            since: Some(serde_json::from_str("1234567889").unwrap()),
            ..Default::default()
        };
        assert!(filter_earlier.matches(&event));
    }

    #[test]
    fn test_since_filter_no_match() {
        let event = create_test_event();

        // since > created_at でマッチしない
        let filter = Filter {
            since: Some(serde_json::from_str("1234567891").unwrap()),
            ..Default::default()
        };
        assert!(!filter.matches(&event));
    }

    #[test]
    fn test_until_filter_match() {
        let event = create_test_event();

        // until >= created_at でマッチ
        let filter = Filter {
            until: Some(serde_json::from_str("1234567890").unwrap()),
            ..Default::default()
        };
        assert!(filter.matches(&event));

        let filter_later = Filter {
            until: Some(serde_json::from_str("1234567891").unwrap()),
            ..Default::default()
        };
        assert!(filter_later.matches(&event));
    }

    #[test]
    fn test_until_filter_no_match() {
        let event = create_test_event();

        // until < created_at でマッチしない
        let filter = Filter {
            until: Some(serde_json::from_str("1234567889").unwrap()),
            ..Default::default()
        };
        assert!(!filter.matches(&event));
    }

    #[test]
    fn test_since_until_contradiction() {
        // since > until で何もマッチしない
        let event = create_test_event();

        let filter = Filter {
            since: Some(serde_json::from_str("1234567900").unwrap()),
            until: Some(serde_json::from_str("1234567800").unwrap()),
            ..Default::default()
        };
        assert!(!filter.matches(&event));
    }

    #[test]
    fn test_limit_field_parsed() {
        // limitフィールドはパースされるが、matchesには影響しない
        let json = r##"{"limit": 100}"##;
        let filter: Filter = serde_json::from_str(json).unwrap();
        assert_eq!(filter.limit, Some(100));

        let event = create_test_event();
        assert!(filter.matches(&event));
    }
}
