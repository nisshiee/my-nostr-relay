//! リレー制限値設定
//!
//! NIP-11 limitation フィールドに対応する制限値を環境変数から読み込む

use std::env;

use tracing::{info, warn};

// デフォルト値
/// WebSocketメッセージの最大バイト数（128KB）
pub const DEFAULT_MAX_MESSAGE_LENGTH: u32 = 131072;
/// 1接続あたりの最大サブスクリプション数
pub const DEFAULT_MAX_SUBSCRIPTIONS: u32 = 20;
/// 1 REQ あたりの最大フィルタ数
pub const DEFAULT_MAX_FILTERS: u32 = 10;
/// サブスクリプションIDの最大文字数（NIP-01仕様: 64固定）
pub const DEFAULT_MAX_SUBID_LENGTH: u32 = 64;
/// イベントの最大タグ数
pub const DEFAULT_MAX_EVENT_TAGS: u32 = 2000;
/// コンテンツの最大文字数（64KB）
pub const DEFAULT_MAX_CONTENT_LENGTH: u32 = 65536;
/// 過去の created_at 許容範囲（秒）（1年）
pub const DEFAULT_CREATED_AT_LOWER_LIMIT: u64 = 31536000;
/// 未来の created_at 許容範囲（秒）（15分）
pub const DEFAULT_CREATED_AT_UPPER_LIMIT: u64 = 900;

// 環境変数名
const ENV_MAX_MESSAGE_LENGTH: &str = "RELAY_MAX_MESSAGE_LENGTH";
const ENV_MAX_SUBSCRIPTIONS: &str = "RELAY_MAX_SUBSCRIPTIONS";
const ENV_MAX_FILTERS: &str = "RELAY_MAX_FILTERS";
const ENV_MAX_EVENT_TAGS: &str = "RELAY_MAX_EVENT_TAGS";
const ENV_MAX_CONTENT_LENGTH: &str = "RELAY_MAX_CONTENT_LENGTH";
const ENV_CREATED_AT_LOWER_LIMIT: &str = "RELAY_CREATED_AT_LOWER_LIMIT";
const ENV_CREATED_AT_UPPER_LIMIT: &str = "RELAY_CREATED_AT_UPPER_LIMIT";

/// NIP-11 limitation に対応する制限値設定
#[derive(Debug, Clone, PartialEq)]
pub struct LimitationConfig {
    /// WebSocketメッセージの最大バイト数
    pub max_message_length: u32,
    /// 1接続あたりの最大サブスクリプション数
    pub max_subscriptions: u32,
    /// 1 REQ あたりの最大フィルタ数
    pub max_filters: u32,
    /// サブスクリプションIDの最大文字数
    pub max_subid_length: u32,
    /// イベントの最大タグ数
    pub max_event_tags: u32,
    /// コンテンツの最大文字数
    pub max_content_length: u32,
    /// 過去の created_at 許容範囲（秒）
    pub created_at_lower_limit: u64,
    /// 未来の created_at 許容範囲（秒）
    pub created_at_upper_limit: u64,
}

impl Default for LimitationConfig {
    fn default() -> Self {
        Self {
            max_message_length: DEFAULT_MAX_MESSAGE_LENGTH,
            max_subscriptions: DEFAULT_MAX_SUBSCRIPTIONS,
            max_filters: DEFAULT_MAX_FILTERS,
            max_subid_length: DEFAULT_MAX_SUBID_LENGTH,
            max_event_tags: DEFAULT_MAX_EVENT_TAGS,
            max_content_length: DEFAULT_MAX_CONTENT_LENGTH,
            created_at_lower_limit: DEFAULT_CREATED_AT_LOWER_LIMIT,
            created_at_upper_limit: DEFAULT_CREATED_AT_UPPER_LIMIT,
        }
    }
}

impl LimitationConfig {
    /// 環境変数から制限値設定を読み込む
    ///
    /// 設定されていない項目はデフォルト値を使用
    pub fn from_env() -> Self {
        let config = Self {
            max_message_length: parse_env_u32(ENV_MAX_MESSAGE_LENGTH, DEFAULT_MAX_MESSAGE_LENGTH),
            max_subscriptions: parse_env_u32(ENV_MAX_SUBSCRIPTIONS, DEFAULT_MAX_SUBSCRIPTIONS),
            max_filters: parse_env_u32(ENV_MAX_FILTERS, DEFAULT_MAX_FILTERS),
            max_subid_length: DEFAULT_MAX_SUBID_LENGTH, // NIP-01仕様固定
            max_event_tags: parse_env_u32(ENV_MAX_EVENT_TAGS, DEFAULT_MAX_EVENT_TAGS),
            max_content_length: parse_env_u32(ENV_MAX_CONTENT_LENGTH, DEFAULT_MAX_CONTENT_LENGTH),
            created_at_lower_limit: parse_env_u64(
                ENV_CREATED_AT_LOWER_LIMIT,
                DEFAULT_CREATED_AT_LOWER_LIMIT,
            ),
            created_at_upper_limit: parse_env_u64(
                ENV_CREATED_AT_UPPER_LIMIT,
                DEFAULT_CREATED_AT_UPPER_LIMIT,
            ),
        };

        info!(
            max_message_length = config.max_message_length,
            max_subscriptions = config.max_subscriptions,
            max_filters = config.max_filters,
            max_subid_length = config.max_subid_length,
            max_event_tags = config.max_event_tags,
            max_content_length = config.max_content_length,
            created_at_lower_limit = config.created_at_lower_limit,
            created_at_upper_limit = config.created_at_upper_limit,
            "制限値設定を読み込みました"
        );

        config
    }
}

