//! NIP-11 Relay Information Document 実装

use serde::Serialize;
use std::env;

use crate::config::LimitationConfig;

/// 現在の実装でサポートしているNIP一覧
///
/// この値は実装状況に基づいて固定されている。
/// 新しいNIPを実装したらここに追加すること。
/// - NIP-01: 基本プロトコル（EVENT, REQ, CLOSE, OK, EOSE, CLOSED, Replaceable/Addressable/Ephemeral）
/// - NIP-09: イベント削除リクエスト（kind:5）
/// - NIP-11: Relay Information Document
/// - NIP-70: Protected Events（"-"タグ）
pub const SUPPORTED_NIPS: &[u16] = &[1, 9, 11, 70];

/// NIP-11 Relay Information Document
///
/// リレー情報を表すJSON構造体
#[derive(Debug, Clone, Serialize)]
pub struct RelayInformation {
    /// リレー名
    pub name: String,
    /// リレーの説明
    pub description: String,
    /// リレー管理者のpubkey（16進文字列）
    pub pubkey: String,
    /// 連絡先（メールアドレスやURLなど）
    pub contact: String,
    /// サポートしているNIPの番号一覧
    pub supported_nips: Vec<u16>,
    /// ソフトウェアリポジトリURL
    pub software: String,
    /// ソフトウェアバージョン
    pub version: String,
    /// NIP-11 制限値
    pub limitation: Limitation,
    /// プライバシーポリシーのURL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub privacy_policy: Option<String>,
    /// 利用規約のURL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terms_of_service: Option<String>,
    /// 投稿ポリシーのURL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub posting_policy: Option<String>,
    /// リレーのアイコン画像URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// リレーのバナー画像URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub banner: Option<String>,
}

/// NIP-11 limitation オブジェクト
#[derive(Debug, Clone, Serialize)]
pub struct Limitation {
    pub max_message_length: u32,
    pub max_subscriptions: u32,
    pub max_filters: u32,
    pub max_subid_length: u32,
    pub max_event_tags: u32,
    pub max_content_length: u32,
    pub created_at_lower_limit: u64,
    pub created_at_upper_limit: u64,
}

impl From<&LimitationConfig> for Limitation {
    fn from(config: &LimitationConfig) -> Self {
        Self {
            max_message_length: config.max_message_length,
            max_subscriptions: config.max_subscriptions,
            max_filters: config.max_filters,
            max_subid_length: config.max_subid_length,
            max_event_tags: config.max_event_tags,
            max_content_length: config.max_content_length,
            created_at_lower_limit: config.created_at_lower_limit,
            created_at_upper_limit: config.created_at_upper_limit,
        }
    }
}

