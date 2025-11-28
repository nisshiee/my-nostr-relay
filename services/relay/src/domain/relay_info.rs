// NIP-11リレー情報ドキュメント
//
// このモジュールはNIP-11（Relay Information Document）仕様に準拠した
// リレー情報JSONレスポンスの構造を定義する。

use serde::Serialize;

use crate::domain::LimitationConfig;

/// NIP-11リレー情報ドキュメント
///
/// クライアントがリレーの機能、制限、連絡先情報を把握するための
/// メタデータ構造体。JSONシリアライズ時に未設定フィールドは省略される。
#[derive(Debug, Clone, Serialize)]
pub struct RelayInfoDocument {
    // 基本フィールド (要件 2.1-2.9)
    /// リレーの識別名（30文字以下推奨）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,

    /// リレーの詳細説明
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// 管理者の32バイトhex公開鍵
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pubkey: Option<String>,

    /// 代替連絡先URI（mailto:やhttps:スキーム）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contact: Option<String>,

    /// サポートするNIP番号の配列
    pub supported_nips: Vec<u32>,

    /// リレーソフトウェアのプロジェクトホームページURL
    pub software: String,

    /// ソフトウェアのバージョン文字列
    pub version: String,

    /// リレーのアイコン画像URL（正方形推奨、.jpg/.png形式）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,

    /// リレーのバナー画像URL（.jpg/.png形式）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub banner: Option<String>,

    // 制限情報 (要件 4.1-4.3)
    /// リレーの制限設定
    pub limitation: RelayLimitation,

    // コミュニティ・ロケール (要件 7.1-7.5)
    /// 法的管轄の国コード（ISO 3166-1 alpha-2）の配列
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub relay_countries: Vec<String>,

    /// 主要言語タグ（IETF言語タグ形式）の配列
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub language_tags: Vec<String>,
}

/// リレーソフトウェアのプロジェクトURL（固定値）
pub const SOFTWARE_URL: &str = "https://github.com/nisshiee/my-nostr-relay";

/// 現在サポートしているNIP番号
/// NIP追加時は手動で更新が必要
pub const SUPPORTED_NIPS: &[u32] = &[1, 11];

impl RelayInfoDocument {
    /// 新しいリレー情報ドキュメントを作成
    ///
    /// # Arguments
    /// * `name` - リレー名
    /// * `description` - リレー説明
    /// * `pubkey` - 管理者公開鍵
    /// * `contact` - 連絡先URI
    /// * `icon` - アイコンURL
    /// * `banner` - バナーURL
    /// * `relay_countries` - 国コード配列
    /// * `language_tags` - 言語タグ配列
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        name: Option<String>,
        description: Option<String>,
        pubkey: Option<String>,
        contact: Option<String>,
        icon: Option<String>,
        banner: Option<String>,
        relay_countries: Vec<String>,
        language_tags: Vec<String>,
    ) -> Self {
        Self::with_limitation(
            name,
            description,
            pubkey,
            contact,
            icon,
            banner,
            relay_countries,
            language_tags,
            RelayLimitation::default(),
        )
    }

    /// 制限情報を指定してリレー情報ドキュメントを作成
    ///
    /// # Arguments
    /// * `name` - リレー名
    /// * `description` - リレー説明
    /// * `pubkey` - 管理者公開鍵
    /// * `contact` - 連絡先URI
    /// * `icon` - アイコンURL
    /// * `banner` - バナーURL
    /// * `relay_countries` - 国コード配列
    /// * `language_tags` - 言語タグ配列
    /// * `limitation` - 制限情報
    #[allow(clippy::too_many_arguments)]
    pub fn with_limitation(
        name: Option<String>,
        description: Option<String>,
        pubkey: Option<String>,
        contact: Option<String>,
        icon: Option<String>,
        banner: Option<String>,
        relay_countries: Vec<String>,
        language_tags: Vec<String>,
        limitation: RelayLimitation,
    ) -> Self {
        Self {
            name,
            description,
            pubkey,
            contact,
            supported_nips: SUPPORTED_NIPS.to_vec(),
            software: SOFTWARE_URL.to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            icon,
            banner,
            limitation,
            relay_countries,
            language_tags,
        }
    }
}

/// リレー制限情報
///
/// NIP-11 limitationオブジェクトとしてシリアライズされる。
/// 9つの制限フィールドを持ち、LimitationConfigから構築される。
#[derive(Debug, Clone, Serialize)]
pub struct RelayLimitation {
    /// WebSocketメッセージの最大バイト数
    pub max_message_length: u32,

    /// 1接続あたりの最大サブスクリプション数
    pub max_subscriptions: u32,

    /// フィルターlimitの最大値
    pub max_limit: u32,

    /// イベントの最大タグ数
    pub max_event_tags: u32,

