// 制限値設定
//
// NIP-11で公開する制限値を型安全に保持し、
// 環境変数からの読み込みとデフォルト値を提供するドメイン層コンポーネント。

use tracing::info;

// ===========================================
// デフォルト値定義
// ===========================================

/// WebSocketメッセージの最大バイト数（128KB）
/// AWS API Gateway v2 WebSocketのメッセージサイズ上限
pub const DEFAULT_MAX_MESSAGE_LENGTH: u32 = 131072;

/// 1接続あたりの最大サブスクリプション数
pub const DEFAULT_MAX_SUBSCRIPTIONS: u32 = 20;

/// フィルターlimitの最大値
pub const DEFAULT_MAX_LIMIT: u32 = 5000;

/// イベントの最大タグ数
pub const DEFAULT_MAX_EVENT_TAGS: u32 = 1000;

/// コンテンツの最大文字数（64KB）
pub const DEFAULT_MAX_CONTENT_LENGTH: u32 = 65536;

/// サブスクリプションIDの最大長（NIP-01仕様により64固定）
pub const DEFAULT_MAX_SUBID_LENGTH: u32 = 64;

/// 過去のcreated_at許容範囲（秒）（1年）
pub const DEFAULT_CREATED_AT_LOWER_LIMIT: u64 = 31536000;

/// 未来のcreated_at許容範囲（秒）（15分）
pub const DEFAULT_CREATED_AT_UPPER_LIMIT: u64 = 900;

/// limitが指定されない場合のデフォルト値
pub const DEFAULT_DEFAULT_LIMIT: u32 = 100;

// ===========================================
// 環境変数名定義
// ===========================================

/// 環境変数名: max_message_length
pub const ENV_MAX_MESSAGE_LENGTH: &str = "RELAY_MAX_MESSAGE_LENGTH";

/// 環境変数名: max_subscriptions
pub const ENV_MAX_SUBSCRIPTIONS: &str = "RELAY_MAX_SUBSCRIPTIONS";

/// 環境変数名: max_limit
pub const ENV_MAX_LIMIT: &str = "RELAY_MAX_LIMIT";

/// 環境変数名: max_event_tags
pub const ENV_MAX_EVENT_TAGS: &str = "RELAY_MAX_EVENT_TAGS";

/// 環境変数名: max_content_length
pub const ENV_MAX_CONTENT_LENGTH: &str = "RELAY_MAX_CONTENT_LENGTH";

/// 環境変数名: created_at_lower_limit
pub const ENV_CREATED_AT_LOWER_LIMIT: &str = "RELAY_CREATED_AT_LOWER_LIMIT";

/// 環境変数名: created_at_upper_limit
pub const ENV_CREATED_AT_UPPER_LIMIT: &str = "RELAY_CREATED_AT_UPPER_LIMIT";

/// 環境変数名: default_limit
pub const ENV_DEFAULT_LIMIT: &str = "RELAY_DEFAULT_LIMIT";

// ===========================================
// LimitationConfig構造体
// ===========================================

/// 制限値設定（ドメイン層）
///
/// NIP-11で公開する全ての制限値を型安全に保持する。
/// アプリケーション起動時に一度だけ初期化される不変データ。
#[derive(Debug, Clone, PartialEq)]
pub struct LimitationConfig {
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

    /// limitが指定されない場合のデフォルト値
    pub default_limit: u32,
}

impl Default for LimitationConfig {
    /// デフォルト値で初期化
    ///
    /// 全ての制限値に仕様で定められたデフォルト値を設定する。
    fn default() -> Self {
        Self {
            max_message_length: DEFAULT_MAX_MESSAGE_LENGTH,
            max_subscriptions: DEFAULT_MAX_SUBSCRIPTIONS,
            max_limit: DEFAULT_MAX_LIMIT,
            max_event_tags: DEFAULT_MAX_EVENT_TAGS,
            max_content_length: DEFAULT_MAX_CONTENT_LENGTH,
            max_subid_length: DEFAULT_MAX_SUBID_LENGTH,
            created_at_lower_limit: DEFAULT_CREATED_AT_LOWER_LIMIT,
            created_at_upper_limit: DEFAULT_CREATED_AT_UPPER_LIMIT,
            default_limit: DEFAULT_DEFAULT_LIMIT,
        }
    }
}