impl RelayInformation {
    /// 環境変数からRelayInformationを構築
    ///
    /// 以下の環境変数を参照します：
    /// - `RELAY_NAME`: リレー名（デフォルト: "Nostr Relay"）
    /// - `RELAY_DESCRIPTION`: リレー説明（デフォルト: "A Nostr relay server"）
    /// - `RELAY_PUBKEY`: 管理者pubkey（必須）
    /// - `RELAY_CONTACT`: 連絡先（デフォルト: ""）
    /// - `RELAY_SOFTWARE`: ソフトウェアURL（デフォルト: "https://github.com/nisshiee/my-nostr-relay"）
    /// - `RELAY_VERSION`: バージョン（デフォルト: Cargo.tomlのversion）
    ///
    /// `supported_nips` は実装状況に基づいて固定値（SUPPORTED_NIPS）を使用します。
    ///
    /// # Errors
    ///
    /// `RELAY_PUBKEY` が設定されていない場合はエラーを返します
    /// LimitationConfigを指定してRelayInformationを構築
    pub fn from_env_with_config(
        limitation_config: &LimitationConfig,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let name = env::var("RELAY_NAME").unwrap_or_else(|_| "Nostr Relay".to_string());

        let description =
            env::var("RELAY_DESCRIPTION").unwrap_or_else(|_| "A Nostr relay server".to_string());

        let pubkey =
            env::var("RELAY_PUBKEY").map_err(|_| "RELAY_PUBKEY環境変数が設定されていません")?;

        let contact = env::var("RELAY_CONTACT").unwrap_or_default();

        let supported_nips = SUPPORTED_NIPS.to_vec();

        let software = env::var("RELAY_SOFTWARE")
            .unwrap_or_else(|_| "https://github.com/nisshiee/my-nostr-relay".to_string());

        let version =
            env::var("RELAY_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_string());

        let limitation = Limitation::from(limitation_config);

        let privacy_policy = env::var("RELAY_PRIVACY_POLICY").ok();
        let terms_of_service = env::var("RELAY_TERMS_OF_SERVICE").ok();
        let posting_policy = env::var("RELAY_POSTING_POLICY").ok();
        let icon = env::var("RELAY_ICON").ok();
        let banner = env::var("RELAY_BANNER").ok();

        Ok(Self {
            name,
            description,
            pubkey,
            contact,
            supported_nips,
            software,
            version,
            limitation,
            privacy_policy,
            terms_of_service,
            posting_policy,
            icon,
            banner,
        })
    }

    pub fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        Self::from_env_with_config(&LimitationConfig::from_env())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    fn test_supported_nips_contains_expected() {
        // 実装済みNIPが含まれていることを確認
        assert!(SUPPORTED_NIPS.contains(&1), "NIP-01は必須");
        assert!(SUPPORTED_NIPS.contains(&9), "NIP-09は実装済み");
        assert!(SUPPORTED_NIPS.contains(&11), "NIP-11は実装済み");
        assert!(SUPPORTED_NIPS.contains(&70), "NIP-70は実装済み");
    }

    #[test]
    fn test_supported_nips_is_sorted() {
        // ソート済みであることを確認
        let mut sorted = SUPPORTED_NIPS.to_vec();
        sorted.sort();
        assert_eq!(SUPPORTED_NIPS, sorted.as_slice());
    }

    #[test]
    #[serial]
    fn test_relay_information_from_env_missing_pubkey() {
        unsafe {
            env::remove_var("RELAY_PUBKEY");
            env::remove_var("RELAY_NAME");
            env::remove_var("RELAY_DESCRIPTION");
            env::remove_var("RELAY_CONTACT");
            env::remove_var("RELAY_SOFTWARE");
            env::remove_var("RELAY_VERSION");
            env::remove_var("RELAY_PRIVACY_POLICY");
            env::remove_var("RELAY_TERMS_OF_SERVICE");
            env::remove_var("RELAY_POSTING_POLICY");
            env::remove_var("RELAY_ICON");
            env::remove_var("RELAY_BANNER");
        }

        let result = RelayInformation::from_env();
        assert!(result.is_err());
    }

    #[test]
    #[serial]
    fn test_relay_information_from_env_with_pubkey() {
        unsafe {
            env::set_var("RELAY_PUBKEY", "deadbeef");
            env::set_var("RELAY_NAME", "Test Relay");
            env::set_var("RELAY_DESCRIPTION", "Test Description");
            env::set_var("RELAY_CONTACT", "test@example.com");
            env::set_var("RELAY_SOFTWARE", "https://example.com/repo");
            env::set_var("RELAY_VERSION", "1.0.0");
            env::set_var("RELAY_PRIVACY_POLICY", "https://example.com/privacy");
            env::set_var("RELAY_TERMS_OF_SERVICE", "https://example.com/tos");
            env::set_var("RELAY_POSTING_POLICY", "https://example.com/posting");
            env::set_var("RELAY_ICON", "https://example.com/icon.png");
            env::set_var("RELAY_BANNER", "https://example.com/banner.png");
        }

        let info = RelayInformation::from_env().unwrap();
        assert_eq!(info.name, "Test Relay");
        assert_eq!(info.description, "Test Description");
        assert_eq!(info.pubkey, "deadbeef");
        assert_eq!(info.contact, "test@example.com");
        // supported_nipsは環境変数ではなく定数から取得される
        assert_eq!(info.supported_nips, SUPPORTED_NIPS.to_vec());
        assert_eq!(info.software, "https://example.com/repo");
        assert_eq!(info.version, "1.0.0");
        assert_eq!(info.privacy_policy.as_deref(), Some("https://example.com/privacy"));
        assert_eq!(info.terms_of_service.as_deref(), Some("https://example.com/tos"));
        assert_eq!(info.posting_policy.as_deref(), Some("https://example.com/posting"));
        assert_eq!(info.icon.as_deref(), Some("https://example.com/icon.png"));
        assert_eq!(info.banner.as_deref(), Some("https://example.com/banner.png"));

        unsafe {
            env::remove_var("RELAY_PUBKEY");
            env::remove_var("RELAY_NAME");
            env::remove_var("RELAY_DESCRIPTION");
            env::remove_var("RELAY_CONTACT");
            env::remove_var("RELAY_SOFTWARE");
            env::remove_var("RELAY_VERSION");
            env::remove_var("RELAY_PRIVACY_POLICY");
            env::remove_var("RELAY_TERMS_OF_SERVICE");
            env::remove_var("RELAY_POSTING_POLICY");
            env::remove_var("RELAY_ICON");
            env::remove_var("RELAY_BANNER");
        }
    }

    #[test]
    #[serial]
    fn test_relay_information_from_env_defaults() {
        unsafe {
            env::set_var("RELAY_PUBKEY", "abcdef123456");
            env::remove_var("RELAY_NAME");
            env::remove_var("RELAY_DESCRIPTION");
            env::remove_var("RELAY_CONTACT");
            env::remove_var("RELAY_SOFTWARE");
            env::remove_var("RELAY_VERSION");
            env::remove_var("RELAY_PRIVACY_POLICY");
            env::remove_var("RELAY_TERMS_OF_SERVICE");
            env::remove_var("RELAY_POSTING_POLICY");
            env::remove_var("RELAY_ICON");
            env::remove_var("RELAY_BANNER");
        }

        let info = RelayInformation::from_env().unwrap();
        assert_eq!(info.name, "Nostr Relay");
        assert_eq!(info.description, "A Nostr relay server");
        assert_eq!(info.pubkey, "abcdef123456");
        assert_eq!(info.contact, "");
        assert_eq!(info.supported_nips, SUPPORTED_NIPS.to_vec());
        assert_eq!(info.software, "https://github.com/nisshiee/my-nostr-relay");
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
        assert!(info.privacy_policy.is_none());
        assert!(info.terms_of_service.is_none());
        assert!(info.posting_policy.is_none());
        assert!(info.icon.is_none());
        assert!(info.banner.is_none());

        unsafe {
            env::remove_var("RELAY_PUBKEY");
        }
    }

    #[test]
    #[serial]
    fn test_relay_information_partial_optional_fields() {
        // 一部のオプショナルフィールドのみ設定した場合のテスト
        unsafe {
            env::set_var("RELAY_PUBKEY", "partial_test_key");
            env::remove_var("RELAY_NAME");
            env::remove_var("RELAY_DESCRIPTION");
            env::remove_var("RELAY_CONTACT");
            env::remove_var("RELAY_SOFTWARE");
            env::remove_var("RELAY_VERSION");
            // privacy_policyとiconのみ設定
            env::set_var("RELAY_PRIVACY_POLICY", "https://example.com/privacy");
            env::remove_var("RELAY_TERMS_OF_SERVICE");
            env::remove_var("RELAY_POSTING_POLICY");
            env::set_var("RELAY_ICON", "https://example.com/icon.png");
            env::remove_var("RELAY_BANNER");
        }

        let info = RelayInformation::from_env().unwrap();
        assert_eq!(info.pubkey, "partial_test_key");
        // 設定したフィールドは値がある
        assert_eq!(info.privacy_policy.as_deref(), Some("https://example.com/privacy"));
        assert_eq!(info.icon.as_deref(), Some("https://example.com/icon.png"));
        // 未設定のフィールドはNone
        assert!(info.terms_of_service.is_none());
        assert!(info.posting_policy.is_none());
        assert!(info.banner.is_none());

        // JSONシリアライズでNoneのフィールドが省略されることを確認
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("privacy_policy"));
        assert!(json.contains("icon"));
        assert!(!json.contains("terms_of_service"));
        assert!(!json.contains("posting_policy"));
        assert!(!json.contains("banner"));

        unsafe {
            env::remove_var("RELAY_PUBKEY");
            env::remove_var("RELAY_PRIVACY_POLICY");
            env::remove_var("RELAY_ICON");
        }
    }
}
