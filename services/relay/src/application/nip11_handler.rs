// NIP-11レスポンス生成ハンドラー
//
// 設定コンポーネントからリレー情報を取得し、
// NIP-11仕様に準拠したJSONレスポンスを構築する。
// 要件: 1.1, 1.3, 2.1-2.9, 3.1-3.3, 4.1-4.3, 7.1, 7.2

use crate::domain::RelayInfoDocument;
use crate::infrastructure::RelayInfoConfig;
use lambda_http::http::header::{
    HeaderMap, HeaderValue, ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS,
    ACCESS_CONTROL_ALLOW_ORIGIN, CONTENT_TYPE,
};
use lambda_http::{Body, Response};

/// NIP-11レスポンス生成ハンドラー
///
/// 設定コンポーネントからリレー情報を取得し、
/// NIP-11仕様に準拠したRelayInfoDocumentを生成する。
pub struct Nip11Handler {
    /// リレー情報設定
    config: RelayInfoConfig,
}

impl Nip11Handler {
    /// 新しいハンドラーを作成
    ///
    /// # Arguments
    /// * `config` - リレー情報設定
    pub fn new(config: RelayInfoConfig) -> Self {
        Self { config }
    }

    /// リレー情報ドキュメントを生成
    ///
    /// 設定コンポーネントの値を使用して、NIP-11仕様に準拠した
    /// RelayInfoDocumentを構築する。
    ///
    /// # Returns
    /// NIP-11準拠のリレー情報ドキュメント
    pub fn build_relay_info(&self) -> RelayInfoDocument {
        RelayInfoDocument::new(
            self.config.name.clone(),
            self.config.description.clone(),
            self.config.pubkey.clone(),
            self.config.contact.clone(),
            self.config.icon.clone(),
            self.config.banner.clone(),
            self.config.relay_countries.clone(),
            self.config.language_tags.clone(),
        )
    }

    /// リレー情報をJSONとしてシリアライズ
    ///
    /// # Returns
    /// NIP-11準拠のJSON文字列
    pub fn build_relay_info_json(&self) -> String {
        let doc = self.build_relay_info();
        serde_json::to_string(&doc).expect("RelayInfoDocumentのシリアライズに失敗")
    }

    /// GETリクエストを処理してレスポンスを生成
    ///
    /// NIP-11仕様に準拠したJSONレスポンスとCORSヘッダーを含む
    /// HTTPレスポンスを返す。
    ///
    /// # Returns
    /// CORSヘッダー付きのHTTP 200レスポンス
    pub fn handle(&self) -> Response<Body> {
        let json = self.build_relay_info_json();
        let headers = Self::build_cors_headers();

        let mut response = Response::builder()
            .status(200)
            .body(Body::Text(json))
            .expect("レスポンスの構築に失敗");

        // ヘッダーを設定
        *response.headers_mut() = headers;

        response
    }

    /// CORSヘッダーを生成
    ///
    /// NIP-11レスポンスに必要なCORSヘッダーを含むHeaderMapを返す:
    /// - Content-Type: application/nostr+json
    /// - Access-Control-Allow-Origin: *
    /// - Access-Control-Allow-Headers: Accept
    /// - Access-Control-Allow-Methods: GET, OPTIONS
    ///
    /// # Returns
    /// CORSヘッダーを含むHeaderMap
    pub fn build_cors_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();