    /// コンテンツの最大文字数
    pub max_content_length: u32,

    /// サブスクリプションIDの最大長（64固定）
    pub max_subid_length: u32,

    /// 過去のcreated_at許容範囲（秒）
    pub created_at_lower_limit: u64,

    /// 未来のcreated_at許容範囲（秒）
    pub created_at_upper_limit: u64,

    /// デフォルトlimit値
    pub default_limit: u32,
}

/// サブスクリプションIDの最大長（固定値）
/// NIP-01仕様: subscription_idは1-64文字
pub const MAX_SUBID_LENGTH: u32 = 64;

impl Default for RelayLimitation {
    fn default() -> Self {
        Self::from_config(&LimitationConfig::default())
    }
}

impl RelayLimitation {
    /// 新しいリレー制限情報を作成
    pub fn new() -> Self {
        Self::default()
    }

    /// LimitationConfigから構築
    ///
    /// 設定構造体の全フィールドをlimitationオブジェクトにマッピングする。
    /// フィールド名はNIP-11仕様に準拠。
    pub fn from_config(config: &LimitationConfig) -> Self {
        Self {
            max_message_length: config.max_message_length,
            max_subscriptions: config.max_subscriptions,
            max_limit: config.max_limit,
            max_event_tags: config.max_event_tags,
            max_content_length: config.max_content_length,
            max_subid_length: config.max_subid_length,
            created_at_lower_limit: config.created_at_lower_limit,
            created_at_upper_limit: config.created_at_upper_limit,
            default_limit: config.default_limit,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ===========================================
    // Task 1.1: NIP-11レスポンス構造体のテスト
    // ===========================================

    #[test]
    fn test_relay_info_document_serialization_with_all_fields() {
        // 全フィールド設定時のJSONシリアライズ
        let doc = RelayInfoDocument::new(
            Some("Test Relay".to_string()),
            Some("A test relay".to_string()),
            Some("abcd1234".repeat(8)),
            Some("mailto:admin@example.com".to_string()),
            Some("https://example.com/icon.png".to_string()),
            Some("https://example.com/banner.png".to_string()),
            vec!["JP".to_string()],
            vec!["ja".to_string()],
        );

        let json = serde_json::to_value(&doc).unwrap();

        // 基本フィールドの検証
        assert_eq!(json["name"], "Test Relay");
        assert_eq!(json["description"], "A test relay");
        assert_eq!(json["pubkey"], "abcd1234".repeat(8));
        assert_eq!(json["contact"], "mailto:admin@example.com");
        assert_eq!(json["icon"], "https://example.com/icon.png");
        assert_eq!(json["banner"], "https://example.com/banner.png");

        // 固定値フィールドの検証
        assert_eq!(json["software"], SOFTWARE_URL);
        assert_eq!(json["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(json["supported_nips"], serde_json::json!([1, 11]));

        // 制限情報の検証
        assert_eq!(json["limitation"]["max_subid_length"], 64);

        // ロケール情報の検証
        assert_eq!(json["relay_countries"], serde_json::json!(["JP"]));
        assert_eq!(json["language_tags"], serde_json::json!(["ja"]));
    }

    #[test]
    fn test_relay_info_document_omits_none_fields() {
        // Noneフィールドはシリアライズから省略される
        let doc = RelayInfoDocument::new(
            None,
            None,
            None,
            None,
            None,
            None,
            vec![],
            vec![],
        );

        let json = serde_json::to_value(&doc).unwrap();

        // Noneフィールドは省略される
        assert!(json.get("name").is_none());
        assert!(json.get("description").is_none());
        assert!(json.get("pubkey").is_none());
        assert!(json.get("contact").is_none());
        assert!(json.get("icon").is_none());
        assert!(json.get("banner").is_none());

        // 空配列も省略される
        assert!(json.get("relay_countries").is_none());
        assert!(json.get("language_tags").is_none());

        // 必須フィールドは存在する
        assert!(json.get("supported_nips").is_some());
        assert!(json.get("software").is_some());
        assert!(json.get("version").is_some());
        assert!(json.get("limitation").is_some());
    }

    #[test]
    fn test_relay_info_document_supported_nips_contains_1_and_11() {
        // サポートNIP配列に1と11が含まれる
        let doc = RelayInfoDocument::new(
            None, None, None, None, None, None, vec![], vec![],
        );

        assert!(doc.supported_nips.contains(&1));
        assert!(doc.supported_nips.contains(&11));
    }

    #[test]
    fn test_relay_info_document_software_url_is_correct() {
        // ソフトウェアURLが正しい
        let doc = RelayInfoDocument::new(
            None, None, None, None, None, None, vec![], vec![],
        );

        assert_eq!(doc.software, "https://github.com/nisshiee/my-nostr-relay");
    }

    #[test]
    fn test_relay_info_document_version_from_cargo() {
        // バージョンはCargo.tomlから取得
        let doc = RelayInfoDocument::new(
            None, None, None, None, None, None, vec![], vec![],
        );

        // Cargo.tomlのバージョンと一致することを確認
        assert_eq!(doc.version, env!("CARGO_PKG_VERSION"));
    }

    // ===========================================
    // Task 1.2: リレー制限情報モデルのテスト
    // ===========================================

    #[test]
    fn test_relay_limitation_default_max_subid_length() {
        // max_subid_lengthは64固定
        let limitation = RelayLimitation::default();
        assert_eq!(limitation.max_subid_length, 64);
    }

    #[test]
    fn test_relay_limitation_serialization() {
        // 制限情報のJSONシリアライズ
        let limitation = RelayLimitation::default();
        let json = serde_json::to_value(&limitation).unwrap();

        assert_eq!(json["max_subid_length"], 64);
    }

    #[test]
    fn test_relay_limitation_new() {
        // new()はdefault()と同じ
        let limitation = RelayLimitation::new();
        assert_eq!(limitation.max_subid_length, MAX_SUBID_LENGTH);
    }

    // ===========================================
    // Task 1.3: コミュニティ・ロケール情報のテスト
    // ===========================================

    #[test]
    fn test_relay_info_document_with_multiple_countries() {
        // 複数国コードの設定
        let doc = RelayInfoDocument::new(
            None, None, None, None, None, None,
            vec!["JP".to_string(), "US".to_string()],
            vec![],
        );

        assert_eq!(doc.relay_countries, vec!["JP", "US"]);

        let json = serde_json::to_value(&doc).unwrap();
        assert_eq!(json["relay_countries"], serde_json::json!(["JP", "US"]));
    }

    #[test]
    fn test_relay_info_document_with_multiple_language_tags() {
        // 複数言語タグの設定
        let doc = RelayInfoDocument::new(
            None, None, None, None, None, None,
            vec![],
            vec!["ja".to_string(), "en".to_string()],
        );

        assert_eq!(doc.language_tags, vec!["ja", "en"]);

        let json = serde_json::to_value(&doc).unwrap();
        assert_eq!(json["language_tags"], serde_json::json!(["ja", "en"]));
    }

    #[test]
    fn test_relay_info_document_empty_locale_fields_omitted() {
        // 空のロケールフィールドはJSONから省略
        let doc = RelayInfoDocument::new(
            Some("Test".to_string()),
            None, None, None, None, None,
            vec![],
            vec![],
        );

        let json = serde_json::to_value(&doc).unwrap();

        // 空配列は省略される
        assert!(json.get("relay_countries").is_none());
        assert!(json.get("language_tags").is_none());
    }

    #[test]
    fn test_relay_info_document_json_nip11_compliance() {
        // NIP-11仕様準拠の完全なJSONレスポンス構造テスト
        let doc = RelayInfoDocument::new(
            Some("My Relay".to_string()),
            Some("A personal relay".to_string()),
            Some("a".repeat(64)),
            Some("mailto:test@example.com".to_string()),
            Some("https://example.com/icon.png".to_string()),
            Some("https://example.com/banner.png".to_string()),
            vec!["JP".to_string()],
            vec!["ja".to_string()],
        );

        let json_str = serde_json::to_string_pretty(&doc).unwrap();

        // JSON文字列としてパース可能であること
        let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();

        // NIP-11で定義された全フィールドが正しい形式であること
        assert!(parsed["name"].is_string());
        assert!(parsed["description"].is_string());
        assert!(parsed["pubkey"].is_string());
        assert!(parsed["contact"].is_string());
        assert!(parsed["supported_nips"].is_array());
        assert!(parsed["software"].is_string());
        assert!(parsed["version"].is_string());
        assert!(parsed["icon"].is_string());
        assert!(parsed["banner"].is_string());
        assert!(parsed["limitation"].is_object());
        assert!(parsed["limitation"]["max_subid_length"].is_number());
        assert!(parsed["relay_countries"].is_array());
        assert!(parsed["language_tags"].is_array());
    }

    // ===========================================
    // Task 2.1: RelayLimitation拡張フィールドのテスト
    // ===========================================

    #[test]
    fn test_relay_limitation_has_all_nine_fields() {
        // RelayLimitationが9つの制限フィールドを全て持つことを検証
        use crate::domain::LimitationConfig;
        let config = LimitationConfig::default();
        let limitation = RelayLimitation::from_config(&config);

        // 全9フィールドがアクセス可能であることを確認
        assert_eq!(limitation.max_message_length, config.max_message_length);
        assert_eq!(limitation.max_subscriptions, config.max_subscriptions);
        assert_eq!(limitation.max_limit, config.max_limit);
        assert_eq!(limitation.max_event_tags, config.max_event_tags);
        assert_eq!(limitation.max_content_length, config.max_content_length);
        assert_eq!(limitation.max_subid_length, config.max_subid_length);
        assert_eq!(limitation.created_at_lower_limit, config.created_at_lower_limit);
        assert_eq!(limitation.created_at_upper_limit, config.created_at_upper_limit);
        assert_eq!(limitation.default_limit, config.default_limit);
    }

    #[test]
    fn test_relay_limitation_json_serialization_all_fields() {
        // RelayLimitationのJSONシリアライズで全9フィールドが出力されることを検証
        use crate::domain::LimitationConfig;
        let config = LimitationConfig::default();
        let limitation = RelayLimitation::from_config(&config);

        let json = serde_json::to_value(&limitation).unwrap();

        // NIP-11仕様に準拠したフィールド名で全フィールドが存在
        assert_eq!(json["max_message_length"], 131072);
        assert_eq!(json["max_subscriptions"], 20);
        assert_eq!(json["max_limit"], 5000);
        assert_eq!(json["max_event_tags"], 1000);
        assert_eq!(json["max_content_length"], 65536);
        assert_eq!(json["max_subid_length"], 64);
        assert_eq!(json["created_at_lower_limit"], 31536000);
        assert_eq!(json["created_at_upper_limit"], 900);
        assert_eq!(json["default_limit"], 100);
    }

    #[test]
    fn test_relay_limitation_json_field_count() {
        // RelayLimitationのJSON出力が正確に9フィールドであることを検証
        use crate::domain::LimitationConfig;
        let config = LimitationConfig::default();
        let limitation = RelayLimitation::from_config(&config);

        let json = serde_json::to_value(&limitation).unwrap();
        let obj = json.as_object().unwrap();

        assert_eq!(obj.len(), 9, "limitation object should have exactly 9 fields");
    }

    // ===========================================
    // Task 2.2: from_config変換機能のテスト
    // ===========================================

    #[test]
    fn test_relay_limitation_from_config_mapping() {
        // LimitationConfigからRelayLimitationへの変換が正しく行われることを検証
        use crate::domain::LimitationConfig;

        // カスタム値を持つ設定
        let config = LimitationConfig {
            max_message_length: 262144,
            max_subscriptions: 50,
            max_limit: 10000,
            max_event_tags: 2000,
            max_content_length: 131072,
            max_subid_length: 64,
            created_at_lower_limit: 63072000,
            created_at_upper_limit: 1800,
            default_limit: 200,
        };

        let limitation = RelayLimitation::from_config(&config);

        // 全フィールドが正しくマッピングされる
        assert_eq!(limitation.max_message_length, 262144);
        assert_eq!(limitation.max_subscriptions, 50);
        assert_eq!(limitation.max_limit, 10000);
        assert_eq!(limitation.max_event_tags, 2000);
        assert_eq!(limitation.max_content_length, 131072);
        assert_eq!(limitation.max_subid_length, 64);
        assert_eq!(limitation.created_at_lower_limit, 63072000);
        assert_eq!(limitation.created_at_upper_limit, 1800);
        assert_eq!(limitation.default_limit, 200);
    }

    #[test]
    fn test_relay_limitation_from_config_preserves_max_subid_length() {
        // from_configがmax_subid_lengthを保持することを検証
        use crate::domain::LimitationConfig;

        let config = LimitationConfig::default();
        let limitation = RelayLimitation::from_config(&config);

        // max_subid_lengthは64固定
        assert_eq!(limitation.max_subid_length, 64);
    }

    #[test]
    fn test_relay_limitation_from_config_json_output() {
        // from_configで生成したRelayLimitationのJSON出力がNIP-11仕様に準拠
        use crate::domain::LimitationConfig;

        let config = LimitationConfig {
            max_message_length: 100000,
            max_subscriptions: 10,
            max_limit: 1000,
            max_event_tags: 500,
            max_content_length: 32768,
            max_subid_length: 64,
            created_at_lower_limit: 15768000,
            created_at_upper_limit: 300,
            default_limit: 50,
        };

        let limitation = RelayLimitation::from_config(&config);
        let json = serde_json::to_value(&limitation).unwrap();

        // JSON出力がconfigの値と一致
        assert_eq!(json["max_message_length"], 100000);
        assert_eq!(json["max_subscriptions"], 10);
        assert_eq!(json["max_limit"], 1000);
        assert_eq!(json["max_event_tags"], 500);
        assert_eq!(json["max_content_length"], 32768);
        assert_eq!(json["max_subid_length"], 64);
        assert_eq!(json["created_at_lower_limit"], 15768000);
        assert_eq!(json["created_at_upper_limit"], 300);
        assert_eq!(json["default_limit"], 50);
    }
}
