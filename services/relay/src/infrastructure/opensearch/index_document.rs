// OpenSearchインデックスドキュメント構造
//
// Nostrイベントを効率的に検索できるインデックス構造を定義する。
// NIP-01フィルター条件（ids、authors、kinds、#タグ、since、until、limit）に対応。
//
// 要件: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9

use nostr::Event;
use serde::{Deserialize, Serialize};

/// OpenSearchインデックスドキュメント
///
/// イベントIDをドキュメントIDとして使用し、NIP-01フィルター条件に対応した
/// 検索フィールドとevent_json（完全なイベントJSON）を格納する。
///
/// # フィールドマッピング
/// - id: keyword型 (要件 2.7)
/// - pubkey: keyword型 (要件 2.6)
/// - kind: integer型 (要件 2.4)
/// - created_at: long型（UNIXエポック秒）(要件 2.5)
/// - tag_e, tag_p, tag_d, tag_a, tag_t: keyword型配列 (要件 2.8)
/// - event_json: index: false（格納専用）(要件 2.3)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NostrEventDocument {
    /// イベントID (hex文字列、64文字)
    /// OpenSearchドキュメントIDとしても使用 (要件 2.1)
    pub id: String,

    /// 公開鍵 (hex文字列、64文字)
    pub pubkey: String,

    /// イベント種別
    pub kind: u16,

    /// 作成日時 (UNIXエポック秒)
    pub created_at: u64,

    /// eタグ（参照イベントID）の値リスト
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tag_e: Vec<String>,

    /// pタグ（参照公開鍵）の値リスト
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tag_p: Vec<String>,

    /// dタグ（Addressableイベント識別子）の値リスト
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tag_d: Vec<String>,

    /// aタグ（参照Addressableイベント）の値リスト
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tag_a: Vec<String>,

    /// tタグ（ハッシュタグ）の値リスト
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tag_t: Vec<String>,

    /// 完全なイベントJSON（格納専用、検索対象外）
    /// OpenSearchではindex: falseで定義される (要件 2.3)
    pub event_json: String,
}

impl NostrEventDocument {
    /// Nostrイベントからインデックスドキュメントを構築する
    ///
    /// # Arguments
    /// * `event` - Nostrイベント
    ///
    /// # Returns
    /// * `Result<NostrEventDocument, DocumentBuildError>` - 構築されたドキュメントまたはエラー
    pub fn from_event(event: &Event) -> Result<Self, DocumentBuildError> {
        // event_jsonをシリアライズ
        let event_json =
            serde_json::to_string(event).map_err(DocumentBuildError::SerializationError)?;

        // タグを抽出（英字1文字タグのみ）
        let mut tag_e = Vec::new();
        let mut tag_p = Vec::new();
        let mut tag_d = Vec::new();
        let mut tag_a = Vec::new();
        let mut tag_t = Vec::new();

        for tag in event.tags.iter() {
            let tag_vec = tag.as_slice();
            if tag_vec.len() >= 2 {
                let tag_name = &tag_vec[0];
                let tag_value = &tag_vec[1];

                // 英字1文字タグのみを抽出
                if tag_name.len() == 1 {
                    match tag_name.as_str() {
                        "e" => tag_e.push(tag_value.to_string()),
                        "p" => tag_p.push(tag_value.to_string()),
                        "d" => tag_d.push(tag_value.to_string()),
                        "a" => tag_a.push(tag_value.to_string()),
                        "t" => tag_t.push(tag_value.to_string()),
                        // その他の英字1文字タグは現在サポート外
                        _ => {}
                    }
                }
            }
        }

        Ok(NostrEventDocument {
            id: event.id.to_hex(),
            pubkey: event.pubkey.to_hex(),
            kind: event.kind.as_u16(),
            created_at: event.created_at.as_secs(),
            tag_e,
            tag_p,
            tag_d,
            tag_a,
            tag_t,
            event_json,
        })
    }

    /// ドキュメントIDを返す（イベントIDをそのまま使用）
    ///
    /// 要件 2.1: イベントIDをドキュメントIDとして使用
    pub fn document_id(&self) -> &str {
        &self.id
    }
}

/// ドキュメント構築エラー
#[derive(Debug, thiserror::Error)]
pub enum DocumentBuildError {
    #[error("イベントのシリアライズに失敗: {0}")]
    SerializationError(#[from] serde_json::Error),
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};

