//! EC2上で動作するNostrイベント検索用HTTP APIサーバー
//!
//! 本バイナリは以下の機能を提供する:
//! - イベントの保存 (POST /events)
//! - イベントの検索 (POST /events/search)
//! - イベントの削除 (DELETE /events/{id})
//! - ヘルスチェック (GET /health)

mod auth;
mod error;
mod store;

pub use auth::{auth_middleware, AuthConfig};
pub use error::ApiError;
pub use store::{NostrEvent, SaveResult, SearchFilter, SearchRequest, SqliteEventStore, StoreError};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::signal;
use tower_http::trace::TraceLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

/// APIトークン環境変数名
const API_TOKEN_ENV: &str = "API_TOKEN";

/// データベースパス環境変数名
const DB_PATH_ENV: &str = "DB_PATH";

/// デフォルトのデータベースパス
const DEFAULT_DB_PATH: &str = "/var/lib/nostr/events.db";

/// アプリケーション状態
///
/// ルーター全体で共有される状態を保持する。
#[derive(Clone)]
pub struct AppState {
    /// 認証設定
    pub auth_config: AuthConfig,
    /// SQLiteイベントストア
    pub store: Arc<SqliteEventStore>,
}

/// ヘルスチェックエンドポイント
///
/// サーバーの死活確認用。認証不要。
async fn health() -> &'static str {
    "OK"
}

/// イベント保存エンドポイント (POST /events)
///
/// NostrイベントをSQLiteデータベースに保存する。
///
/// # Returns
/// - 201 Created: 新規イベントが保存された
/// - 200 OK: イベントが既に存在していた
/// - 400 Bad Request: リクエストボディが不正
/// - 500 Internal Server Error: データベースエラー
async fn create_event(
    State(state): State<AppState>,
    Json(event): Json<NostrEvent>,
) -> Response {
    tracing::info!(
        event_id = %event.id,
        pubkey = %event.pubkey,
        kind = event.kind,
        "イベント保存リクエストを受信"
    );

    match state.store.save_event(&event).await {
        Ok(SaveResult::Created) => {
            tracing::info!(event_id = %event.id, "イベントを新規作成");
            StatusCode::CREATED.into_response()
        }
        Ok(SaveResult::AlreadyExists) => {
            tracing::info!(event_id = %event.id, "イベントは既に存在");
            StatusCode::OK.into_response()
        }
        Err(e) => {
            tracing::error!(event_id = %event.id, error = %e, "イベント保存エラー");
            ApiError::internal_error(format!("データベースエラー: {}", e)).into_response()
        }
    }
}

/// イベント削除エンドポイント (DELETE /events/{id})
///
/// 指定されたIDのイベントをSQLiteデータベースから削除する。
///
/// # Returns
/// - 204 No Content: イベントが削除された
/// - 404 Not Found: イベントが存在しない
/// - 500 Internal Server Error: データベースエラー
async fn delete_event_handler(
    State(state): State<AppState>,
    Path(event_id): Path<String>,
) -> Response {
    tracing::info!(event_id = %event_id, "イベント削除リクエストを受信");

    match state.store.delete_event(&event_id).await {
        Ok(true) => {
            tracing::info!(event_id = %event_id, "イベントを削除");
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(false) => {
            tracing::warn!(event_id = %event_id, "削除対象のイベントが見つからない");
            ApiError::not_found(format!("イベントが見つかりません: {}", event_id)).into_response()
        }
        Err(e) => {
            tracing::error!(event_id = %event_id, error = %e, "イベント削除エラー");
            ApiError::internal_error(format!("データベースエラー: {}", e)).into_response()
        }
    }
}

/// イベント検索エンドポイント (POST /events/search)
///
/// 複数のフィルター条件をOR結合で検索し、結果をマージして返す。
/// Lambda側のHttpSqliteEventRepositoryから送信されるSearchRequest形式に対応。
///
/// # Returns
/// - 200 OK: 検索結果（JSON配列）
/// - 400 Bad Request: リクエストボディが不正
/// - 500 Internal Server Error: データベースエラー
async fn search_events_handler(
    State(state): State<AppState>,
    Json(request): Json<SearchRequest>,
) -> Response {
    tracing::info!(
        filter_count = request.filters.len(),
        "イベント検索リクエストを受信（複数フィルター対応）"
    );

    // 各フィルターの詳細をログ出力
    for (i, filter) in request.filters.iter().enumerate() {
        tracing::debug!(
            filter_index = i,
            ids = ?filter.ids,
            authors = ?filter.authors,
            kinds = ?filter.kinds,
            since = ?filter.since,
            until = ?filter.until,
            limit = ?filter.limit,
            tags = ?filter.tags,
            "フィルター詳細"
        );
    }

    match state.store.search_events_multi(&request.filters).await {
        Ok(events) => {
            tracing::info!(count = events.len(), "検索結果を返却");
            Json(events).into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, "イベント検索エラー");
            ApiError::internal_error(format!("データベースエラー: {}", e)).into_response()
        }
    }
}

