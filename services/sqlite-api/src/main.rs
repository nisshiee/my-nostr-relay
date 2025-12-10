//! EC2上で動作するNostrイベント検索用HTTP APIサーバー
//!
//! 本バイナリは以下の機能を提供する:
//! - イベントの保存 (POST /events)
//! - イベントの検索 (POST /events/search)
//! - イベントの削除 (DELETE /events/{id})
//! - ヘルスチェック (GET /health)

mod auth;
mod store;

pub use auth::{auth_middleware, AuthConfig};

use axum::{middleware, routing::get, Router};
use std::net::SocketAddr;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

/// APIトークン環境変数名
const API_TOKEN_ENV: &str = "API_TOKEN";

/// ヘルスチェックエンドポイント
///
/// サーバーの死活確認用。認証不要。
async fn health() -> &'static str {
    "OK"
}

/// ルーターを構築する
///
/// 全エンドポイントのルーティングを定義し、認証ミドルウェアを適用する。
/// /healthエンドポイントは認証をバイパスする（auth_middleware内で処理）。
///
/// # Arguments
/// * `auth_config` - 認証設定
fn create_router(auth_config: AuthConfig) -> Router {
    Router::new()
        .route("/health", get(health))
        .layer(middleware::from_fn_with_state(
            auth_config.clone(),
            auth_middleware,
        ))
        .with_state(auth_config)
}

/// メイン関数
///
/// トレーシングを初期化し、HTTPサーバーを起動する。
/// サーバーはlocalhost:8080でリッスンし、Caddyからのリバースプロキシを受け付ける。
///
/// # 環境変数
/// - `API_TOKEN`: APIトークン（必須）
/// - `RUST_LOG`: ログレベル（デフォルト: info）
#[tokio::main]
async fn main() {
    // 構造化ログの初期化
    // RUST_LOG環境変数でログレベルを制御（デフォルト: info）
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(tracing_subscriber::fmt::layer().json())
        .init();

    tracing::info!("SQLite API サーバーを起動します");

    // APIトークンを環境変数から取得
    let api_token = std::env::var(API_TOKEN_ENV).unwrap_or_else(|_| {
        panic!("環境変数 {} が設定されていません", API_TOKEN_ENV)
    });
    let auth_config = AuthConfig::new(api_token);
    tracing::info!("APIトークンを読み込みました");

    let app = create_router(auth_config);

    // localhost:8080でリッスン（Caddyからのリバースプロキシ用）
    let addr = SocketAddr::from(([127, 0, 0, 1], 8080));
    tracing::info!("リッスン開始: {}", addr);

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("アドレスのバインドに失敗しました");

    axum::serve(listener, app)
        .await
        .expect("サーバーの起動に失敗しました");
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    /// テスト用のAPIトークン
    const TEST_TOKEN: &str = "test-token-for-main-tests";

    /// テスト用のルーターを作成
    fn create_test_router() -> Router {
        let auth_config = AuthConfig::new(TEST_TOKEN);
        create_router(auth_config)
    }

    /// ヘルスチェックエンドポイントが200 OKを返すことを確認
    /// 認証なしでアクセス可能
    #[tokio::test]
    async fn test_health_endpoint_returns_ok() {
        let app = create_test_router();

        let request = Request::builder()
            .uri("/health")
            .method("GET")
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    /// ヘルスチェックエンドポイントが"OK"を返すことを確認
    #[tokio::test]
    async fn test_health_endpoint_returns_ok_body() {
        let app = create_test_router();

        let request = Request::builder()
            .uri("/health")
            .method("GET")
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&body[..], b"OK");
    }

    /// 存在しないエンドポイントが404を返すことを確認（認証あり）
    #[tokio::test]
    async fn test_unknown_endpoint_returns_not_found() {
        let app = create_test_router();

        let request = Request::builder()
            .uri("/unknown")
            .method("GET")
            .header("Authorization", format!("Bearer {}", TEST_TOKEN))
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    /// 存在しないエンドポイントは認証なしだと401を返すことを確認
    #[tokio::test]
    async fn test_unknown_endpoint_without_auth_returns_unauthorized() {
        let app = create_test_router();

        let request = Request::builder()
            .uri("/unknown")
            .method("GET")
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        // 認証がないため401が返される（404より先に認証チェックが走る）
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    /// ルーターが正常に作成できることを確認
    #[test]
    fn test_router_creation() {
        let _router = create_test_router();
        // ルーターが作成できればOK
    }
}