    /// テスト用にイベントを作成するヘルパー
    fn create_test_event(
        kind: Kind,
        content: &str,
        tags: Vec<Tag>,
        created_at: Timestamp,
    ) -> Event {
        let keys = Keys::generate();
        EventBuilder::new(kind, content)
            .tags(tags)
            .custom_created_at(created_at)
            .sign_with_keys(&keys)
            .expect("イベント署名に失敗")
    }

    #[test]
    fn test_from_event_basic_fields() {
        // 基本的なイベントからドキュメントを作成
        let event = create_test_event(
            Kind::TextNote, // kind: 1
            "Hello, Nostr!",
            vec![],
            Timestamp::from(1700000000),
        );

        let doc = NostrEventDocument::from_event(&event).expect("ドキュメント構築に失敗");

        // 要件 2.7: idフィールドはkeyword型（hex文字列）
        assert_eq!(doc.id.len(), 64);
        assert_eq!(doc.id, event.id.to_hex());

        // 要件 2.6: pubkeyフィールドはkeyword型（hex文字列）
        assert_eq!(doc.pubkey.len(), 64);
        assert_eq!(doc.pubkey, event.pubkey.to_hex());

        // 要件 2.4: kindフィールドはinteger型
        assert_eq!(doc.kind, 1u16);

        // 要件 2.5: created_atフィールドはlong型（UNIXエポック秒）
        assert_eq!(doc.created_at, 1700000000u64);

        // 要件 2.1: ドキュメントIDはイベントID
        assert_eq!(doc.document_id(), event.id.to_hex());
    }

    #[test]
    fn test_from_event_with_e_tag() {
        // 要件 2.8: eタグ（参照イベントID）を抽出
        let referenced_event_id =
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let event = create_test_event(
            Kind::TextNote,
            "Reply",
            vec![Tag::event(
                nostr::EventId::from_hex(referenced_event_id).unwrap(),
            )],
            Timestamp::from(1700000000),
        );

        let doc = NostrEventDocument::from_event(&event).expect("ドキュメント構築に失敗");

        assert_eq!(doc.tag_e.len(), 1);
        assert_eq!(doc.tag_e[0], referenced_event_id);
    }

    #[test]
    fn test_from_event_with_p_tag() {
        // 要件 2.8: pタグ（参照公開鍵）を抽出
        let referenced_pubkey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let event = create_test_event(
            Kind::TextNote,
            "Mention",
            vec![Tag::public_key(
                nostr::PublicKey::from_hex(referenced_pubkey).unwrap(),
            )],
            Timestamp::from(1700000000),
        );

        let doc = NostrEventDocument::from_event(&event).expect("ドキュメント構築に失敗");

        assert_eq!(doc.tag_p.len(), 1);
        assert_eq!(doc.tag_p[0], referenced_pubkey);
    }

    #[test]
    fn test_from_event_with_d_tag() {
        // 要件 2.8: dタグ（Addressableイベント識別子）を抽出
        let identifier = "my-article";
        let event = create_test_event(
            Kind::LongFormTextNote, // kind: 30023
            "Article content",
            vec![Tag::identifier(identifier)],
            Timestamp::from(1700000000),
        );

        let doc = NostrEventDocument::from_event(&event).expect("ドキュメント構築に失敗");

        assert_eq!(doc.tag_d.len(), 1);
        assert_eq!(doc.tag_d[0], identifier);
    }

    #[test]
    fn test_from_event_with_t_tag() {
        // 要件 2.8: tタグ（ハッシュタグ）を抽出
        let hashtag = "nostr";
        let event = create_test_event(
            Kind::TextNote,
            "Hello #nostr",
            vec![Tag::hashtag(hashtag)],
            Timestamp::from(1700000000),
        );

        let doc = NostrEventDocument::from_event(&event).expect("ドキュメント構築に失敗");

        assert_eq!(doc.tag_t.len(), 1);
        assert_eq!(doc.tag_t[0], hashtag);
    }