impl LimitationConfig {
    /// 環境変数から設定を読み込み
    ///
    /// 各制限値は対応する環境変数から読み込まれる。
    /// 環境変数が未設定、またはパースエラーの場合はデフォルト値を使用する。
    /// max_subid_lengthは常に64固定（環境変数での変更不可）。
    ///
    /// # 環境変数
    /// - RELAY_MAX_MESSAGE_LENGTH: WebSocketメッセージの最大バイト数
    /// - RELAY_MAX_SUBSCRIPTIONS: 1接続あたりの最大サブスクリプション数
    /// - RELAY_MAX_LIMIT: フィルターlimitの最大値
    /// - RELAY_MAX_EVENT_TAGS: イベントの最大タグ数
    /// - RELAY_MAX_CONTENT_LENGTH: コンテンツの最大文字数
    /// - RELAY_CREATED_AT_LOWER_LIMIT: 過去のcreated_at許容範囲（秒）
    /// - RELAY_CREATED_AT_UPPER_LIMIT: 未来のcreated_at許容範囲（秒）
    /// - RELAY_DEFAULT_LIMIT: limitが指定されない場合のデフォルト値
    pub fn from_env() -> Self {
        let max_message_length =
            parse_env_u32(ENV_MAX_MESSAGE_LENGTH, DEFAULT_MAX_MESSAGE_LENGTH);
        let max_subscriptions =
            parse_env_u32(ENV_MAX_SUBSCRIPTIONS, DEFAULT_MAX_SUBSCRIPTIONS);
        let max_limit = parse_env_u32(ENV_MAX_LIMIT, DEFAULT_MAX_LIMIT);
        let max_event_tags = parse_env_u32(ENV_MAX_EVENT_TAGS, DEFAULT_MAX_EVENT_TAGS);
        let max_content_length =
            parse_env_u32(ENV_MAX_CONTENT_LENGTH, DEFAULT_MAX_CONTENT_LENGTH);
        let created_at_lower_limit =
            parse_env_u64(ENV_CREATED_AT_LOWER_LIMIT, DEFAULT_CREATED_AT_LOWER_LIMIT);
        let created_at_upper_limit =
            parse_env_u64(ENV_CREATED_AT_UPPER_LIMIT, DEFAULT_CREATED_AT_UPPER_LIMIT);
        let default_limit = parse_env_u32(ENV_DEFAULT_LIMIT, DEFAULT_DEFAULT_LIMIT);

        // max_subid_lengthは固定値（環境変数での変更不可）
        let max_subid_length = DEFAULT_MAX_SUBID_LENGTH;

        // 設定値をログ出力
        info!(
            max_message_length,
            max_subscriptions,
            max_limit,
            max_event_tags,
            max_content_length,
            max_subid_length,
            created_at_lower_limit,
            created_at_upper_limit,
            default_limit,
            "LimitationConfig loaded"
        );

        Self {
            max_message_length,
            max_subscriptions,
            max_limit,
            max_event_tags,
            max_content_length,
            max_subid_length,
            created_at_lower_limit,
            created_at_upper_limit,
            default_limit,
        }
    }
}

/// 環境変数からu32値を読み込む
///
/// 未設定またはパースエラーの場合はデフォルト値を返す。
fn parse_env_u32(key: &str, default: u32) -> u32 {
    match std::env::var(key) {
        Ok(value) => match value.parse::<u32>() {
            Ok(parsed) => {
                info!(key, value = parsed, "Environment variable loaded");
                parsed
            }
            Err(_) => {
                info!(
                    key,
                    value = %value,
                    default,
                    "Environment variable parse error, using default"
                );
                default
            }
        },
        Err(_) => default,
    }
}