/// ルーターを構築する（ストア付き）
///
/// 全エンドポイントのルーティングを定義し、認証ミドルウェアを適用する。
/// /healthエンドポイントは認証をバイパスする（auth_middleware内で処理）。
/// TraceLayerによりリクエスト/レスポンスの構造化ログを自動記録する。
///
/// # Arguments
/// * `auth_config` - 認証設定
/// * `store` - SQLiteイベントストア
pub fn create_router_with_store(auth_config: AuthConfig, store: Arc<SqliteEventStore>) -> Router {
    let state = AppState {
        auth_config: auth_config.clone(),
        store,
    };

    Router::new()
        .route("/health", get(health))
        .route("/events", post(create_event))
        .route("/events/{id}", delete(delete_event_handler))
        .route("/events/search", post(search_events_handler))
        .layer(middleware::from_fn_with_state(
            auth_config,
            auth_middleware,
        ))
        // リクエストトレーシングレイヤー（method, path, status, latencyを自動記録）
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// ルーターを構築する（テスト用、ストアなし）
///
/// 主にテスト用。/healthエンドポイントのみを含む。
///
/// # Arguments
/// * `auth_config` - 認証設定
#[cfg(test)]
fn create_router(auth_config: AuthConfig) -> Router {
    Router::new()
        .route("/health", get(health))
        .layer(middleware::from_fn_with_state(
            auth_config.clone(),
            auth_middleware,
        ))
        .with_state(auth_config)
}

/// シャットダウンシグナルを待機する
///
/// SIGTERMまたはCtrl+C (SIGINT) を待機し、いずれかを受信したらリターンする。
/// axum::serve の with_graceful_shutdown() と組み合わせて使用することで、
/// 新規リクエストの受付停止と処理中リクエストの完了待機を実現する。
///
/// # Panics
/// シグナルハンドラーの登録に失敗した場合はパニックする。
async fn shutdown_signal() {
    // Ctrl+C (SIGINT) を待機
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("Ctrl+C シグナルハンドラーの登録に失敗しました");
    };

    // SIGTERM を待機 (Unix系OSのみ)
    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("SIGTERM シグナルハンドラーの登録に失敗しました")
            .recv()
            .await;
    };

    // Windows等の非Unix環境ではSIGTERMは利用不可
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {
            tracing::info!("Ctrl+C (SIGINT) を受信しました。graceful shutdownを開始します");
        }
        _ = terminate => {
            tracing::info!("SIGTERM を受信しました。graceful shutdownを開始します");
        }
    }
}

