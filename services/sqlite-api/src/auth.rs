//! 認証ミドルウェア
//!
//! APIトークンによる認証を提供する。
//! - Authorizationヘッダーからトークンを抽出
//! - 環境変数に設定されたトークンと照合
//! - /healthエンドポイントは認証をバイパス
//! - 不正なトークン時は401 Unauthorized（JSON形式）を返却

use crate::error::ApiError;
use axum::{
    body::Body,
    extract::State,
    http::Request,
    middleware::Next,
    response::{IntoResponse, Response},
};

/// 認証設定
///
/// APIトークンを保持する構造体。
/// axumのStateとして共有される。
#[derive(Clone)]
pub struct AuthConfig {
    /// APIトークン（環境変数から取得）
    pub api_token: String,
}

impl AuthConfig {
    /// 新しいAuthConfigを作成
    ///
    /// # Arguments
    /// * `api_token` - APIトークン
    pub fn new(api_token: impl Into<String>) -> Self {
        Self {
            api_token: api_token.into(),
        }
    }
}

/// 認証ミドルウェア
///
/// リクエストのAuthorizationヘッダーを検証する。
/// /healthエンドポイントは認証をバイパスする。
///
/// # Authorization Header Format
/// `Bearer <token>` または `<token>`
///
/// # Returns
/// - 認証成功時: 次のハンドラーにリクエストを渡す
/// - 認証失敗時: 401 Unauthorized（JSON形式）を返す
pub async fn auth_middleware(
    State(config): State<AuthConfig>,
    request: Request<Body>,
    next: Next,
) -> Response {
    // /healthエンドポイントは認証をバイパス
    if request.uri().path() == "/health" {
        return next.run(request).await;
    }

    // Authorizationヘッダーを取得
    let auth_header = request
        .headers()
        .get("Authorization")
        .and_then(|h| h.to_str().ok());

    // トークンを抽出
    let token = match auth_header {
        Some(header) => {
            // "Bearer <token>" または "<token>" 形式をサポート
            if let Some(token) = header.strip_prefix("Bearer ") {
                token.trim()
            } else {
                header.trim()
            }
        }
        None => {
            tracing::warn!(
                path = %request.uri().path(),
                "認証ヘッダーがありません"
            );
            return ApiError::unauthorized("Authorizationヘッダーが必要です").into_response();
        }
    };

    // トークンを検証
    if token == config.api_token {
        next.run(request).await
    } else {
        tracing::warn!(
            path = %request.uri().path(),
            "無効なAPIトークン"
        );
        ApiError::unauthorized("APIトークンが無効です").into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
        middleware,
        routing::get,
        Router,
    };
    use tower::ServiceExt;

    /// テスト用のAPIトークン
    const TEST_TOKEN: &str = "test-api-token-12345";

    /// テスト用のルーターを作成
    fn create_test_router() -> Router {
        let config = AuthConfig::new(TEST_TOKEN);

        Router::new()
            .route("/health", get(|| async { "OK" }))
            .route("/events", get(|| async { "events" }))
            .route("/events/search", get(|| async { "search" }))
            .layer(middleware::from_fn_with_state(config.clone(), auth_middleware))
            .with_state(config)
    }

    // ========================================
    // /healthエンドポイントのテスト
    // ========================================

    /// /healthエンドポイントは認証なしでアクセスできることを確認
    #[tokio::test]
    async fn test_health_endpoint_bypasses_auth() {
        let app = create_test_router();

        let request = Request::builder()
            .uri("/health")
            .method("GET")
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::OK,
            "/healthは認証なしで200 OKを返すべき"
        );
    }

    /// /healthエンドポイントは不正なトークンでもアクセスできることを確認
    #[tokio::test]
    async fn test_health_endpoint_ignores_invalid_token() {
        let app = create_test_router();

        let request = Request::builder()
            .uri("/health")
            .method("GET")
            .header("Authorization", "Bearer invalid-token")
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::OK,
            "/healthは不正なトークンでも200 OKを返すべき"
        );
    }

    // ========================================
    // 有効なトークンのテスト
    // ========================================

    /// 有効なBearerトークンでアクセスできることを確認
    #[tokio::test]
    async fn test_valid_bearer_token_allows_access() {
        let app = create_test_router();

        let request = Request::builder()
            .uri("/events")
            .method("GET")
            .header("Authorization", format!("Bearer {}", TEST_TOKEN))
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::OK,
            "有効なBearerトークンで200 OKを返すべき"
        );
    }

    /// 有効なトークン（Bearer接頭辞なし）でアクセスできることを確認
    #[tokio::test]
    async fn test_valid_token_without_bearer_prefix_allows_access() {
        let app = create_test_router();

        let request = Request::builder()
            .uri("/events")
            .method("GET")
            .header("Authorization", TEST_TOKEN)
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::OK,
            "有効なトークン（Bearer接頭辞なし）で200 OKを返すべき"
        );
    }

    /// /events/searchエンドポイントも認証で保護されることを確認
    #[tokio::test]
    async fn test_search_endpoint_protected_with_valid_token() {
        let app = create_test_router();

        let request = Request::builder()
            .uri("/events/search")
            .method("GET")
            .header("Authorization", format!("Bearer {}", TEST_TOKEN))
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::OK,
            "/events/searchも有効なトークンで200 OKを返すべき"
        );
    }

    // ========================================
    // 無効なトークンのテスト
    // ========================================

    /// 無効なトークンで401を返すことを確認
    #[tokio::test]
    async fn test_invalid_token_returns_unauthorized() {
        let app = create_test_router();

        let request = Request::builder()
            .uri("/events")
            .method("GET")
            .header("Authorization", "Bearer invalid-token")
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "無効なトークンで401 Unauthorizedを返すべき"
        );
    }

    /// 空のトークンで401を返すことを確認
    #[tokio::test]
    async fn test_empty_token_returns_unauthorized() {
        let app = create_test_router();

        let request = Request::builder()
            .uri("/events")
            .method("GET")
            .header("Authorization", "Bearer ")
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "空のトークンで401 Unauthorizedを返すべき"
        );
    }

    // ========================================
    // Authorizationヘッダーなしのテスト
    // ========================================

    /// Authorizationヘッダーなしで401を返すことを確認
    #[tokio::test]
    async fn test_missing_auth_header_returns_unauthorized() {
        let app = create_test_router();

        let request = Request::builder()
            .uri("/events")
            .method("GET")
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "Authorizationヘッダーなしで401 Unauthorizedを返すべき"
        );
    }

    /// /events/searchもAuthorizationヘッダーなしで401を返すことを確認
    #[tokio::test]
    async fn test_search_without_auth_returns_unauthorized() {
        let app = create_test_router();

        let request = Request::builder()
            .uri("/events/search")
            .method("GET")
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "/events/searchもAuthorizationヘッダーなしで401 Unauthorizedを返すべき"
        );
    }

    // ========================================
    // AuthConfigのテスト
    // ========================================

    /// AuthConfigが正しく作成されることを確認
    #[test]
    fn test_auth_config_creation() {
        let config = AuthConfig::new("my-token");
        assert_eq!(config.api_token, "my-token");
    }

    /// AuthConfigがString型でも作成できることを確認
    #[test]
    fn test_auth_config_creation_with_string() {
        let config = AuthConfig::new(String::from("my-token"));
        assert_eq!(config.api_token, "my-token");
    }

    // ========================================
    // トークン形式のエッジケース
    // ========================================

    /// トークンの前後の空白が無視されることを確認
    #[tokio::test]
    async fn test_token_with_whitespace_trimmed() {
        let app = create_test_router();

        let request = Request::builder()
            .uri("/events")
            .method("GET")
            .header("Authorization", format!("Bearer  {}  ", TEST_TOKEN))
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::OK,
            "トークンの前後の空白は無視されるべき"
        );
    }

    /// "bearer"（小文字）も認識されることを確認
    /// 注: HTTP仕様ではBearerは大文字小文字を区別しないが、
    /// シンプルな実装では"Bearer "のみサポート
    #[tokio::test]
    async fn test_lowercase_bearer_not_recognized() {
        let app = create_test_router();

        let request = Request::builder()
            .uri("/events")
            .method("GET")
            .header("Authorization", format!("bearer {}", TEST_TOKEN))
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        // "bearer "はstrip_prefixで認識されないため、
        // トークン全体として扱われ、不一致で401
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "小文字の'bearer'は認識されず401を返すべき"
        );
    }
}