        // Content-Type: application/nostr+json
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_static("application/nostr+json"),
        );

        // Access-Control-Allow-Origin: *
        headers.insert(
            ACCESS_CONTROL_ALLOW_ORIGIN,
            HeaderValue::from_static("*"),
        );

        // Access-Control-Allow-Headers: Accept
        headers.insert(
            ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("Accept"),
        );

        // Access-Control-Allow-Methods: GET, OPTIONS
        headers.insert(
            ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, OPTIONS"),
        );

        headers
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{SOFTWARE_URL, SUPPORTED_NIPS};
    use lambda_http::Body;

    // ===========================================
    // Task 3.1: NIP-11レスポンス生成ハンドラーのテスト
    // ===========================================

    /// ハンドラーが設定から正しくRelayInfoDocumentを生成する
    #[test]
    fn test_build_relay_info_with_full_config() {
        // 全フィールドを設定した設定オブジェクトを作成
        let config = RelayInfoConfig::new(
            Some("Test Relay".to_string()),
            Some("A test relay description".to_string()),
            Some("a".repeat(64)),
            Some("mailto:admin@example.com".to_string()),
            Some("https://example.com/icon.png".to_string()),
            Some("https://example.com/banner.png".to_string()),
            vec!["JP".to_string(), "US".to_string()],
            vec!["ja".to_string(), "en".to_string()],
        );

        let handler = Nip11Handler::new(config);
        let doc = handler.build_relay_info();

        // 設定からの値が正しく反映されていることを検証
        assert_eq!(doc.name, Some("Test Relay".to_string()));
        assert_eq!(doc.description, Some("A test relay description".to_string()));
        assert_eq!(doc.pubkey, Some("a".repeat(64)));
        assert_eq!(doc.contact, Some("mailto:admin@example.com".to_string()));
        assert_eq!(doc.icon, Some("https://example.com/icon.png".to_string()));
        assert_eq!(doc.banner, Some("https://example.com/banner.png".to_string()));
        assert_eq!(doc.relay_countries, vec!["JP", "US"]);
        assert_eq!(doc.language_tags, vec!["ja", "en"]);
    }

    /// ハンドラーが空の設定から正しくドキュメントを生成する
    #[test]
    fn test_build_relay_info_with_empty_config() {
        let config = RelayInfoConfig::new(
            None, None, None, None, None, None, vec![], vec![],
        );

        let handler = Nip11Handler::new(config);
        let doc = handler.build_relay_info();

        // オプショナルフィールドはNone
        assert!(doc.name.is_none());
        assert!(doc.description.is_none());
        assert!(doc.pubkey.is_none());
        assert!(doc.contact.is_none());
        assert!(doc.icon.is_none());
        assert!(doc.banner.is_none());
        assert!(doc.relay_countries.is_empty());
        assert!(doc.language_tags.is_empty());
    }

    /// supported_nipsに現在実装済みのNIP番号（1, 11）が含まれる
    #[test]
    fn test_build_relay_info_includes_supported_nips() {
        let config = RelayInfoConfig::new(
            None, None, None, None, None, None, vec![], vec![],
        );

        let handler = Nip11Handler::new(config);
        let doc = handler.build_relay_info();

        // NIP-1とNIP-11がサポートされていることを確認
        assert!(doc.supported_nips.contains(&1));
        assert!(doc.supported_nips.contains(&11));
        assert_eq!(doc.supported_nips, SUPPORTED_NIPS.to_vec());
    }

    /// softwareURLがコンパイル時定数から正しく取得される
    #[test]
    fn test_build_relay_info_software_url() {
        let config = RelayInfoConfig::new(
            None, None, None, None, None, None, vec![], vec![],
        );

        let handler = Nip11Handler::new(config);
        let doc = handler.build_relay_info();

        assert_eq!(doc.software, SOFTWARE_URL);
        assert_eq!(doc.software, "https://github.com/nisshiee/my-nostr-relay");
    }

    /// versionがCargo.tomlから正しく取得される
    #[test]
    fn test_build_relay_info_version() {
        let config = RelayInfoConfig::new(
            None, None, None, None, None, None, vec![], vec![],
        );

        let handler = Nip11Handler::new(config);
        let doc = handler.build_relay_info();

        // Cargo.tomlのバージョンと一致することを確認
        assert_eq!(doc.version, env!("CARGO_PKG_VERSION"));
    }

    /// 制限情報（limitation）が正しく設定される
    #[test]
    fn test_build_relay_info_limitation() {
        let config = RelayInfoConfig::new(
            None, None, None, None, None, None, vec![], vec![],
        );

        let handler = Nip11Handler::new(config);
        let doc = handler.build_relay_info();

        // max_subid_lengthは64固定
        assert_eq!(doc.limitation.max_subid_length, 64);
    }

    /// build_relay_info_jsonが有効なJSONを返す
    #[test]
    fn test_build_relay_info_json_valid() {
        let config = RelayInfoConfig::new(
            Some("Test Relay".to_string()),
            Some("Description".to_string()),
            None, None, None, None,
            vec!["JP".to_string()],
            vec!["ja".to_string()],
        );

        let handler = Nip11Handler::new(config);
        let json_str = handler.build_relay_info_json();

        // JSONとしてパース可能であることを確認
        let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();

        // 必須フィールドが存在することを確認
        assert!(parsed["supported_nips"].is_array());
        assert!(parsed["software"].is_string());
        assert!(parsed["version"].is_string());
        assert!(parsed["limitation"].is_object());

        // 設定値が反映されていることを確認
        assert_eq!(parsed["name"], "Test Relay");
        assert_eq!(parsed["description"], "Description");
        assert_eq!(parsed["relay_countries"], serde_json::json!(["JP"]));
        assert_eq!(parsed["language_tags"], serde_json::json!(["ja"]));
    }

    /// Noneフィールドがシリアライズ時に省略される
    #[test]
    fn test_build_relay_info_json_omits_none_fields() {
        let config = RelayInfoConfig::new(
            None, None, None, None, None, None, vec![], vec![],
        );

        let handler = Nip11Handler::new(config);
        let json_str = handler.build_relay_info_json();
        let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();

        // Noneフィールドは省略される
        assert!(parsed.get("name").is_none());
        assert!(parsed.get("description").is_none());
        assert!(parsed.get("pubkey").is_none());
        assert!(parsed.get("contact").is_none());
        assert!(parsed.get("icon").is_none());
        assert!(parsed.get("banner").is_none());

        // 空配列も省略される
        assert!(parsed.get("relay_countries").is_none());
        assert!(parsed.get("language_tags").is_none());

        // 必須フィールドは存在する
        assert!(parsed.get("supported_nips").is_some());
        assert!(parsed.get("software").is_some());
        assert!(parsed.get("version").is_some());
        assert!(parsed.get("limitation").is_some());
    }

    /// NIP-11仕様に準拠した完全なレスポンス構造
    #[test]
    fn test_build_relay_info_json_nip11_compliance() {
        let config = RelayInfoConfig::new(
            Some("My Personal Relay".to_string()),
            Some("A relay for my personal use".to_string()),
            Some("b".repeat(64)),
            Some("https://example.com/contact".to_string()),
            Some("https://example.com/icon.png".to_string()),
            Some("https://example.com/banner.png".to_string()),
            vec!["JP".to_string()],
            vec!["ja".to_string()],
        );

        let handler = Nip11Handler::new(config);
        let json_str = handler.build_relay_info_json();
        let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();

        // NIP-11で定義された全フィールドの型を検証
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

        // supported_nipsの内容を検証
        let nips = parsed["supported_nips"].as_array().unwrap();
        assert!(nips.iter().any(|n| n.as_u64() == Some(1)));
        assert!(nips.iter().any(|n| n.as_u64() == Some(11)));
    }

    /// 部分的な設定でも正しくドキュメントが生成される
    #[test]
    fn test_build_relay_info_partial_config() {
        // 名前と説明のみを設定
        let config = RelayInfoConfig::new(
            Some("Partial Relay".to_string()),
            Some("Only name and description set".to_string()),
            None, None, None, None, vec![], vec![],
        );

        let handler = Nip11Handler::new(config);
        let doc = handler.build_relay_info();

        // 設定した値は反映される
        assert_eq!(doc.name, Some("Partial Relay".to_string()));
        assert_eq!(doc.description, Some("Only name and description set".to_string()));

        // 設定していない値はNone/空
        assert!(doc.pubkey.is_none());
        assert!(doc.contact.is_none());
        assert!(doc.icon.is_none());
        assert!(doc.banner.is_none());
        assert!(doc.relay_countries.is_empty());
        assert!(doc.language_tags.is_empty());

        // 固定値は常に存在
        assert!(!doc.supported_nips.is_empty());
        assert!(!doc.software.is_empty());
        assert!(!doc.version.is_empty());
    }

    // ===========================================
    // Task 3.2: CORSヘッダー付きHTTPレスポンスのテスト
    // ===========================================

    /// handleメソッドがHTTP 200ステータスを返す
    #[test]
    fn test_handle_returns_200_status() {
        let config = RelayInfoConfig::new(
            Some("Test Relay".to_string()),
            None, None, None, None, None, vec![], vec![],
        );
        let handler = Nip11Handler::new(config);

        let response = handler.handle();

        assert_eq!(response.status(), 200);
    }

    /// handleメソッドがContent-Type: application/nostr+jsonを返す
    #[test]
    fn test_handle_returns_content_type_nostr_json() {
        let config = RelayInfoConfig::new(
            None, None, None, None, None, None, vec![], vec![],
        );
        let handler = Nip11Handler::new(config);

        let response = handler.handle();

        let content_type = response.headers().get("content-type");
        assert!(content_type.is_some());
        assert_eq!(content_type.unwrap(), "application/nostr+json");
    }

    /// handleメソッドがAccess-Control-Allow-Origin: *を返す
    #[test]
    fn test_handle_returns_cors_allow_origin() {
        let config = RelayInfoConfig::new(
            None, None, None, None, None, None, vec![], vec![],
        );
        let handler = Nip11Handler::new(config);

        let response = handler.handle();

        let header = response.headers().get("access-control-allow-origin");
        assert!(header.is_some());
        assert_eq!(header.unwrap(), "*");
    }

    /// handleメソッドがAccess-Control-Allow-Headers: Acceptを返す
    #[test]
    fn test_handle_returns_cors_allow_headers() {
        let config = RelayInfoConfig::new(
            None, None, None, None, None, None, vec![], vec![],
        );
        let handler = Nip11Handler::new(config);

        let response = handler.handle();

        let header = response.headers().get("access-control-allow-headers");
        assert!(header.is_some());
        assert_eq!(header.unwrap(), "Accept");
    }

    /// handleメソッドがAccess-Control-Allow-Methods: GET, OPTIONSを返す
    #[test]
    fn test_handle_returns_cors_allow_methods() {
        let config = RelayInfoConfig::new(
            None, None, None, None, None, None, vec![], vec![],
        );
        let handler = Nip11Handler::new(config);

        let response = handler.handle();

        let header = response.headers().get("access-control-allow-methods");
        assert!(header.is_some());
        assert_eq!(header.unwrap(), "GET, OPTIONS");
    }

    /// handleメソッドがリレー情報JSONをボディに含む
    #[test]
    fn test_handle_returns_relay_info_json_body() {
        let config = RelayInfoConfig::new(
            Some("Test Relay".to_string()),
            Some("Test Description".to_string()),
            None, None, None, None,
            vec!["JP".to_string()],
            vec!["ja".to_string()],
        );
        let handler = Nip11Handler::new(config);

        let response = handler.handle();

        // ボディを取得してJSONとしてパース
        let body = match response.body() {
            Body::Text(text) => text.clone(),
            Body::Binary(bytes) => String::from_utf8(bytes.clone()).unwrap(),
            Body::Empty => String::new(),
        };

        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();

        // リレー情報が正しく含まれていることを確認
        assert_eq!(parsed["name"], "Test Relay");
        assert_eq!(parsed["description"], "Test Description");
        assert_eq!(parsed["relay_countries"], serde_json::json!(["JP"]));
        assert_eq!(parsed["language_tags"], serde_json::json!(["ja"]));
        assert!(parsed["supported_nips"].is_array());
        assert!(parsed["software"].is_string());
        assert!(parsed["version"].is_string());
        assert!(parsed["limitation"].is_object());
    }

    /// build_cors_headersメソッドが正しいCORSヘッダーを返す
    #[test]
    fn test_build_cors_headers_contains_all_required_headers() {
        let headers = Nip11Handler::build_cors_headers();

        // 全ての必要なヘッダーが含まれていることを確認
        assert_eq!(
            headers.get("content-type").map(|v| v.to_str().unwrap()),
            Some("application/nostr+json")
        );
        assert_eq!(
            headers.get("access-control-allow-origin").map(|v| v.to_str().unwrap()),
            Some("*")
        );
        assert_eq!(
            headers.get("access-control-allow-headers").map(|v| v.to_str().unwrap()),
            Some("Accept")
        );
        assert_eq!(
            headers.get("access-control-allow-methods").map(|v| v.to_str().unwrap()),
            Some("GET, OPTIONS")
        );
    }
}