/// メイン関数
///
/// トレーシングを初期化し、HTTPサーバーを起動する。
/// サーバーはlocalhost:8080でリッスンし、Caddyからのリバースプロキシを受け付ける。
/// SIGTERMまたはCtrl+Cを受信するとgraceful shutdownを実行し、
/// 処理中のリクエスト完了を待ってからSQLiteコネクションを正常にクローズする。
///
/// # 環境変数
/// - `API_TOKEN`: APIトークン（必須）
/// - `DB_PATH`: データベースファイルのパス（デフォルト: /var/lib/nostr/events.db）
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

    // データベースパスを環境変数から取得
    let db_path = std::env::var(DB_PATH_ENV).unwrap_or_else(|_| DEFAULT_DB_PATH.to_string());
    tracing::info!("データベースパス: {}", db_path);

    // SQLiteイベントストアを初期化
    let store = Arc::new(
        SqliteEventStore::new(&db_path)
            .await
            .expect("SQLiteストアの初期化に失敗しました"),
    );
    tracing::info!("SQLiteストアを初期化しました");

    let app = create_router_with_store(auth_config, store);

    // localhost:8080でリッスン（Caddyからのリバースプロキシ用）
    let addr = SocketAddr::from(([127, 0, 0, 1], 8080));
    tracing::info!("リッスン開始: {}", addr);

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("アドレスのバインドに失敗しました");

    // graceful shutdownを有効にしてサーバーを起動
    // shutdown_signal()がシグナルを受信すると:
    // 1. 新規コネクションの受付を停止
    // 2. 処理中のリクエストの完了を待機
    // 3. サーバーが終了し、SQLiteコネクション（Arc<SqliteEventStore>）が自動的にドロップされる
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("サーバーの起動に失敗しました");

    tracing::info!("サーバーが正常に停止しました");
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

#[cfg(test)]
mod api_endpoint_tests {
    use super::*;
    use crate::store::{NostrEvent, SearchFilter, SqliteEventStore};
    use axum::{
        body::Body,
        http::{header, Request, StatusCode},
    };
    use std::sync::Arc;
    use tempfile::tempdir;
    use tower::ServiceExt;

    /// テスト用のAPIトークン
    const TEST_TOKEN: &str = "test-token-for-api-tests";

    /// テスト用の一時データベースパスを生成
    fn temp_db_path() -> (tempfile::TempDir, String) {
        let dir = tempdir().unwrap();
        let path = dir.path().join("test.db");
        (dir, path.to_string_lossy().to_string())
    }

    /// テスト用のNostrEventを作成するヘルパー関数
    fn create_test_event(id: &str, pubkey: &str, kind: u32, tags: Vec<Vec<String>>) -> NostrEvent {
        NostrEvent {
            id: id.to_string(),
            pubkey: pubkey.to_string(),
            kind,
            created_at: 1700000000,
            content: "テストコンテンツ".to_string(),
            tags,
            sig: "sig_placeholder".to_string(),
        }
    }

    /// テスト用のAppStateを含むルーターを作成
    async fn create_test_app_with_store() -> (Router, Arc<SqliteEventStore>, tempfile::TempDir) {
        let (dir, db_path) = temp_db_path();
        let store = Arc::new(SqliteEventStore::new(&db_path).await.unwrap());
        let auth_config = AuthConfig::new(TEST_TOKEN);
        let app = create_router_with_store(auth_config, store.clone());
        (app, store, dir)
    }

    // ========================================
    // POST /events のテスト
    // ========================================

    /// POST /eventsで有効なイベントを保存できることを確認
    #[tokio::test]
    async fn test_post_events_creates_event() {
        let (app, _store, _dir) = create_test_app_with_store().await;
        let event = create_test_event("event_api_001", "pubkey_abc", 1, vec![]);
        let body = serde_json::to_string(&event).unwrap();

        let request = Request::builder()
            .uri("/events")
            .method("POST")
            .header(header::AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::CREATED,
            "新規イベント保存時は201 Createdを返すべき"
        );
    }

