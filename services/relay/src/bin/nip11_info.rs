/// NIP-11リレー情報HTTP Lambdaエントリポイント
///
/// Lambda Function URL経由のHTTPリクエストを処理し、
/// NIP-11仕様に準拠したリレー情報JSONを返却する。
///
/// 要件: 1.1, 1.3, 6.2
use lambda_http::{run, service_fn, Body, Error, Request, Response};
use relay::application::Nip11Handler;
use relay::domain::LimitationConfig;
use relay::infrastructure::{init_logging, RelayInfoConfig};
use tracing::info;

#[tokio::main]
async fn main() -> Result<(), Error> {
    // 構造化ログを初期化
    init_logging();

    info!("NIP-11 Lambda関数を初期化");

    // Lambda関数を実行
    run(service_fn(handler)).await
}

/// HTTPリクエストハンドラー
///
/// Lambda Function URL経由で受信したHTTPリクエストを処理し、
/// NIP-11レスポンスを返却する。
///
/// # Arguments
/// * `_request` - HTTPリクエスト（現在は使用しない）
///
/// # Returns
/// NIP-11準拠のHTTPレスポンス（CORSヘッダー付き）
async fn handler(_request: Request) -> Result<Response<Body>, Error> {
    info!("NIP-11リクエスト受信");

    // 環境変数からリレー設定を読み込み
    let config = RelayInfoConfig::from_env();

    // 環境変数から制限値設定を読み込み
    let limitation_config = LimitationConfig::from_env();

    // ハンドラーを作成してレスポンスを生成
    let nip11_handler = Nip11Handler::with_limitation(config, limitation_config);
    let response = nip11_handler.handle();

    info!("NIP-11レスポンス送信");

    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lambda_http::http::Request as HttpRequest;
    use relay::infrastructure::init_logging;
    use serial_test::serial;

    // テストで環境変数を安全に設定/削除するヘルパー
    // 注: Rust 2024エディションでset_var/remove_varはunsafe
    //     また、unsafe fn内でもunsafe操作には明示的なunsafeブロックが必要
    unsafe fn set_env(key: &str, value: &str) {
        unsafe { std::env::set_var(key, value) };
    }

    unsafe fn remove_env(key: &str) {
        unsafe { std::env::remove_var(key) };
    }

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

    // 制限値環境変数のクリーンアップ
    unsafe fn cleanup_limitation_env() {
        unsafe {
            remove_env("RELAY_MAX_MESSAGE_LENGTH");
            remove_env("RELAY_MAX_SUBSCRIPTIONS");
            remove_env("RELAY_MAX_LIMIT");
            remove_env("RELAY_MAX_EVENT_TAGS");
            remove_env("RELAY_MAX_CONTENT_LENGTH");
            remove_env("RELAY_CREATED_AT_LOWER_LIMIT");
            remove_env("RELAY_CREATED_AT_UPPER_LIMIT");
            remove_env("RELAY_DEFAULT_LIMIT");
        }
    }

    // 全環境変数のクリーンアップ
    unsafe fn cleanup_all_env() {
        unsafe {
            cleanup_relay_env();
            cleanup_limitation_env();
        }
    }

    // ===========================================
    // Task 3: NIP-11レスポンスに全制限値を含めるテスト
    // ===========================================

    /// HTTPレスポンスのlimitationに全9フィールドが含まれる
    #[tokio::test]
    #[serial(relay_env)]
    async fn test_handler_includes_all_nine_limitation_fields() {
        init_logging();
        unsafe { cleanup_all_env(); }

        let request = HttpRequest::builder()
            .method("GET")
            .uri("/")
            .header("Accept", "application/nostr+json")
            .body(Body::Empty)
            .unwrap();

        let response = handler(request).await.unwrap();

        let body = match response.body() {
            Body::Text(text) => text.clone(),
            Body::Binary(bytes) => String::from_utf8(bytes.clone()).unwrap(),
            Body::Empty => String::new(),
            _ => panic!("予期しないBody型"),
        };

        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        let limitation = &parsed["limitation"];

        // 全9フィールドの存在を確認
        assert!(limitation["max_message_length"].is_number(), "max_message_length should be present");
        assert!(limitation["max_subscriptions"].is_number(), "max_subscriptions should be present");
        assert!(limitation["max_limit"].is_number(), "max_limit should be present");
        assert!(limitation["max_event_tags"].is_number(), "max_event_tags should be present");
        assert!(limitation["max_content_length"].is_number(), "max_content_length should be present");
        assert!(limitation["max_subid_length"].is_number(), "max_subid_length should be present");
        assert!(limitation["created_at_lower_limit"].is_number(), "created_at_lower_limit should be present");
        assert!(limitation["created_at_upper_limit"].is_number(), "created_at_upper_limit should be present");
        assert!(limitation["default_limit"].is_number(), "default_limit should be present");

        // フィールド数が正確に9であることを確認
        let limitation_obj = limitation.as_object().unwrap();
        assert_eq!(limitation_obj.len(), 9, "limitationオブジェクトは正確に9フィールドを持つべき");
    }

    /// HTTPレスポンスのlimitationがデフォルト値を返す
    #[tokio::test]
    #[serial(relay_env)]
    async fn test_handler_returns_default_limitation_values() {
        init_logging();
        unsafe { cleanup_all_env(); }

        let request = HttpRequest::builder()
            .method("GET")
            .uri("/")
            .header("Accept", "application/nostr+json")
            .body(Body::Empty)
            .unwrap();

        let response = handler(request).await.unwrap();

        let body = match response.body() {
            Body::Text(text) => text.clone(),
            Body::Binary(bytes) => String::from_utf8(bytes.clone()).unwrap(),
            Body::Empty => String::new(),
            _ => panic!("予期しないBody型"),
        };

        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        let limitation = &parsed["limitation"];

        // デフォルト値を検証
        assert_eq!(limitation["max_message_length"], 131072);
        assert_eq!(limitation["max_subscriptions"], 20);
        assert_eq!(limitation["max_limit"], 5000);
        assert_eq!(limitation["max_event_tags"], 1000);
        assert_eq!(limitation["max_content_length"], 65536);
        assert_eq!(limitation["max_subid_length"], 64);
        assert_eq!(limitation["created_at_lower_limit"], 31536000);
        assert_eq!(limitation["created_at_upper_limit"], 900);
        assert_eq!(limitation["default_limit"], 100);
    }

    /// 環境変数で設定した制限値がHTTPレスポンスに反映される
    #[tokio::test]
    #[serial(relay_env)]
    async fn test_handler_reflects_limitation_env_vars() {
        init_logging();
        unsafe {
            cleanup_all_env();
            set_env("RELAY_MAX_MESSAGE_LENGTH", "262144");
            set_env("RELAY_MAX_SUBSCRIPTIONS", "50");
            set_env("RELAY_MAX_LIMIT", "10000");
            set_env("RELAY_MAX_EVENT_TAGS", "2000");
            set_env("RELAY_MAX_CONTENT_LENGTH", "131072");
            set_env("RELAY_CREATED_AT_LOWER_LIMIT", "63072000");
            set_env("RELAY_CREATED_AT_UPPER_LIMIT", "1800");
            set_env("RELAY_DEFAULT_LIMIT", "200");
        }

        let request = HttpRequest::builder()
            .method("GET")
            .uri("/")
            .header("Accept", "application/nostr+json")
            .body(Body::Empty)
            .unwrap();

        let response = handler(request).await.unwrap();

        let body = match response.body() {
            Body::Text(text) => text.clone(),
            Body::Binary(bytes) => String::from_utf8(bytes.clone()).unwrap(),
            Body::Empty => String::new(),
            _ => panic!("予期しないBody型"),
        };

        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        let limitation = &parsed["limitation"];

        // 環境変数の値が反映されていることを確認
        assert_eq!(limitation["max_message_length"], 262144);
        assert_eq!(limitation["max_subscriptions"], 50);
        assert_eq!(limitation["max_limit"], 10000);
        assert_eq!(limitation["max_event_tags"], 2000);
        assert_eq!(limitation["max_content_length"], 131072);
        assert_eq!(limitation["max_subid_length"], 64); // 常に固定値
        assert_eq!(limitation["created_at_lower_limit"], 63072000);
        assert_eq!(limitation["created_at_upper_limit"], 1800);
        assert_eq!(limitation["default_limit"], 200);

        unsafe { cleanup_all_env(); }
    }

    // ===========================================
    // Task 4.1: NIP-11 HTTP Lambdaハンドラーのテスト
    // ===========================================

    /// ハンドラーがHTTP 200ステータスを返す
    #[tokio::test]
    #[serial(relay_env)]
    async fn test_handler_returns_200_status() {
        init_logging();
        unsafe { cleanup_relay_env(); }

        // テスト用HTTPリクエストを作成
        let request = HttpRequest::builder()
            .method("GET")
            .uri("/")
            .header("Accept", "application/nostr+json")
            .body(Body::Empty)
            .unwrap();

        let response = handler(request).await.unwrap();

        assert_eq!(response.status(), 200);
    }

    /// ハンドラーがContent-Type: application/nostr+jsonを返す
    #[tokio::test]
    #[serial(relay_env)]
    async fn test_handler_returns_correct_content_type() {
        init_logging();
        unsafe { cleanup_relay_env(); }

        let request = HttpRequest::builder()
            .method("GET")
            .uri("/")
            .header("Accept", "application/nostr+json")
            .body(Body::Empty)
            .unwrap();

        let response = handler(request).await.unwrap();

        let content_type = response.headers().get("content-type");
        assert!(content_type.is_some());
        assert_eq!(content_type.unwrap(), "application/nostr+json");
    }

    /// ハンドラーがCORSヘッダーを含むレスポンスを返す
    #[tokio::test]
    #[serial(relay_env)]
    async fn test_handler_returns_cors_headers() {
        init_logging();
        unsafe { cleanup_relay_env(); }

        let request = HttpRequest::builder()
            .method("GET")
            .uri("/")
            .header("Accept", "application/nostr+json")
            .body(Body::Empty)
            .unwrap();

        let response = handler(request).await.unwrap();

        // CORSヘッダーの存在を確認
        assert!(response.headers().get("access-control-allow-origin").is_some());
        assert!(response.headers().get("access-control-allow-headers").is_some());
        assert!(response.headers().get("access-control-allow-methods").is_some());
    }

    /// ハンドラーが有効なJSON本文を返す
    #[tokio::test]
    #[serial(relay_env)]
    async fn test_handler_returns_valid_json_body() {
        init_logging();
        unsafe { cleanup_relay_env(); }

        let request = HttpRequest::builder()
            .method("GET")
            .uri("/")
            .header("Accept", "application/nostr+json")
            .body(Body::Empty)
            .unwrap();

        let response = handler(request).await.unwrap();

        // ボディを取得
        let body = match response.body() {
            Body::Text(text) => text.clone(),
            Body::Binary(bytes) => String::from_utf8(bytes.clone()).unwrap(),
            Body::Empty => String::new(),
            _ => panic!("予期しないBody型"),
        };

        // JSONとしてパース可能であることを確認
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();

        // NIP-11必須フィールドの存在を確認
        assert!(parsed["supported_nips"].is_array());
        assert!(parsed["software"].is_string());
        assert!(parsed["version"].is_string());
        assert!(parsed["limitation"].is_object());
    }

    /// ハンドラーが環境変数からの設定を正しく反映する
    #[tokio::test]
    #[serial(relay_env)]
    async fn test_handler_reflects_environment_config() {
        init_logging();

        // 環境変数を設定
        unsafe {
            cleanup_relay_env();
            set_env("RELAY_NAME", "Lambda Test Relay");
            set_env("RELAY_DESCRIPTION", "NIP-11 Lambda Test");
            set_env("RELAY_COUNTRIES", "JP");
            set_env("RELAY_LANGUAGE_TAGS", "ja");
        }

        let request = HttpRequest::builder()
            .method("GET")
            .uri("/")
            .header("Accept", "application/nostr+json")
            .body(Body::Empty)
            .unwrap();

        let response = handler(request).await.unwrap();

        let body = match response.body() {
            Body::Text(text) => text.clone(),
            Body::Binary(bytes) => String::from_utf8(bytes.clone()).unwrap(),
            Body::Empty => String::new(),
            _ => panic!("予期しないBody型"),
        };

        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();

        // 環境変数の設定が反映されていることを確認
        assert_eq!(parsed["name"], "Lambda Test Relay");
        assert_eq!(parsed["description"], "NIP-11 Lambda Test");
        assert_eq!(parsed["relay_countries"], serde_json::json!(["JP"]));
        assert_eq!(parsed["language_tags"], serde_json::json!(["ja"]));

        // クリーンアップ
        unsafe { cleanup_relay_env(); }
    }

    /// ハンドラーがsupported_nipsにNIP-1とNIP-11を含む
    #[tokio::test]
    #[serial(relay_env)]
    async fn test_handler_includes_supported_nips() {
        init_logging();
        unsafe { cleanup_relay_env(); }

        let request = HttpRequest::builder()
            .method("GET")
            .uri("/")
            .header("Accept", "application/nostr+json")
            .body(Body::Empty)
            .unwrap();

        let response = handler(request).await.unwrap();

        let body = match response.body() {
            Body::Text(text) => text.clone(),
            Body::Binary(bytes) => String::from_utf8(bytes.clone()).unwrap(),
            Body::Empty => String::new(),
            _ => panic!("予期しないBody型"),
        };

        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        let nips = parsed["supported_nips"].as_array().unwrap();

        // NIP-1とNIP-11がサポートされていることを確認
        assert!(nips.iter().any(|n| n.as_u64() == Some(1)));
        assert!(nips.iter().any(|n| n.as_u64() == Some(11)));
    }

    /// ハンドラーがlimitationにmax_subid_lengthを含む
    #[tokio::test]
    #[serial(relay_env)]
    async fn test_handler_includes_limitation() {
        init_logging();
        unsafe { cleanup_relay_env(); }

        let request = HttpRequest::builder()
            .method("GET")
            .uri("/")
            .header("Accept", "application/nostr+json")
            .body(Body::Empty)
            .unwrap();

        let response = handler(request).await.unwrap();

        let body = match response.body() {
            Body::Text(text) => text.clone(),
            Body::Binary(bytes) => String::from_utf8(bytes.clone()).unwrap(),
            Body::Empty => String::new(),
            _ => panic!("予期しないBody型"),
        };

        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();

        // limitation.max_subid_lengthが64であることを確認
        assert_eq!(parsed["limitation"]["max_subid_length"], 64);
    }
}
