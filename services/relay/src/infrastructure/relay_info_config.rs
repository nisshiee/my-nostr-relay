// NIP-11リレー情報設定
//
// 環境変数からNIP-11レスポンスに必要な設定値を読み込み、
// 型安全に提供するインフラストラクチャ層コンポーネント。

/// リレー情報設定
///
/// NIP-11レスポンスに含める情報を環境変数から読み込む。
/// 未設定のオプションフィールドは`None`として扱う。
#[derive(Debug, Clone)]
pub struct RelayInfoConfig {
    // 基本フィールド (要件 2.1-2.9, 5.1-5.7)
    /// リレー名 (RELAY_NAME環境変数)
    pub name: Option<String>,
    /// リレー説明 (RELAY_DESCRIPTION環境変数)
    pub description: Option<String>,
    /// 管理者公開鍵 (RELAY_PUBKEY環境変数、64文字hex)
    pub pubkey: Option<String>,
    /// 連絡先URI (RELAY_CONTACT環境変数)
    pub contact: Option<String>,
    /// アイコンURL (RELAY_ICON環境変数)
    pub icon: Option<String>,
    /// バナーURL (RELAY_BANNER環境変数)
    pub banner: Option<String>,

    // コミュニティ・ロケール (要件 7.1-7.5)
    /// 国コード配列 (RELAY_COUNTRIES環境変数、カンマ区切り)
    pub relay_countries: Vec<String>,
    /// 言語タグ配列 (RELAY_LANGUAGE_TAGS環境変数、カンマ区切り)
    pub language_tags: Vec<String>,
}

impl RelayInfoConfig {
    /// 環境変数から設定を読み込み
    ///
    /// 各フィールドは対応する環境変数から読み込まれる:
    /// - RELAY_NAME: リレー名
    /// - RELAY_DESCRIPTION: リレー説明
    /// - RELAY_PUBKEY: 管理者公開鍵（64文字hex、無効な場合は無視）
    /// - RELAY_CONTACT: 連絡先URI
    /// - RELAY_ICON: アイコンURL
    /// - RELAY_BANNER: バナーURL
    /// - RELAY_COUNTRIES: 国コード（カンマ区切り、デフォルト: なし）
    /// - RELAY_LANGUAGE_TAGS: 言語タグ（カンマ区切り、デフォルト: なし）
    pub fn from_env() -> Self {
        // 文字列オプションを読み込むヘルパー（空文字はNone扱い）
        let get_optional_string = |key: &str| -> Option<String> {
            std::env::var(key).ok().filter(|s| !s.trim().is_empty())
        };

        // 基本フィールドの読み込み
        let name = get_optional_string("RELAY_NAME");
        let description = get_optional_string("RELAY_DESCRIPTION");
        let contact = get_optional_string("RELAY_CONTACT");
        let icon = get_optional_string("RELAY_ICON");
        let banner = get_optional_string("RELAY_BANNER");

        // pubkeyは検証付きで読み込み（無効な場合はNone）
        let pubkey = get_optional_string("RELAY_PUBKEY").filter(|p| is_valid_pubkey(p));

        // ロケールフィールドの読み込み（カンマ区切り）
        let relay_countries = std::env::var("RELAY_COUNTRIES")
            .map(|v| parse_comma_separated(&v))
            .unwrap_or_default();

        let language_tags = std::env::var("RELAY_LANGUAGE_TAGS")
            .map(|v| parse_comma_separated(&v))
            .unwrap_or_default();

        Self {
            name,
            description,
            pubkey,
            contact,
            icon,
            banner,
            relay_countries,
            language_tags,
        }
    }

    /// テスト用に明示的な値で作成
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
        Self {
            name,
            description,
            pubkey,
            contact,
            icon,
            banner,
            relay_countries,
            language_tags,
        }
    }
}

/// pubkeyが有効な64文字hex文字列かどうかを検証
///
/// Nostr公開鍵は32バイト（64文字のhex）である必要がある。
///
/// # Arguments
/// * `pubkey` - 検証する公開鍵文字列
///
/// # Returns
/// 有効な場合は`true`、無効な場合は`false`
pub fn is_valid_pubkey(pubkey: &str) -> bool {
    // 64文字であることを確認
    if pubkey.len() != 64 {
        return false;
    }

    // すべての文字がhex文字（0-9, a-f, A-F）であることを確認
    pubkey.chars().all(|c| c.is_ascii_hexdigit())
}