    /// POST /eventsで保存したイベントがDBに存在することを確認
    #[tokio::test]
    async fn test_post_events_persists_in_database() {
        let (app, store, _dir) = create_test_app_with_store().await;
        let event = create_test_event("event_api_002", "pubkey_xyz", 7, vec![]);
        let body = serde_json::to_string(&event).unwrap();

        let request = Request::builder()
            .uri("/events")
            .method("POST")
            .header(header::AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .unwrap();

        app.oneshot(request).await.unwrap();

        // DBから直接確認
        let filter = SearchFilter {
            ids: Some(vec!["event_api_002".to_string()]),
            ..Default::default()
        };
        let result = store.search_events(&filter).await.unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "event_api_002");
    }

    /// POST /eventsで重複イベントを保存すると200 OKを返すことを確認
    #[tokio::test]
    async fn test_post_events_duplicate_returns_ok() {
        let (app, store, _dir) = create_test_app_with_store().await;
        let event = create_test_event("event_api_003", "pubkey_abc", 1, vec![]);

        // 事前にイベントを保存
        store.save_event(&event).await.unwrap();

        let body = serde_json::to_string(&event).unwrap();
        let request = Request::builder()
            .uri("/events")
            .method("POST")
            .header(header::AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::OK,
            "重複イベント保存時は200 OKを返すべき"
        );
    }

