//! EC2上で動作するNostrイベント検索用HTTP APIサーバー
//!
//! 本バイナリは以下の機能を提供する:
//! - イベントの保存 (POST /events)
//! - イベントの検索 (POST /events/search)
//! - イベントの削除 (DELETE /events/{id})
//! - ヘルスチェック (GET /health)

use axum::{routing::get, Router};
use std::net::SocketAddr;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

/// ヘルスチェックエンドポイント
///
/// サーバーの死活確認用。認証不要。
async fn health() -> &'static str {
    "OK"
}

/// ルーターを構築する
///
/// 全エンドポイントのルーティングを定義する。
/// 認証ミドルウェアは後続のタスクで追加予定。
fn create_router() -> Router {
    Router::new().route("/health", get(health))
}

/// メイン関数
///
/// トレーシングを初期化し、HTTPサーバーを起動する。
/// サーバーはlocalhost:8080でリッスンし、Caddyからのリバースプロキシを受け付ける。
#[tokio::main]
async fn main() {
    // 構造化ログの初期化
    // RUST_LOG環境変数でログレベルを制御（デフォルト: info）
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(tracing_subscriber::fmt::layer().json())
        .init();

    tracing::info!("SQLite API サーバーを起動します");

    let app = create_router();

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

    /// ヘルスチェックエンドポイントが200 OKを返すことを確認
    #[tokio::test]
    async fn test_health_endpoint_returns_ok() {
        let app = create_router();

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
        let app = create_router();

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

    /// 存在しないエンドポイントが404を返すことを確認
    #[tokio::test]
    async fn test_unknown_endpoint_returns_not_found() {
        let app = create_router();

        let request = Request::builder()
            .uri("/unknown")
            .method("GET")
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    /// ルーターが正常に作成できることを確認
    #[test]
    fn test_router_creation() {
        let _router = create_router();
        // ルーターが作成できればOK
    }
}