/// カンマ区切り文字列をパースしてVecに変換
///
/// 空白をトリムし、空文字列は除外する。
///
/// # Arguments
/// * `value` - カンマ区切りの文字列
///
/// # Returns
/// パースされた文字列のベクター
pub fn parse_comma_separated(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // テストで環境変数を安全に設定/削除するヘルパー
    // 安全性: シングルスレッドテスト環境で使用
    unsafe fn set_env(key: &str, value: &str) {
        unsafe { std::env::set_var(key, value) };
    }

    unsafe fn remove_env(key: &str) {
        unsafe { std::env::remove_var(key) };
    }

    // ===========================================
    // Task 2.1: 環境変数からの基本設定読み込みテスト
    // ===========================================

    #[test]
    fn test_relay_info_config_new() {
        // new()で明示的に値を設定できる
        let config = RelayInfoConfig::new(
            Some("Test Relay".to_string()),
            Some("A test relay".to_string()),
            Some("a".repeat(64)),
            Some("mailto:test@example.com".to_string()),
            Some("https://example.com/icon.png".to_string()),
            Some("https://example.com/banner.png".to_string()),
            vec!["JP".to_string()],
            vec!["ja".to_string()],
        );

        assert_eq!(config.name, Some("Test Relay".to_string()));
        assert_eq!(config.description, Some("A test relay".to_string()));
        assert_eq!(config.pubkey, Some("a".repeat(64)));
        assert_eq!(config.contact, Some("mailto:test@example.com".to_string()));
        assert_eq!(config.icon, Some("https://example.com/icon.png".to_string()));
        assert_eq!(config.banner, Some("https://example.com/banner.png".to_string()));
        assert_eq!(config.relay_countries, vec!["JP"]);
        assert_eq!(config.language_tags, vec!["ja"]);
    }

    #[test]
    fn test_relay_info_config_new_with_none_values() {
        // 未設定のフィールドはNoneになる
        let config = RelayInfoConfig::new(
            None,
            None,
            None,
            None,
            None,
            None,
            vec![],
            vec![],
        );

        assert!(config.name.is_none());
        assert!(config.description.is_none());
        assert!(config.pubkey.is_none());
        assert!(config.contact.is_none());
        assert!(config.icon.is_none());
        assert!(config.banner.is_none());
        assert!(config.relay_countries.is_empty());
        assert!(config.language_tags.is_empty());
    }

    #[test]
    fn test_is_valid_pubkey_with_valid_hex() {
        // 64文字の有効なhex文字列
        assert!(is_valid_pubkey(&"a".repeat(64)));
        assert!(is_valid_pubkey(&"0123456789abcdef".repeat(4)));
        assert!(is_valid_pubkey(&("ABCDEF".repeat(10) + "1234")));
    }

    #[test]
    fn test_is_valid_pubkey_with_invalid_length() {
        // 長さが64でない場合は無効
        assert!(!is_valid_pubkey(&"a".repeat(63)));
        assert!(!is_valid_pubkey(&"a".repeat(65)));
        assert!(!is_valid_pubkey(""));
        assert!(!is_valid_pubkey("short"));
    }

    #[test]
    fn test_is_valid_pubkey_with_invalid_chars() {
        // hex以外の文字が含まれる場合は無効
        assert!(!is_valid_pubkey(&("g".repeat(64)))); // 'g'はhexではない
        assert!(!is_valid_pubkey(&("!".repeat(64)))); // 特殊文字
        assert!(!is_valid_pubkey(&(" ".repeat(64)))); // 空白
    }

    #[test]
    fn test_from_env_reads_basic_fields() {
        // テスト用環境変数を使用したfrom_envの動作確認
        // 実際のfrom_envは本番環境変数を読むため、ここでは
        // new()を使用したユニットテストに限定

        // このテストは実装後に環境変数テスト用に拡張可能
        // 現時点ではnew()の動作を確認
        let config = RelayInfoConfig::new(
            Some("My Relay".to_string()),
            Some("Description".to_string()),
            Some("b".repeat(64)),
            Some("https://example.com".to_string()),
            Some("https://example.com/icon.png".to_string()),
            Some("https://example.com/banner.png".to_string()),
            vec!["JP".to_string()],
            vec!["ja".to_string()],
        );

        assert_eq!(config.name.as_deref(), Some("My Relay"));
        assert_eq!(config.description.as_deref(), Some("Description"));
        assert_eq!(config.pubkey.as_deref(), Some("b".repeat(64).as_str()));
    }

    #[test]
    fn test_from_env_with_invalid_pubkey_returns_none() {
        // 無効なpubkeyが設定されている場合、pubkeyはNoneになるべき
        // （環境変数設定エラーでサービスを止めない方針）

        // このロジックはfrom_env実装時にテスト
        // ここではis_valid_pubkeyの結果に基づく動作を確認
        let invalid_pubkey = "invalid";
        assert!(!is_valid_pubkey(invalid_pubkey));
    }

    // ===========================================
    // Task 2.2: ロケール設定の環境変数読み込みテスト
    // ===========================================

    #[test]
    fn test_parse_comma_separated_basic() {
        // 基本的なカンマ区切りパース
        let result = parse_comma_separated("JP,US");
        assert_eq!(result, vec!["JP", "US"]);
    }

    #[test]
    fn test_parse_comma_separated_with_spaces() {
        // 空白を含むカンマ区切りパース（トリムされるべき）
        let result = parse_comma_separated("JP , US , EU");
        assert_eq!(result, vec!["JP", "US", "EU"]);
    }

    #[test]
    fn test_parse_comma_separated_single_value() {
        // 単一値のパース
        let result = parse_comma_separated("JP");
        assert_eq!(result, vec!["JP"]);
    }

    #[test]
    fn test_parse_comma_separated_empty_string() {
        // 空文字列のパース
        let result = parse_comma_separated("");
        assert!(result.is_empty());
    }

    #[test]
    fn test_parse_comma_separated_with_empty_elements() {
        // 空要素を含むカンマ区切り（空要素は除外されるべき）
        let result = parse_comma_separated("JP,,US,");
        assert_eq!(result, vec!["JP", "US"]);
    }

    #[test]
    fn test_parse_comma_separated_whitespace_only() {
        // 空白のみの文字列
        let result = parse_comma_separated("   ");
        assert!(result.is_empty());
    }

    #[test]
    fn test_parse_comma_separated_language_tags() {
        // 言語タグのパース
        let result = parse_comma_separated("ja,en,zh-CN");
        assert_eq!(result, vec!["ja", "en", "zh-CN"]);
    }

    #[test]
    fn test_relay_info_config_default_locale_values() {
        // デフォルト値なしで作成した場合、空配列になる
        let config = RelayInfoConfig::new(
            None, None, None, None, None, None,
            vec![],
            vec![],
        );

        assert!(config.relay_countries.is_empty());
        assert!(config.language_tags.is_empty());
    }

    #[test]
    fn test_relay_info_config_with_multiple_countries() {
        // 複数国コードの設定
        let config = RelayInfoConfig::new(
            None, None, None, None, None, None,
            vec!["JP".to_string(), "US".to_string(), "DE".to_string()],
            vec![],
        );

        assert_eq!(config.relay_countries.len(), 3);
        assert!(config.relay_countries.contains(&"JP".to_string()));
        assert!(config.relay_countries.contains(&"US".to_string()));
        assert!(config.relay_countries.contains(&"DE".to_string()));
    }

    #[test]
    fn test_relay_info_config_with_multiple_language_tags() {
        // 複数言語タグの設定
        let config = RelayInfoConfig::new(
            None, None, None, None, None, None,
            vec![],
            vec!["ja".to_string(), "en".to_string(), "zh-CN".to_string()],
        );

        assert_eq!(config.language_tags.len(), 3);
        assert!(config.language_tags.contains(&"ja".to_string()));
        assert!(config.language_tags.contains(&"en".to_string()));
        assert!(config.language_tags.contains(&"zh-CN".to_string()));
    }

    // ===========================================
    // from_env統合テスト（環境変数を使用）
    // ===========================================

    // 注: これらのテストは環境変数を操作するため、
    // cargo test --test-threads=1 で実行することを推奨

    // from_env用の環境変数をクリーンアップ
    unsafe fn cleanup_relay_env() {
        unsafe {
            remove_env("RELAY_NAME");
            remove_env("RELAY_DESCRIPTION");
            remove_env("RELAY_PUBKEY");
            remove_env("RELAY_CONTACT");
            remove_env("RELAY_ICON");
            remove_env("RELAY_BANNER");
            remove_env("RELAY_COUNTRIES");
            remove_env("RELAY_LANGUAGE_TAGS");
        }
    }

    #[test]
    fn test_from_env_with_all_fields_set() {
        // すべての環境変数が設定されている場合のfrom_envテスト
        let valid_pubkey = "a".repeat(64);

        // 安全性: テスト環境で環境変数を設定
        unsafe {
            cleanup_relay_env();
            set_env("RELAY_NAME", "Test Relay");
            set_env("RELAY_DESCRIPTION", "A test relay description");
            set_env("RELAY_PUBKEY", &valid_pubkey);
            set_env("RELAY_CONTACT", "mailto:test@example.com");
            set_env("RELAY_ICON", "https://example.com/icon.png");
            set_env("RELAY_BANNER", "https://example.com/banner.png");
            set_env("RELAY_COUNTRIES", "JP,US");
            set_env("RELAY_LANGUAGE_TAGS", "ja,en");
        }

        let config = RelayInfoConfig::from_env();

        assert_eq!(config.name.as_deref(), Some("Test Relay"));
        assert_eq!(config.description.as_deref(), Some("A test relay description"));
        assert_eq!(config.pubkey.as_deref(), Some(valid_pubkey.as_str()));
        assert_eq!(config.contact.as_deref(), Some("mailto:test@example.com"));
        assert_eq!(config.icon.as_deref(), Some("https://example.com/icon.png"));
        assert_eq!(config.banner.as_deref(), Some("https://example.com/banner.png"));
        assert_eq!(config.relay_countries, vec!["JP", "US"]);
        assert_eq!(config.language_tags, vec!["ja", "en"]);

        // クリーンアップ
        unsafe { cleanup_relay_env(); }
    }

    #[test]
    fn test_from_env_with_no_fields_set() {
        // 環境変数が設定されていない場合
        unsafe { cleanup_relay_env(); }

        let config = RelayInfoConfig::from_env();

        assert!(config.name.is_none());
        assert!(config.description.is_none());
        assert!(config.pubkey.is_none());
        assert!(config.contact.is_none());
        assert!(config.icon.is_none());
        assert!(config.banner.is_none());
        assert!(config.relay_countries.is_empty());
        assert!(config.language_tags.is_empty());
    }

    #[test]
    fn test_from_env_with_invalid_pubkey() {
        // 無効なpubkeyはNoneになる
        unsafe {
            cleanup_relay_env();
            set_env("RELAY_NAME", "Test");
            set_env("RELAY_PUBKEY", "invalid_pubkey_too_short");
        }

        let config = RelayInfoConfig::from_env();

        assert_eq!(config.name.as_deref(), Some("Test"));
        assert!(config.pubkey.is_none()); // 無効なpubkeyはNone

        unsafe { cleanup_relay_env(); }
    }

    #[test]
    fn test_from_env_with_empty_string_values() {
        // 空文字列はNone扱いになる
        unsafe {
            cleanup_relay_env();
            set_env("RELAY_NAME", "");
            set_env("RELAY_DESCRIPTION", "   "); // 空白のみも空扱い
        }

        let config = RelayInfoConfig::from_env();

        assert!(config.name.is_none());
        assert!(config.description.is_none());

        unsafe { cleanup_relay_env(); }
    }

    #[test]
    fn test_from_env_parses_comma_separated_countries() {
        // カンマ区切りの国コードパース
        unsafe {
            cleanup_relay_env();
            set_env("RELAY_COUNTRIES", "JP, US, DE"); // 空白を含む
        }

        let config = RelayInfoConfig::from_env();

        assert_eq!(config.relay_countries, vec!["JP", "US", "DE"]);

        unsafe { cleanup_relay_env(); }
    }

    #[test]
    fn test_from_env_parses_comma_separated_language_tags() {
        // カンマ区切りの言語タグパース
        unsafe {
            cleanup_relay_env();
            set_env("RELAY_LANGUAGE_TAGS", "ja,en,zh-CN");
        }

        let config = RelayInfoConfig::from_env();

        assert_eq!(config.language_tags, vec!["ja", "en", "zh-CN"]);

        unsafe { cleanup_relay_env(); }
    }

    #[test]
    fn test_from_env_with_pubkey_non_hex_chars() {
        // 非hexの文字を含むpubkeyはNoneになる
        unsafe {
            cleanup_relay_env();
            set_env("RELAY_PUBKEY", &"g".repeat(64)); // 'g'はhexではない
        }

        let config = RelayInfoConfig::from_env();

        assert!(config.pubkey.is_none());

        unsafe { cleanup_relay_env(); }
    }

    #[test]
    fn test_from_env_with_valid_uppercase_hex_pubkey() {
        // 大文字hexも有効なpubkey
        let valid_pubkey = "ABCDEF0123456789".repeat(4);
        unsafe {
            cleanup_relay_env();
            set_env("RELAY_PUBKEY", &valid_pubkey);
        }

        let config = RelayInfoConfig::from_env();

        assert_eq!(config.pubkey.as_deref(), Some(valid_pubkey.as_str()));

        unsafe { cleanup_relay_env(); }
    }
}