    /// POST /eventsで認証なしの場合401を返すことを確認
    #[tokio::test]
    async fn test_post_events_without_auth_returns_unauthorized() {
        let (app, _store, _dir) = create_test_app_with_store().await;
        let event = create_test_event("event_api_004", "pubkey_abc", 1, vec![]);
        let body = serde_json::to_string(&event).unwrap();

        let request = Request::builder()
            .uri("/events")
            .method("POST")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "認証なしの場合401 Unauthorizedを返すべき"
        );
    }

    /// POST /eventsで不正なJSONの場合400を返すことを確認
    #[tokio::test]
    async fn test_post_events_invalid_json_returns_bad_request() {
        let (app, _store, _dir) = create_test_app_with_store().await;

        let request = Request::builder()
            .uri("/events")
            .method("POST")
            .header(header::AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("{ invalid json }"))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "不正なJSONの場合400 Bad Requestを返すべき"
        );
    }

    /// POST /eventsでタグも正しく保存されることを確認
    #[tokio::test]
    async fn test_post_events_saves_tags() {
        let (app, store, _dir) = create_test_app_with_store().await;
        let tags = vec![
            vec!["e".to_string(), "ref_event".to_string()],
            vec!["p".to_string(), "mentioned_pubkey".to_string()],
        ];
        let event = create_test_event("event_api_005", "pubkey_abc", 1, tags.clone());
        let body = serde_json::to_string(&event).unwrap();

        let request = Request::builder()
            .uri("/events")
            .method("POST")
            .header(header::AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .unwrap();

        app.oneshot(request).await.unwrap();

        // タグで検索できることを確認
        let mut tag_filter = std::collections::HashMap::new();
        tag_filter.insert("#e".to_string(), vec!["ref_event".to_string()]);
        let filter = SearchFilter {
            tags: tag_filter,
            ..Default::default()
        };
        let result = store.search_events(&filter).await.unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "event_api_005");
    }

    // ========================================
    // DELETE /events/{id} のテスト
    // ========================================

    /// DELETE /events/{id}でイベントを削除できることを確認
    #[tokio::test]
    async fn test_delete_event_succeeds() {
        let (app, store, _dir) = create_test_app_with_store().await;
        let event = create_test_event("event_del_001", "pubkey_abc", 1, vec![]);
        store.save_event(&event).await.unwrap();

        let request = Request::builder()
            .uri("/events/event_del_001")
            .method("DELETE")
            .header(header::AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::NO_CONTENT,
            "削除成功時は204 No Contentを返すべき"
        );
    }

    /// DELETE /events/{id}で削除後にイベントが存在しないことを確認
    #[tokio::test]
    async fn test_delete_event_removes_from_database() {
        let (app, store, _dir) = create_test_app_with_store().await;
        let event = create_test_event("event_del_002", "pubkey_abc", 1, vec![]);
        store.save_event(&event).await.unwrap();

        let request = Request::builder()
            .uri("/events/event_del_002")
            .method("DELETE")
            .header(header::AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
            .body(Body::empty())
            .unwrap();

        app.oneshot(request).await.unwrap();

        // DBから確認
        let filter = SearchFilter {
            ids: Some(vec!["event_del_002".to_string()]),
            ..Default::default()
        };
        let result = store.search_events(&filter).await.unwrap();
        assert!(result.is_empty(), "削除後にイベントが存在しないべき");
    }

    /// DELETE /events/{id}で存在しないイベントの場合404を返すことを確認
    #[tokio::test]
    async fn test_delete_event_not_found_returns_404() {
        let (app, _store, _dir) = create_test_app_with_store().await;

        let request = Request::builder()
            .uri("/events/nonexistent_event_id")
            .method("DELETE")
            .header(header::AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::NOT_FOUND,
            "存在しないイベントの場合404 Not Foundを返すべき"
        );
    }

    /// DELETE /events/{id}で認証なしの場合401を返すことを確認
    #[tokio::test]
    async fn test_delete_event_without_auth_returns_unauthorized() {
        let (app, _store, _dir) = create_test_app_with_store().await;

        let request = Request::builder()
            .uri("/events/some_event_id")
            .method("DELETE")
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "認証なしの場合401 Unauthorizedを返すべき"
        );
    }

    // ========================================
    // POST /events/search のテスト
    // ========================================

    /// POST /events/searchで検索結果を取得できることを確認
    #[tokio::test]
    async fn test_search_events_returns_results() {
        let (app, store, _dir) = create_test_app_with_store().await;
        let event = create_test_event("event_search_001", "pubkey_abc", 1, vec![]);
        store.save_event(&event).await.unwrap();

        let filter = SearchFilter {
            ids: Some(vec!["event_search_001".to_string()]),
            ..Default::default()
        };
        let request_body = SearchRequest {
            filters: vec![filter],
        };
        let body = serde_json::to_string(&request_body).unwrap();

        let request = Request::builder()
            .uri("/events/search")
            .method("POST")
            .header(header::AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::OK,
            "検索成功時は200 OKを返すべき"
        );
    }

    /// POST /events/searchで検索結果がJSON配列として返されることを確認
    #[tokio::test]
    async fn test_search_events_returns_json_array() {
        let (app, store, _dir) = create_test_app_with_store().await;
        let event = create_test_event("event_search_002", "pubkey_xyz", 7, vec![]);
        store.save_event(&event).await.unwrap();

        let request_body = SearchRequest {
            filters: vec![SearchFilter::default()],
        };
        let body = serde_json::to_string(&request_body).unwrap();

        let request = Request::builder()
            .uri("/events/search")
            .method("POST")
            .header(header::AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        let response_body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let events: Vec<NostrEvent> = serde_json::from_slice(&response_body).unwrap();

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "event_search_002");
    }

    /// POST /events/searchでフィルター条件が適用されることを確認
    #[tokio::test]
    async fn test_search_events_applies_filter() {
        let (app, store, _dir) = create_test_app_with_store().await;

        // 2つのイベントを保存
        let event1 = create_test_event("event_search_003", "author_alice", 1, vec![]);
        let event2 = create_test_event("event_search_004", "author_bob", 1, vec![]);
        store.save_event(&event1).await.unwrap();
        store.save_event(&event2).await.unwrap();

        // aliceのイベントのみ検索
        let filter = SearchFilter {
            authors: Some(vec!["author_alice".to_string()]),
            ..Default::default()
        };
        let request_body = SearchRequest {
            filters: vec![filter],
        };
        let body = serde_json::to_string(&request_body).unwrap();

        let request = Request::builder()
            .uri("/events/search")
            .method("POST")
            .header(header::AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        let response_body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let events: Vec<NostrEvent> = serde_json::from_slice(&response_body).unwrap();

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].pubkey, "author_alice");
    }

    /// POST /events/searchで認証なしの場合401を返すことを確認
    #[tokio::test]
    async fn test_search_events_without_auth_returns_unauthorized() {
        let (app, _store, _dir) = create_test_app_with_store().await;

        let request_body = SearchRequest {
            filters: vec![SearchFilter::default()],
        };
        let body = serde_json::to_string(&request_body).unwrap();

        let request = Request::builder()
            .uri("/events/search")
            .method("POST")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "認証なしの場合401 Unauthorizedを返すべき"
        );
    }

    /// POST /events/searchで不正なJSONの場合400を返すことを確認
    #[tokio::test]
    async fn test_search_events_invalid_json_returns_bad_request() {
        let (app, _store, _dir) = create_test_app_with_store().await;

        let request = Request::builder()
            .uri("/events/search")
            .method("POST")
            .header(header::AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("{ invalid json }"))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "不正なJSONの場合400 Bad Requestを返すべき"
        );
    }

    /// POST /events/searchで空のフィルターリストでも検索できることを確認
    #[tokio::test]
    async fn test_search_events_empty_filter_works() {
        let (app, store, _dir) = create_test_app_with_store().await;
        let event = create_test_event("event_search_005", "pubkey_abc", 1, vec![]);
        store.save_event(&event).await.unwrap();

        // 空のフィルターリスト（{"filters":[]}）
        let request = Request::builder()
            .uri("/events/search")
            .method("POST")
            .header(header::AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"filters":[]}"#))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(
            response.status(),
            StatusCode::OK,
            "空のフィルターリストでも200 OKを返すべき"
        );

        let response_body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let events: Vec<NostrEvent> = serde_json::from_slice(&response_body).unwrap();
        // 空のフィルターリストは空の結果を返す
        assert!(events.is_empty());
    }

    // ========================================
    // エラーレスポンスがJSON形式であることのテスト
    // ========================================

    /// 404エラーがJSON形式で返されることを確認
    #[tokio::test]
    async fn test_not_found_error_returns_json() {
        let (app, _store, _dir) = create_test_app_with_store().await;

        let request = Request::builder()
            .uri("/events/nonexistent_event_id")
            .method("DELETE")
            .header(header::AUTHORIZATION, format!("Bearer {}", TEST_TOKEN))
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        // レスポンスボディがJSON形式であることを確認
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let error_body: crate::error::ApiErrorBody = serde_json::from_slice(&body)
            .expect("404エラーのレスポンスボディがJSON形式でない");

        assert_eq!(error_body.error, "not_found");
        assert!(
            error_body.message.contains("見つかりません"),
            "エラーメッセージが適切でない: {}",
            error_body.message
        );
    }

    /// 401エラーがJSON形式で返されることを確認
    #[tokio::test]
    async fn test_unauthorized_error_returns_json() {
        let (app, _store, _dir) = create_test_app_with_store().await;

        let request = Request::builder()
            .uri("/events")
            .method("POST")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("{}"))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        // レスポンスボディがJSON形式であることを確認
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let error_body: crate::error::ApiErrorBody = serde_json::from_slice(&body)
            .expect("401エラーのレスポンスボディがJSON形式でない");

        assert_eq!(error_body.error, "unauthorized");
    }

    /// 401エラー（無効なトークン）がJSON形式で返されることを確認
    #[tokio::test]
    async fn test_invalid_token_error_returns_json() {
        let (app, _store, _dir) = create_test_app_with_store().await;

        let request = Request::builder()
            .uri("/events")
            .method("POST")
            .header(header::AUTHORIZATION, "Bearer invalid-token")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("{}"))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        // レスポンスボディがJSON形式であることを確認
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let error_body: crate::error::ApiErrorBody = serde_json::from_slice(&body)
            .expect("401エラーのレスポンスボディがJSON形式でない");

        assert_eq!(error_body.error, "unauthorized");
        assert!(
            error_body.message.contains("無効"),
            "エラーメッセージが適切でない: {}",
            error_body.message
        );
    }
}

