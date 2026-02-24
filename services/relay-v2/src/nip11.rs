//! NIP-11 Relay Information Document 実装

use serde::Serialize;
use std::env;

use crate::config::LimitationConfig;

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
    /// - `RELAY_SUPPORTED_NIPS`: サポートNIP番号（カンマ区切り、デフォルト: "1"）
    /// - `RELAY_SOFTWARE`: ソフトウェアURL（デフォルト: "https://github.com/nisshiee/my-nostr-relay"）
    /// - `RELAY_VERSION`: バージョン（デフォルト: Cargo.tomlのversion）
    ///
    /// # Errors
    ///
    /// `RELAY_PUBKEY` が設定されていない場合はエラーを返します
    /// LimitationConfigを指定してRelayInformationを構築
    pub fn from_env_with_config(limitation_config: &LimitationConfig) -> Result<Self, Box<dyn std::error::Error>> {
        let name = env::var("RELAY_NAME")
            .unwrap_or_else(|_| "Nostr Relay".to_string());
        
        let description = env::var("RELAY_DESCRIPTION")
            .unwrap_or_else(|_| "A Nostr relay server".to_string());
        
        let pubkey = env::var("RELAY_PUBKEY")
            .map_err(|_| "RELAY_PUBKEY環境変数が設定されていません")?;
        
        let contact = env::var("RELAY_CONTACT")
            .unwrap_or_default();
        
        let supported_nips_str = env::var("RELAY_SUPPORTED_NIPS")
            .unwrap_or_else(|_| "1".to_string());
        let supported_nips = parse_nip_list(&supported_nips_str)?;
        
        let software = env::var("RELAY_SOFTWARE")
            .unwrap_or_else(|_| "https://github.com/nisshiee/my-nostr-relay".to_string());
        
        let version = env::var("RELAY_VERSION")
            .unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_string());

        let limitation = Limitation::from(limitation_config);

        Ok(Self {
            name,
            description,
            pubkey,
            contact,
            supported_nips,
            software,
            version,
            limitation,
        })
    }

    pub fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        Self::from_env_with_config(&LimitationConfig::from_env())
    }
}

/// カンマ区切りのNIP番号文字列をu16のVecに変換
///
/// # Examples
/// ```
/// # use relay::nip11::parse_nip_list;
/// assert_eq!(parse_nip_list("1,9,11").unwrap(), vec![1, 9, 11]);
/// assert_eq!(parse_nip_list("1").unwrap(), vec![1]);
/// assert_eq!(parse_nip_list("").unwrap(), Vec::<u16>::new());
/// ```
pub fn parse_nip_list(input: &str) -> Result<Vec<u16>, Box<dyn std::error::Error>> {
    if input.trim().is_empty() {
        return Ok(vec![]);
    }
    
    input
        .split(',')
        .map(|s| s.trim().parse::<u16>().map_err(|e| format!("NIP番号パースエラー: {}", e).into()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_nip_list_single() {
        assert_eq!(parse_nip_list("1").unwrap(), vec![1]);
    }

    #[test]
    fn test_parse_nip_list_multiple() {
        assert_eq!(parse_nip_list("1,9,11").unwrap(), vec![1, 9, 11]);
    }

    #[test]
    fn test_parse_nip_list_with_spaces() {
        assert_eq!(parse_nip_list("1, 9 , 11").unwrap(), vec![1, 9, 11]);
    }

    #[test]
    fn test_parse_nip_list_empty() {
        assert_eq!(parse_nip_list("").unwrap(), Vec::<u16>::new());
        assert_eq!(parse_nip_list("   ").unwrap(), Vec::<u16>::new());
    }

    #[test]
    fn test_parse_nip_list_invalid() {
        assert!(parse_nip_list("1,abc,11").is_err());
        assert!(parse_nip_list("1,999999").is_err()); // u16の範囲外
    }

    #[test]
    fn test_relay_information_from_env_missing_pubkey() {
        // RELAY_PUBKEY を削除
        unsafe {
            env::remove_var("RELAY_PUBKEY");
            env::remove_var("RELAY_NAME");
            env::remove_var("RELAY_DESCRIPTION");
            env::remove_var("RELAY_CONTACT");
            env::remove_var("RELAY_SUPPORTED_NIPS");
            env::remove_var("RELAY_SOFTWARE");
            env::remove_var("RELAY_VERSION");
        }

        let result = RelayInformation::from_env();
        assert!(result.is_err());
    }

    #[test]
    fn test_relay_information_from_env_with_pubkey() {
        unsafe {
            env::set_var("RELAY_PUBKEY", "deadbeef");
            env::set_var("RELAY_NAME", "Test Relay");
            env::set_var("RELAY_DESCRIPTION", "Test Description");
            env::set_var("RELAY_CONTACT", "test@example.com");
            env::set_var("RELAY_SUPPORTED_NIPS", "1,9,11");
            env::set_var("RELAY_SOFTWARE", "https://example.com/repo");
            env::set_var("RELAY_VERSION", "1.0.0");
        }

        let info = RelayInformation::from_env().unwrap();
        assert_eq!(info.name, "Test Relay");
        assert_eq!(info.description, "Test Description");
        assert_eq!(info.pubkey, "deadbeef");
        assert_eq!(info.contact, "test@example.com");
        assert_eq!(info.supported_nips, vec![1, 9, 11]);
        assert_eq!(info.software, "https://example.com/repo");
        assert_eq!(info.version, "1.0.0");

        // クリーンアップ
        unsafe {
            env::remove_var("RELAY_PUBKEY");
            env::remove_var("RELAY_NAME");
            env::remove_var("RELAY_DESCRIPTION");
            env::remove_var("RELAY_CONTACT");
            env::remove_var("RELAY_SUPPORTED_NIPS");
            env::remove_var("RELAY_SOFTWARE");
            env::remove_var("RELAY_VERSION");
        }
    }

    #[test]
    fn test_relay_information_from_env_defaults() {
        unsafe {
            env::set_var("RELAY_PUBKEY", "abcdef123456");
            env::remove_var("RELAY_NAME");
            env::remove_var("RELAY_DESCRIPTION");
            env::remove_var("RELAY_CONTACT");
            env::remove_var("RELAY_SUPPORTED_NIPS");
            env::remove_var("RELAY_SOFTWARE");
            env::remove_var("RELAY_VERSION");
        }

        let info = RelayInformation::from_env().unwrap();
        assert_eq!(info.name, "Nostr Relay");
        assert_eq!(info.description, "A Nostr relay server");
        assert_eq!(info.pubkey, "abcdef123456");
        assert_eq!(info.contact, "");
        assert_eq!(info.supported_nips, vec![1]);
        assert_eq!(info.software, "https://github.com/nisshiee/my-nostr-relay");
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));

        // クリーンアップ
        unsafe {
            env::remove_var("RELAY_PUBKEY");
        }
    }
}