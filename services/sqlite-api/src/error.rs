//! APIエラーハンドリング
//!
//! 統一されたエラーレスポンス形式を提供する。
//! すべてのエラーはJSON形式で返却され、`error`と`message`フィールドを含む。

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};

/// APIエラーレスポンスのボディ
///
/// JSON形式で`error`（エラー種別）と`message`（詳細メッセージ）を含む。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApiErrorBody {
    /// エラー種別（例: "bad_request", "unauthorized", "not_found", "internal_error"）
    pub error: String,
    /// 詳細なエラーメッセージ
    pub message: String,
}

/// APIエラー
///
/// 統一されたエラーレスポンス形式。
/// ステータスコードとJSON形式のエラーボディを含む。
#[derive(Debug, Clone)]
pub struct ApiError {
    /// HTTPステータスコード
    status: StatusCode,
    /// エラーレスポンスボディ
    body: ApiErrorBody,
}

impl ApiError {
    /// 新しいApiErrorを作成
    pub fn new(status: StatusCode, error: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            body: ApiErrorBody {
                error: error.into(),
                message: message.into(),
            },
        }
    }

    /// 400 Bad Requestエラーを作成
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", message)
    }

    /// 401 Unauthorizedエラーを作成
    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", message)
    }

    /// 404 Not Foundエラーを作成
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", message)
    }

    /// 500 Internal Server Errorを作成
    pub fn internal_error(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", message)
    }

    /// エラー種別を取得
    pub fn error(&self) -> &str {
        &self.body.error
    }

    /// エラーメッセージを取得
    pub fn message(&self) -> &str {
        &self.body.message
    }

    /// ステータスコードを取得
    pub fn status(&self) -> StatusCode {
        self.status
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(self.body)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::get;
    use axum::Router;
    use tower::ServiceExt;

    // ========================================
    // ApiErrorの基本テスト
    // ========================================

    /// ApiErrorが正しく作成されることを確認
    #[test]
    fn test_api_error_creation() {
        let error = ApiError::new(StatusCode::BAD_REQUEST, "test_error", "テストメッセージ");
        assert_eq!(error.error(), "test_error");
        assert_eq!(error.message(), "テストメッセージ");
        assert_eq!(error.status(), StatusCode::BAD_REQUEST);
    }

    /// bad_requestが正しいステータスコードとエラーを返すことを確認
    #[test]
    fn test_bad_request_error() {
        let error = ApiError::bad_request("不正なリクエスト");
        assert_eq!(error.status(), StatusCode::BAD_REQUEST);
        assert_eq!(error.error(), "bad_request");
        assert_eq!(error.message(), "不正なリクエスト");
    }

    /// unauthorizedが正しいステータスコードとエラーを返すことを確認
    #[test]
    fn test_unauthorized_error() {
        let error = ApiError::unauthorized("認証が必要です");
        assert_eq!(error.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(error.error(), "unauthorized");
        assert_eq!(error.message(), "認証が必要です");
    }

    /// not_foundが正しいステータスコードとエラーを返すことを確認
    #[test]
    fn test_not_found_error() {
        let error = ApiError::not_found("リソースが見つかりません");
        assert_eq!(error.status(), StatusCode::NOT_FOUND);
        assert_eq!(error.error(), "not_found");
        assert_eq!(error.message(), "リソースが見つかりません");
    }

    /// internal_errorが正しいステータスコードとエラーを返すことを確認
    #[test]
    fn test_internal_error() {
        let error = ApiError::internal_error("サーバーエラー");
        assert_eq!(error.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(error.error(), "internal_error");
        assert_eq!(error.message(), "サーバーエラー");
    }

    // ========================================
    // JSONシリアライズのテスト
    // ========================================

    /// ApiErrorBodyがJSONに正しくシリアライズされることを確認
    #[test]
    fn test_api_error_body_serializes_to_json() {
        let body = ApiErrorBody {
            error: "test_error".to_string(),
            message: "テストメッセージ".to_string(),
        };
        let json = serde_json::to_string(&body).unwrap();

        // JSONにerrorとmessageフィールドが含まれることを確認
        assert!(json.contains("\"error\""));
        assert!(json.contains("\"message\""));
        assert!(json.contains("test_error"));
        assert!(json.contains("テストメッセージ"));
    }

    /// ApiErrorBodyがJSONからデシリアライズできることを確認
    #[test]
    fn test_api_error_body_deserializes_from_json() {
        let json = r#"{"error":"bad_request","message":"不正なパラメータ"}"#;
        let body: ApiErrorBody = serde_json::from_str(json).unwrap();

        assert_eq!(body.error, "bad_request");
        assert_eq!(body.message, "不正なパラメータ");
    }

    // ========================================
    // IntoResponseのテスト
    // ========================================

    /// ApiErrorがResponseに変換できることを確認
    #[tokio::test]
    async fn test_api_error_into_response() {
        async fn error_handler() -> ApiError {
            ApiError::new(StatusCode::OK, "test_error", "テスト")
        }

        let app = Router::new().route("/error", get(error_handler));
        let request = Request::builder()
            .uri("/error")
            .method("GET")
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        // JSONレスポンスが返されることを確認
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let error_body: ApiErrorBody = serde_json::from_slice(&body).unwrap();

        assert_eq!(error_body.error, "test_error");
        assert_eq!(error_body.message, "テスト");
    }

    /// bad_requestがJSON形式で400レスポンスを返すことを確認
    #[tokio::test]
    async fn test_bad_request_returns_json_400() {
        async fn error_handler() -> ApiError {
            ApiError::bad_request("不正なリクエスト")
        }

        let app = Router::new().route("/error", get(error_handler));
        let request = Request::builder()
            .uri("/error")
            .method("GET")
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        // ステータスコードが400であることを確認
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        // JSONレスポンスが返されることを確認
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let error_body: ApiErrorBody = serde_json::from_slice(&body).unwrap();

        assert_eq!(error_body.error, "bad_request");
        assert_eq!(error_body.message, "不正なリクエスト");
    }

    /// internal_errorがJSON形式で500レスポンスを返すことを確認
    #[tokio::test]
    async fn test_internal_error_returns_json_500() {
        async fn error_handler() -> ApiError {
            ApiError::internal_error("データベースエラー")
        }

        let app = Router::new().route("/error", get(error_handler));
        let request = Request::builder()
            .uri("/error")
            .method("GET")
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let error_body: ApiErrorBody = serde_json::from_slice(&body).unwrap();

        assert_eq!(error_body.error, "internal_error");
        assert_eq!(error_body.message, "データベースエラー");
    }

    /// not_foundがJSON形式で404レスポンスを返すことを確認
    #[tokio::test]
    async fn test_not_found_returns_json_404() {
        async fn error_handler() -> ApiError {
            ApiError::not_found("イベントが見つかりません")
        }

        let app = Router::new().route("/error", get(error_handler));
        let request = Request::builder()
            .uri("/error")
            .method("GET")
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let error_body: ApiErrorBody = serde_json::from_slice(&body).unwrap();

        assert_eq!(error_body.error, "not_found");
        assert_eq!(error_body.message, "イベントが見つかりません");
    }

    /// unauthorizedがJSON形式で401レスポンスを返すことを確認
    #[tokio::test]
    async fn test_unauthorized_returns_json_401() {
        async fn error_handler() -> ApiError {
            ApiError::unauthorized("APIトークンが無効です")
        }

        let app = Router::new().route("/error", get(error_handler));
        let request = Request::builder()
            .uri("/error")
            .method("GET")
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let error_body: ApiErrorBody = serde_json::from_slice(&body).unwrap();

        assert_eq!(error_body.error, "unauthorized");
        assert_eq!(error_body.message, "APIトークンが無効です");
    }
}