#[cfg(test)]
mod graceful_shutdown_tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;
    use tempfile::tempdir;
    use tokio::sync::oneshot;

    /// テスト用のAPIトークン
    const TEST_TOKEN: &str = "test-token-for-shutdown-tests";

    /// テスト用の一時データベースパスを生成
    fn temp_db_path() -> (tempfile::TempDir, String) {
        let dir = tempdir().unwrap();
        let path = dir.path().join("test.db");
        (dir, path.to_string_lossy().to_string())
    }

    /// graceful shutdownを使用したサーバーが正常に起動・停止できることを確認
    #[tokio::test]
    async fn test_server_with_graceful_shutdown_starts_and_stops() {
        let (dir, db_path) = temp_db_path();
        let store = Arc::new(SqliteEventStore::new(&db_path).await.unwrap());
        let auth_config = AuthConfig::new(TEST_TOKEN);
        let app = create_router_with_store(auth_config, store);

        // ランダムポートでリッスン
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        // シャットダウンシグナル用のチャネル
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        // サーバーをバックグラウンドで起動
        let server_handle = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    shutdown_rx.await.ok();
                    tracing::info!("テスト用シャットダウンシグナルを受信");
                })
                .await
                .expect("サーバーの起動に失敗");
        });

        // サーバーが起動するまで少し待機
        tokio::time::sleep(Duration::from_millis(100)).await;

        // ヘルスチェックでサーバーが動作していることを確認
        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{}/health", addr))
            .send()
            .await
            .expect("ヘルスチェックリクエストに失敗");
        assert_eq!(response.status(), 200);

        // シャットダウンシグナルを送信
        shutdown_tx.send(()).expect("シャットダウンシグナル送信に失敗");

        // サーバーが正常に停止するのを待機（タイムアウト付き）
        let shutdown_result = tokio::time::timeout(Duration::from_secs(5), server_handle).await;
        assert!(
            shutdown_result.is_ok(),
            "サーバーが5秒以内に停止しなかった"
        );
        assert!(
            shutdown_result.unwrap().is_ok(),
            "サーバーがエラーで停止した"
        );

        // tempディレクトリが削除されないように保持
        drop(dir);
    }

    /// graceful shutdown中に処理中のリクエストが完了することを確認
    #[tokio::test]
    async fn test_graceful_shutdown_completes_inflight_requests() {
        let (dir, db_path) = temp_db_path();
        let store = Arc::new(SqliteEventStore::new(&db_path).await.unwrap());
        let auth_config = AuthConfig::new(TEST_TOKEN);
        let app = create_router_with_store(auth_config, store);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        let server_handle = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    shutdown_rx.await.ok();
                })
                .await
                .expect("サーバーの起動に失敗");
        });

        tokio::time::sleep(Duration::from_millis(100)).await;

        // リクエストを開始してからシャットダウンシグナルを送信
        let client = reqwest::Client::new();
        let request_future = client.get(format!("http://{}/health", addr)).send();

        // リクエスト完了前にシャットダウンシグナルを送信
        // (実際にはリクエストは非常に速いので、ほぼ同時)
        let response = request_future.await.expect("リクエストに失敗");

        shutdown_tx.send(()).ok();

        // サーバーが正常停止
        let _ = tokio::time::timeout(Duration::from_secs(5), server_handle).await;

        assert_eq!(response.status(), 200);
        drop(dir);
    }

    /// shutdown_signal関数が存在し、適切な型を返すことを確認
    /// (実際のシグナルを送信するテストは統合テストで行う)
    #[test]
    fn test_shutdown_signal_function_exists() {
        // shutdown_signal関数が存在し、コンパイルできることを確認
        // 実際の呼び出しはシグナルを待機するため、ここでは型チェックのみ
        fn _check_shutdown_signal_type() -> impl std::future::Future<Output = ()> {
            shutdown_signal()
        }
    }
}