/// 環境変数からu64値を読み込む
///
/// 未設定またはパースエラーの場合はデフォルト値を返す。
fn parse_env_u64(key: &str, default: u64) -> u64 {
    match std::env::var(key) {
        Ok(value) => match value.parse::<u64>() {
            Ok(parsed) => {
                info!(key, value = parsed, "Environment variable loaded");
                parsed
            }
            Err(_) => {
                info!(
                    key,
                    value = %value,
                    default,
                    "Environment variable parse error, using default"
                );
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

    // テストで環境変数を安全に設定/削除するヘルパー
    // 安全性: シングルスレッドテスト環境（#[serial]）で使用
    unsafe fn set_env(key: &str, value: &str) {
        unsafe { std::env::set_var(key, value) };
    }

    unsafe fn remove_env(key: &str) {
        unsafe { std::env::remove_var(key) };
    }

    // 環境変数クリーンアップ
    unsafe fn cleanup_limitation_env() {
        unsafe {
            remove_env(ENV_MAX_MESSAGE_LENGTH);
            remove_env(ENV_MAX_SUBSCRIPTIONS);
            remove_env(ENV_MAX_LIMIT);
            remove_env(ENV_MAX_EVENT_TAGS);
            remove_env(ENV_MAX_CONTENT_LENGTH);
            remove_env(ENV_CREATED_AT_LOWER_LIMIT);
            remove_env(ENV_CREATED_AT_UPPER_LIMIT);
            remove_env(ENV_DEFAULT_LIMIT);
        }
    }

    // ===========================================
    // Task 1.1: デフォルト値のテスト
    // ===========================================

    #[test]
    fn test_default_max_message_length() {
        // max_message_lengthのデフォルト値は131072 (128KB)
        let config = LimitationConfig::default();
        assert_eq!(config.max_message_length, 131072);
    }

    #[test]
    fn test_default_max_subscriptions() {
        // max_subscriptionsのデフォルト値は20
        let config = LimitationConfig::default();
        assert_eq!(config.max_subscriptions, 20);
    }

    #[test]
    fn test_default_max_limit() {
        // max_limitのデフォルト値は5000
        let config = LimitationConfig::default();
        assert_eq!(config.max_limit, 5000);
    }

    #[test]
    fn test_default_max_event_tags() {
        // max_event_tagsのデフォルト値は1000
        let config = LimitationConfig::default();
        assert_eq!(config.max_event_tags, 1000);
    }

    #[test]
    fn test_default_max_content_length() {
        // max_content_lengthのデフォルト値は65536 (64KB)
        let config = LimitationConfig::default();
        assert_eq!(config.max_content_length, 65536);
    }

    #[test]
    fn test_default_max_subid_length() {
        // max_subid_lengthのデフォルト値は64（NIP-01仕様）
        let config = LimitationConfig::default();
        assert_eq!(config.max_subid_length, 64);
    }

    #[test]
    fn test_default_created_at_lower_limit() {
        // created_at_lower_limitのデフォルト値は31536000（1年）
        let config = LimitationConfig::default();
        assert_eq!(config.created_at_lower_limit, 31536000);
    }

    #[test]
    fn test_default_created_at_upper_limit() {
        // created_at_upper_limitのデフォルト値は900（15分）
        let config = LimitationConfig::default();
        assert_eq!(config.created_at_upper_limit, 900);
    }

    #[test]
    fn test_default_default_limit() {
        // default_limitのデフォルト値は100
        let config = LimitationConfig::default();
        assert_eq!(config.default_limit, 100);
    }

    #[test]
    fn test_default_all_fields_have_expected_values() {
        // 全フィールドのデフォルト値を一括検証
        let config = LimitationConfig::default();

        assert_eq!(config.max_message_length, DEFAULT_MAX_MESSAGE_LENGTH);
        assert_eq!(config.max_subscriptions, DEFAULT_MAX_SUBSCRIPTIONS);
        assert_eq!(config.max_limit, DEFAULT_MAX_LIMIT);
        assert_eq!(config.max_event_tags, DEFAULT_MAX_EVENT_TAGS);
        assert_eq!(config.max_content_length, DEFAULT_MAX_CONTENT_LENGTH);
        assert_eq!(config.max_subid_length, DEFAULT_MAX_SUBID_LENGTH);
        assert_eq!(config.created_at_lower_limit, DEFAULT_CREATED_AT_LOWER_LIMIT);
        assert_eq!(config.created_at_upper_limit, DEFAULT_CREATED_AT_UPPER_LIMIT);
        assert_eq!(config.default_limit, DEFAULT_DEFAULT_LIMIT);
    }

    // ===========================================
    // Task 1.2: 環境変数からの読み込みテスト
    // ===========================================

    #[test]
    #[serial]
    fn test_from_env_with_no_env_vars_returns_defaults() {
        // 環境変数が設定されていない場合、デフォルト値が使用される
        unsafe { cleanup_limitation_env() };

        let config = LimitationConfig::from_env();

        assert_eq!(config.max_message_length, DEFAULT_MAX_MESSAGE_LENGTH);
        assert_eq!(config.max_subscriptions, DEFAULT_MAX_SUBSCRIPTIONS);
        assert_eq!(config.max_limit, DEFAULT_MAX_LIMIT);
        assert_eq!(config.max_event_tags, DEFAULT_MAX_EVENT_TAGS);
        assert_eq!(config.max_content_length, DEFAULT_MAX_CONTENT_LENGTH);
        assert_eq!(config.max_subid_length, DEFAULT_MAX_SUBID_LENGTH);
        assert_eq!(config.created_at_lower_limit, DEFAULT_CREATED_AT_LOWER_LIMIT);
        assert_eq!(config.created_at_upper_limit, DEFAULT_CREATED_AT_UPPER_LIMIT);
        assert_eq!(config.default_limit, DEFAULT_DEFAULT_LIMIT);
    }

    #[test]
    #[serial]
    fn test_from_env_reads_max_message_length() {
        // RELAY_MAX_MESSAGE_LENGTHから読み込み
        unsafe {
            cleanup_limitation_env();
            set_env(ENV_MAX_MESSAGE_LENGTH, "262144");
        }

        let config = LimitationConfig::from_env();

        assert_eq!(config.max_message_length, 262144);

        unsafe { cleanup_limitation_env() };
    }

    #[test]
    #[serial]
    fn test_from_env_reads_max_subscriptions() {
        // RELAY_MAX_SUBSCRIPTIONSから読み込み
        unsafe {
            cleanup_limitation_env();
            set_env(ENV_MAX_SUBSCRIPTIONS, "50");
        }

        let config = LimitationConfig::from_env();

        assert_eq!(config.max_subscriptions, 50);

        unsafe { cleanup_limitation_env() };
    }

    #[test]
    #[serial]
    fn test_from_env_reads_max_limit() {
        // RELAY_MAX_LIMITから読み込み
        unsafe {
            cleanup_limitation_env();
            set_env(ENV_MAX_LIMIT, "10000");
        }

        let config = LimitationConfig::from_env();

        assert_eq!(config.max_limit, 10000);

        unsafe { cleanup_limitation_env() };
    }

    #[test]
    #[serial]
    fn test_from_env_reads_max_event_tags() {
        // RELAY_MAX_EVENT_TAGSから読み込み
        unsafe {
            cleanup_limitation_env();
            set_env(ENV_MAX_EVENT_TAGS, "2000");
        }

        let config = LimitationConfig::from_env();

        assert_eq!(config.max_event_tags, 2000);

        unsafe { cleanup_limitation_env() };
    }

    #[test]
    #[serial]
    fn test_from_env_reads_max_content_length() {
        // RELAY_MAX_CONTENT_LENGTHから読み込み
        unsafe {
            cleanup_limitation_env();
            set_env(ENV_MAX_CONTENT_LENGTH, "131072");
        }

        let config = LimitationConfig::from_env();

        assert_eq!(config.max_content_length, 131072);

        unsafe { cleanup_limitation_env() };
    }

    #[test]
    #[serial]
    fn test_from_env_reads_created_at_lower_limit() {
        // RELAY_CREATED_AT_LOWER_LIMITから読み込み
        unsafe {
            cleanup_limitation_env();
            set_env(ENV_CREATED_AT_LOWER_LIMIT, "63072000");
        }

        let config = LimitationConfig::from_env();

        assert_eq!(config.created_at_lower_limit, 63072000);

        unsafe { cleanup_limitation_env() };
    }

    #[test]
    #[serial]
    fn test_from_env_reads_created_at_upper_limit() {
        // RELAY_CREATED_AT_UPPER_LIMITから読み込み
        unsafe {
            cleanup_limitation_env();
            set_env(ENV_CREATED_AT_UPPER_LIMIT, "1800");
        }

        let config = LimitationConfig::from_env();

        assert_eq!(config.created_at_upper_limit, 1800);

        unsafe { cleanup_limitation_env() };
    }

    #[test]
    #[serial]
    fn test_from_env_reads_default_limit() {
        // RELAY_DEFAULT_LIMITから読み込み
        unsafe {
            cleanup_limitation_env();
            set_env(ENV_DEFAULT_LIMIT, "200");
        }

        let config = LimitationConfig::from_env();

        assert_eq!(config.default_limit, 200);

        unsafe { cleanup_limitation_env() };
    }

    #[test]
    #[serial]
    fn test_from_env_reads_all_env_vars() {
        // 全ての環境変数を設定して読み込み
        unsafe {
            cleanup_limitation_env();
            set_env(ENV_MAX_MESSAGE_LENGTH, "262144");
            set_env(ENV_MAX_SUBSCRIPTIONS, "50");
            set_env(ENV_MAX_LIMIT, "10000");
            set_env(ENV_MAX_EVENT_TAGS, "2000");
            set_env(ENV_MAX_CONTENT_LENGTH, "131072");
            set_env(ENV_CREATED_AT_LOWER_LIMIT, "63072000");
            set_env(ENV_CREATED_AT_UPPER_LIMIT, "1800");
            set_env(ENV_DEFAULT_LIMIT, "200");
        }

        let config = LimitationConfig::from_env();

        assert_eq!(config.max_message_length, 262144);
        assert_eq!(config.max_subscriptions, 50);
        assert_eq!(config.max_limit, 10000);
        assert_eq!(config.max_event_tags, 2000);
        assert_eq!(config.max_content_length, 131072);
        assert_eq!(config.max_subid_length, 64); // 常に固定値
        assert_eq!(config.created_at_lower_limit, 63072000);
        assert_eq!(config.created_at_upper_limit, 1800);
        assert_eq!(config.default_limit, 200);

        unsafe { cleanup_limitation_env() };
    }

    #[test]
    #[serial]
    fn test_from_env_max_subid_length_is_always_fixed() {
        // max_subid_lengthは環境変数に関係なく常に64
        // （環境変数での変更不可）
        unsafe { cleanup_limitation_env() };

        let config = LimitationConfig::from_env();

        assert_eq!(config.max_subid_length, 64);
    }

    #[test]
    #[serial]
    fn test_from_env_falls_back_on_parse_error() {
        // パースエラー時はデフォルト値にフォールバック
        unsafe {
            cleanup_limitation_env();
            set_env(ENV_MAX_MESSAGE_LENGTH, "not_a_number");
            set_env(ENV_MAX_SUBSCRIPTIONS, "invalid");
            set_env(ENV_CREATED_AT_LOWER_LIMIT, "abc");
        }

        let config = LimitationConfig::from_env();

        // パースエラーの場合はデフォルト値が使用される
        assert_eq!(config.max_message_length, DEFAULT_MAX_MESSAGE_LENGTH);
        assert_eq!(config.max_subscriptions, DEFAULT_MAX_SUBSCRIPTIONS);
        assert_eq!(config.created_at_lower_limit, DEFAULT_CREATED_AT_LOWER_LIMIT);

        unsafe { cleanup_limitation_env() };
    }

    #[test]
    #[serial]
    fn test_from_env_falls_back_on_negative_values() {
        // 負の値はu32/u64のパースでエラーになりデフォルト値にフォールバック
        unsafe {
            cleanup_limitation_env();
            set_env(ENV_MAX_MESSAGE_LENGTH, "-100");
            set_env(ENV_MAX_SUBSCRIPTIONS, "-1");
        }

        let config = LimitationConfig::from_env();

        assert_eq!(config.max_message_length, DEFAULT_MAX_MESSAGE_LENGTH);
        assert_eq!(config.max_subscriptions, DEFAULT_MAX_SUBSCRIPTIONS);

        unsafe { cleanup_limitation_env() };
    }

    #[test]
    #[serial]
    fn test_from_env_accepts_zero_values() {
        // 0は有効な値として受け入れる
        unsafe {
            cleanup_limitation_env();
            set_env(ENV_MAX_SUBSCRIPTIONS, "0");
            set_env(ENV_MAX_EVENT_TAGS, "0");
        }

        let config = LimitationConfig::from_env();

        assert_eq!(config.max_subscriptions, 0);
        assert_eq!(config.max_event_tags, 0);

        unsafe { cleanup_limitation_env() };
    }

    #[test]
    #[serial]
    fn test_from_env_partial_env_vars_set() {
        // 一部の環境変数のみ設定されている場合
        unsafe {
            cleanup_limitation_env();
            set_env(ENV_MAX_SUBSCRIPTIONS, "30");
            set_env(ENV_DEFAULT_LIMIT, "150");
        }

        let config = LimitationConfig::from_env();

        // 設定された環境変数は読み込まれる
        assert_eq!(config.max_subscriptions, 30);
        assert_eq!(config.default_limit, 150);

        // 未設定の環境変数はデフォルト値
        assert_eq!(config.max_message_length, DEFAULT_MAX_MESSAGE_LENGTH);
        assert_eq!(config.max_limit, DEFAULT_MAX_LIMIT);
        assert_eq!(config.max_event_tags, DEFAULT_MAX_EVENT_TAGS);
        assert_eq!(config.max_content_length, DEFAULT_MAX_CONTENT_LENGTH);
        assert_eq!(config.created_at_lower_limit, DEFAULT_CREATED_AT_LOWER_LIMIT);
        assert_eq!(config.created_at_upper_limit, DEFAULT_CREATED_AT_UPPER_LIMIT);

        unsafe { cleanup_limitation_env() };
    }

    #[test]
    #[serial]
    fn test_from_env_with_empty_string() {
        // 空文字列はパースエラーとしてデフォルト値にフォールバック
        unsafe {
            cleanup_limitation_env();
            set_env(ENV_MAX_MESSAGE_LENGTH, "");
        }

        let config = LimitationConfig::from_env();

        assert_eq!(config.max_message_length, DEFAULT_MAX_MESSAGE_LENGTH);

        unsafe { cleanup_limitation_env() };
    }

    #[test]
    #[serial]
    fn test_from_env_with_whitespace_only() {
        // 空白のみはパースエラーとしてデフォルト値にフォールバック
        unsafe {
            cleanup_limitation_env();
            set_env(ENV_MAX_MESSAGE_LENGTH, "   ");
        }

        let config = LimitationConfig::from_env();

        assert_eq!(config.max_message_length, DEFAULT_MAX_MESSAGE_LENGTH);

        unsafe { cleanup_limitation_env() };
    }

    #[test]
    #[serial]
    fn test_from_env_with_overflow_value() {
        // u32の範囲を超える値はパースエラーとしてデフォルト値にフォールバック
        unsafe {
            cleanup_limitation_env();
            set_env(ENV_MAX_MESSAGE_LENGTH, "9999999999999999999");
        }

        let config = LimitationConfig::from_env();

        assert_eq!(config.max_message_length, DEFAULT_MAX_MESSAGE_LENGTH);

        unsafe { cleanup_limitation_env() };
    }

    // ===========================================
    // 構造体の特性テスト
    // ===========================================

    #[test]
    fn test_limitation_config_is_clone() {
        // LimitationConfigはCloneできる
        let config = LimitationConfig::default();
        let cloned = config.clone();

        assert_eq!(config, cloned);
    }

    #[test]
    fn test_limitation_config_is_debug() {
        // LimitationConfigはDebugできる
        let config = LimitationConfig::default();
        let debug_str = format!("{:?}", config);

        assert!(debug_str.contains("LimitationConfig"));
        assert!(debug_str.contains("max_message_length"));
    }

    #[test]
    fn test_limitation_config_equality() {
        // LimitationConfigは等値比較できる
        let config1 = LimitationConfig::default();
        let config2 = LimitationConfig::default();

        assert_eq!(config1, config2);
    }

    #[test]
    fn test_limitation_config_inequality() {
        // 異なる値を持つLimitationConfigは不等
        let config1 = LimitationConfig::default();
        let config2 = LimitationConfig {
            max_subscriptions: 100,
            ..LimitationConfig::default()
        };

        assert_ne!(config1, config2);
    }
}