/// 環境変数から u32 を読み込む（パース失敗時はデフォルト値）
fn parse_env_u32(key: &str, default: u32) -> u32 {
    match env::var(key) {
        Ok(v) => match v.parse() {
            Ok(parsed) => parsed,
            Err(_) => {
                warn!(key = key, value = %v, default = default, "環境変数の値が不正です。デフォルト値を使用します");
                default
            }
        },
        Err(_) => default,
    }
}

/// 環境変数から u64 を読み込む（パース失敗時はデフォルト値）
fn parse_env_u64(key: &str, default: u64) -> u64 {
    match env::var(key) {
        Ok(v) => match v.parse() {
            Ok(parsed) => parsed,
            Err(_) => {
                warn!(key = key, value = %v, default = default, "環境変数の値が不正です。デフォルト値を使用します");
                default
            }
        },
        Err(_) => default,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    fn test_default_config() {
        let config = LimitationConfig::default();
        assert_eq!(config.max_message_length, 131072);
        assert_eq!(config.max_subscriptions, 20);
        assert_eq!(config.max_filters, 10);
        assert_eq!(config.max_subid_length, 64);
        assert_eq!(config.max_event_tags, 2000);
        assert_eq!(config.max_content_length, 65536);
        assert_eq!(config.created_at_lower_limit, 31536000);
        assert_eq!(config.created_at_upper_limit, 900);
    }

    #[test]
    #[serial]
    fn test_from_env_defaults() {
        // 環境変数をクリア
        for key in [
            ENV_MAX_MESSAGE_LENGTH,
            ENV_MAX_SUBSCRIPTIONS,
            ENV_MAX_FILTERS,
            ENV_MAX_EVENT_TAGS,
            ENV_MAX_CONTENT_LENGTH,
            ENV_CREATED_AT_LOWER_LIMIT,
            ENV_CREATED_AT_UPPER_LIMIT,
        ] {
            unsafe {
                env::remove_var(key);
            }
        }

        let config = LimitationConfig::from_env();
        assert_eq!(config, LimitationConfig::default());
    }

    #[test]
    #[serial]
    fn test_from_env_custom_values() {
        unsafe {
            env::set_var(ENV_MAX_MESSAGE_LENGTH, "262144");
            env::set_var(ENV_MAX_SUBSCRIPTIONS, "50");
            env::set_var(ENV_MAX_FILTERS, "20");
            env::set_var(ENV_MAX_EVENT_TAGS, "5000");
            env::set_var(ENV_MAX_CONTENT_LENGTH, "131072");
            env::set_var(ENV_CREATED_AT_LOWER_LIMIT, "63072000");
            env::set_var(ENV_CREATED_AT_UPPER_LIMIT, "1800");
        }

        let config = LimitationConfig::from_env();
        assert_eq!(config.max_message_length, 262144);
        assert_eq!(config.max_subscriptions, 50);
        assert_eq!(config.max_filters, 20);
        assert_eq!(config.max_event_tags, 5000);
        assert_eq!(config.max_content_length, 131072);
        assert_eq!(config.created_at_lower_limit, 63072000);
        assert_eq!(config.created_at_upper_limit, 1800);

        // クリーンアップ
        for key in [
            ENV_MAX_MESSAGE_LENGTH,
            ENV_MAX_SUBSCRIPTIONS,
            ENV_MAX_FILTERS,
            ENV_MAX_EVENT_TAGS,
            ENV_MAX_CONTENT_LENGTH,
            ENV_CREATED_AT_LOWER_LIMIT,
            ENV_CREATED_AT_UPPER_LIMIT,
        ] {
            unsafe {
                env::remove_var(key);
            }
        }
    }

    #[test]
    #[serial]
    fn test_from_env_invalid_values_use_defaults() {
        unsafe {
            env::set_var(ENV_MAX_MESSAGE_LENGTH, "not_a_number");
            env::set_var(ENV_MAX_SUBSCRIPTIONS, "-1");
        }

        let config = LimitationConfig::from_env();
        assert_eq!(config.max_message_length, DEFAULT_MAX_MESSAGE_LENGTH);
        assert_eq!(config.max_subscriptions, DEFAULT_MAX_SUBSCRIPTIONS);

        unsafe {
            env::remove_var(ENV_MAX_MESSAGE_LENGTH);
            env::remove_var(ENV_MAX_SUBSCRIPTIONS);
        }
    }
}