    #[test]
    fn test_from_event_with_a_tag() {
        // 要件 2.8: aタグ（参照Addressableイベント）を抽出
        // aタグの値は "kind:pubkey:identifier" 形式
        let a_tag_value = "30023:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef:test";
        let a_tag = Tag::parse(["a", a_tag_value]).expect("aタグのパースに失敗");

        let event = create_test_event(
            Kind::TextNote,
            "Reference to article",
            vec![a_tag],
            Timestamp::from(1700000000),
        );

        let doc = NostrEventDocument::from_event(&event).expect("ドキュメント構築に失敗");

        assert_eq!(doc.tag_a.len(), 1);
        assert_eq!(doc.tag_a[0], a_tag_value);
    }

    #[test]
    fn test_from_event_with_multiple_tags() {
        // 複数のタグがある場合のテスト
        let event_id1 = "1111111111111111111111111111111111111111111111111111111111111111";
        let event_id2 = "2222222222222222222222222222222222222222222222222222222222222222";
        let pubkey1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

        let event = create_test_event(
            Kind::TextNote,
            "Multiple tags",
            vec![
                Tag::event(nostr::EventId::from_hex(event_id1).unwrap()),
                Tag::event(nostr::EventId::from_hex(event_id2).unwrap()),
                Tag::public_key(nostr::PublicKey::from_hex(pubkey1).unwrap()),
                Tag::hashtag("tag1"),
                Tag::hashtag("tag2"),
            ],
            Timestamp::from(1700000000),
        );

        let doc = NostrEventDocument::from_event(&event).expect("ドキュメント構築に失敗");

        assert_eq!(doc.tag_e.len(), 2);
        assert!(doc.tag_e.contains(&event_id1.to_string()));
        assert!(doc.tag_e.contains(&event_id2.to_string()));

        assert_eq!(doc.tag_p.len(), 1);
        assert_eq!(doc.tag_p[0], pubkey1);

        assert_eq!(doc.tag_t.len(), 2);
        assert!(doc.tag_t.contains(&"tag1".to_string()));
        assert!(doc.tag_t.contains(&"tag2".to_string()));
    }

    #[test]
    fn test_from_event_event_json() {
        // 要件 2.3: 完全なイベントJSONが格納されること
        let event = create_test_event(
            Kind::TextNote,
            "Test content",
            vec![],
            Timestamp::from(1700000000),
        );

        let doc = NostrEventDocument::from_event(&event).expect("ドキュメント構築に失敗");

        // event_jsonが有効なJSONであること
        let parsed: serde_json::Value =
            serde_json::from_str(&doc.event_json).expect("event_jsonのパースに失敗");

        // 必須フィールドが含まれていること
        assert!(parsed.get("id").is_some());
        assert!(parsed.get("pubkey").is_some());
        assert!(parsed.get("kind").is_some());
        assert!(parsed.get("created_at").is_some());
        assert!(parsed.get("content").is_some());
        assert!(parsed.get("sig").is_some());
    }

    #[test]
    fn test_document_serialization() {
        // ドキュメントがOpenSearchに送信可能な形式でシリアライズされること
        let event = create_test_event(
            Kind::TextNote,
            "Test",
            vec![Tag::hashtag("test")],
            Timestamp::from(1700000000),
        );

        let doc = NostrEventDocument::from_event(&event).expect("ドキュメント構築に失敗");

        // JSONにシリアライズ
        let json = serde_json::to_string(&doc).expect("シリアライズに失敗");
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("パースに失敗");

        // フィールドの型を確認
        assert!(parsed["id"].is_string()); // keyword
        assert!(parsed["pubkey"].is_string()); // keyword
        assert!(parsed["kind"].is_number()); // integer
        assert!(parsed["created_at"].is_number()); // long
        assert!(parsed["tag_t"].is_array()); // keyword array
        assert!(parsed["event_json"].is_string()); // text (index: false)
    }

    #[test]
    fn test_empty_tags_not_serialized() {
        // 空のタグ配列はシリアライズ時に省略される
        let event = create_test_event(
            Kind::TextNote,
            "No tags",
            vec![],
            Timestamp::from(1700000000),
        );

        let doc = NostrEventDocument::from_event(&event).expect("ドキュメント構築に失敗");
        let json = serde_json::to_string(&doc).expect("シリアライズに失敗");

        // 空のタグフィールドは含まれない
        assert!(!json.contains("tag_e"));
        assert!(!json.contains("tag_p"));
        assert!(!json.contains("tag_d"));
        assert!(!json.contains("tag_a"));
        assert!(!json.contains("tag_t"));
    }
}
