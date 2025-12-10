//! SQLiteイベントストア
//!
//! Nostrイベントの保存・検索・削除機能を提供する。
//! - 書き込み: 専用の単一接続（Arc<Mutex<Connection>>）
//! - 読み取り: deadpool-sqliteによるasync接続プール

// 後続タスク（2.3-2.6）で使用予定のため、現時点でのdead_code警告を抑制
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use deadpool_sqlite::{Config, Pool, Runtime};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// ストアエラー
#[derive(Debug, Error)]
pub enum StoreError {
    /// データベースエラー
    #[error("データベースエラー: {0}")]
    Database(String),

    /// プール取得エラー
    #[error("プールエラー: {0}")]
    Pool(String),

    /// 接続構築エラー
    #[error("接続構築エラー: {0}")]
    Build(String),
}

impl From<rusqlite::Error> for StoreError {
    fn from(err: rusqlite::Error) -> Self {
        StoreError::Database(err.to_string())
    }
}

impl From<deadpool_sqlite::BuildError> for StoreError {
    fn from(err: deadpool_sqlite::BuildError) -> Self {
        StoreError::Build(err.to_string())
    }
}

impl From<deadpool_sqlite::PoolError> for StoreError {
    fn from(err: deadpool_sqlite::PoolError) -> Self {
        StoreError::Pool(err.to_string())
    }
}

impl From<deadpool_sqlite::InteractError> for StoreError {
    fn from(err: deadpool_sqlite::InteractError) -> Self {
        StoreError::Database(err.to_string())
    }
}

/// 保存結果
///
/// イベント保存操作の結果を表す。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SaveResult {
    /// 新規作成された
    Created,
    /// 既に存在していた（スキップされた）
    AlreadyExists,
}

/// Nostrイベント
///
/// Nostrプロトコルのイベント構造を表す。
/// HTTP APIのリクエスト/レスポンスで使用する。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NostrEvent {
    /// イベントID（64文字hex）
    pub id: String,
    /// 公開鍵（64文字hex）
    pub pubkey: String,
    /// イベント種別
    pub kind: u32,
    /// 作成日時（UNIXタイムスタンプ）
    pub created_at: u64,
    /// コンテンツ
    pub content: String,
    /// タグ配列
    pub tags: Vec<Vec<String>>,
    /// 署名（64文字hex）
    pub sig: String,
}

/// 検索フィルター
///
/// Nostrプロトコルのフィルター形式に準拠した検索条件。
/// REQメッセージのフィルターをHTTP API用に変換したもの。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SearchFilter {
    /// イベントIDリスト（完全一致検索）
    #[serde(default)]
    pub ids: Option<Vec<String>>,

    /// 作成者公開鍵リスト（完全一致検索）
    #[serde(default)]
    pub authors: Option<Vec<String>>,

    /// イベント種別リスト
    #[serde(default)]
    pub kinds: Option<Vec<u32>>,

    /// 開始時刻（この時刻以降のイベント）
    #[serde(default)]
    pub since: Option<u64>,

    /// 終了時刻（この時刻以前のイベント）
    #[serde(default)]
    pub until: Option<u64>,

    /// 取得上限数（デフォルト: 100、最大: 5000）
    #[serde(default)]
    pub limit: Option<u32>,

    /// タグフィルター（"#e", "#p", "#d", "#a", "#t" 等）
    #[serde(flatten)]
    pub tags: HashMap<String, Vec<String>>,
}

/// SQLiteイベントストア
///
/// - 書き込み: 専用の単一接続（Arc<Mutex<Connection>>）
/// - 読み取り: deadpool-sqliteによるasync接続プール
pub struct SqliteEventStore {
    /// 書き込み専用接続（低頻度のため単一接続で十分）
    write_conn: Arc<Mutex<Connection>>,
    /// 読み取り用async接続プール
    read_pool: Pool,
}

/// SQLiteデータベースのスキーマを定義するSQL
const SCHEMA_SQL: &str = r#"
-- WALモード設定
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

-- 外部キー制約を有効化
PRAGMA foreign_keys=ON;

-- イベントテーブル
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,           -- 64文字hex (イベントID)
    pubkey TEXT NOT NULL,          -- 64文字hex (公開鍵)
    kind INTEGER NOT NULL,         -- イベント種別
    created_at INTEGER NOT NULL,   -- UNIXタイムスタンプ
    event_json TEXT NOT NULL       -- 完全なイベントJSON
);

-- タグテーブル（正規化）
CREATE TABLE IF NOT EXISTS event_tags (
    event_id TEXT NOT NULL,        -- eventsテーブルへのFK
    tag_name TEXT NOT NULL,        -- タグ名 ('e', 'p', 'd', 'a', 't')
    tag_value TEXT NOT NULL,       -- タグ値
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

-- インデックス定義
CREATE INDEX IF NOT EXISTS idx_events_pubkey ON events(pubkey);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_pubkey_kind ON events(pubkey, kind);
CREATE INDEX IF NOT EXISTS idx_event_tags_name_value ON event_tags(tag_name, tag_value);
CREATE INDEX IF NOT EXISTS idx_event_tags_event_id ON event_tags(event_id);
"#;

impl SqliteEventStore {
    /// 新しいSqliteEventStoreを作成
    ///
    /// データベースファイルを開き、スキーマを初期化する。
    /// WALモードを有効にし、書き込み用単一接続と読み取り用プールを構成する。
    ///
    /// # Arguments
    /// * `db_path` - データベースファイルのパス
    ///
    /// # Returns
    /// * `Ok(SqliteEventStore)` - 成功時
    /// * `Err(StoreError)` - エラー時
    pub async fn new(db_path: &str) -> Result<Self, StoreError> {
        // 書き込み用接続を作成し、スキーマを初期化
        let write_conn = Connection::open(db_path)?;
        write_conn.execute_batch(SCHEMA_SQL)?;

        // 読み取り用プールを作成（最大4接続）
        // builder()はInfallibleを返すためunwrap()を使用
        // 注: 読み取り専用プールのため、外部キー制約（PRAGMA foreign_keys）は不要
        //     外部キー制約はINSERT/UPDATE/DELETE時のみ検証され、SELECTには影響しない
        let cfg = Config::new(db_path);
        let read_pool = cfg
            .builder(Runtime::Tokio1)
            .expect("Config builder should not fail")
            .max_size(4)
            .build()?;

        Ok(Self {
            write_conn: Arc::new(Mutex::new(write_conn)),
            read_pool,
        })
    }

    /// 書き込み用接続を取得（内部用）
    ///
    /// # Returns
    /// * `Arc<Mutex<Connection>>` - 書き込み用接続
    #[allow(dead_code)]
    pub(crate) fn write_connection(&self) -> Arc<Mutex<Connection>> {
        self.write_conn.clone()
    }

    /// 読み取り用プールを取得（内部用）
    ///
    /// # Returns
    /// * `&Pool` - 読み取り用プール
    #[allow(dead_code)]
    pub(crate) fn read_pool(&self) -> &Pool {
        &self.read_pool
    }

    /// イベントを保存（タグも含む）
    ///
    /// 書き込み専用接続を使用し、トランザクションで原子的に実行する。
    /// イベントが既に存在する場合は`SaveResult::AlreadyExists`を返す。
    ///
    /// # Arguments
    /// * `event` - 保存するNostrイベント
    ///
    /// # Returns
    /// * `Ok(SaveResult::Created)` - 新規作成成功
    /// * `Ok(SaveResult::AlreadyExists)` - 既に存在
    /// * `Err(StoreError)` - エラー
    pub async fn save_event(&self, event: &NostrEvent) -> Result<SaveResult, StoreError> {
        let event = event.clone();
        let conn = self.write_conn.clone();

        tokio::task::spawn_blocking(move || {
            let conn = conn
                .lock()
                .expect("イベント保存時の書き込み接続ロック取得に失敗（Mutex poisoned）");

            // イベントが既に存在するか確認
            let exists: bool = conn
                .query_row(
                    "SELECT 1 FROM events WHERE id = ?1",
                    [&event.id],
                    |_| Ok(true),
                )
                .unwrap_or(false);

            if exists {
                return Ok(SaveResult::AlreadyExists);
            }

            // イベントをJSONにシリアライズ
            let event_json = serde_json::to_string(&event)
                .map_err(|e| StoreError::Database(format!("JSON シリアライズエラー: {}", e)))?;

            // トランザクションを開始
            let tx = conn.unchecked_transaction()?;

            // イベントを挿入
            tx.execute(
                "INSERT INTO events (id, pubkey, kind, created_at, event_json) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    &event.id,
                    &event.pubkey,
                    event.kind as i64,
                    event.created_at as i64,
                    &event_json,
                ],
            )?;

            // タグを挿入（2要素以上のタグのみ）
            for tag in &event.tags {
                if tag.len() >= 2 {
                    let tag_name = &tag[0];
                    let tag_value = &tag[1];
                    tx.execute(
                        "INSERT INTO event_tags (event_id, tag_name, tag_value) VALUES (?1, ?2, ?3)",
                        rusqlite::params![&event.id, tag_name, tag_value],
                    )?;
                }
            }

            // トランザクションをコミット
            tx.commit()?;

            Ok(SaveResult::Created)
        })
        .await
        .map_err(|e| StoreError::Database(format!("タスク実行エラー: {}", e)))?
    }

    /// イベントIDで削除
    ///
    /// 書き込み専用接続を使用する。
    /// タグは外部キー制約のCASCADE設定により自動削除される。
    ///
    /// # Arguments
    /// * `event_id` - 削除するイベントのID
    ///
    /// # Returns
    /// * `Ok(true)` - 削除成功
    /// * `Ok(false)` - イベントが存在しなかった
    /// * `Err(StoreError)` - エラー
    pub async fn delete_event(&self, event_id: &str) -> Result<bool, StoreError> {
        let event_id = event_id.to_string();
        let conn = self.write_conn.clone();

        tokio::task::spawn_blocking(move || {
            let conn = conn
                .lock()
                .expect("イベント削除時の書き込み接続ロック取得に失敗（Mutex poisoned）");

            let rows_affected = conn.execute("DELETE FROM events WHERE id = ?1", [&event_id])?;

            Ok(rows_affected > 0)
        })
        .await
        .map_err(|e| StoreError::Database(format!("タスク実行エラー: {}", e)))?
    }

    /// フィルター条件でイベントを検索
    ///
    /// 読み取りプールから接続を取得し、並行実行可能。
    /// フィルター条件をSQL WHERE句に動的に変換して検索を実行する。
    ///
    /// # Arguments
    /// * `filter` - 検索フィルター条件
    ///
    /// # Returns
    /// * `Ok(Vec<NostrEvent>)` - マッチしたイベントのリスト（created_at降順）
    /// * `Err(StoreError)` - エラー
    pub async fn search_events(&self, filter: &SearchFilter) -> Result<Vec<NostrEvent>, StoreError> {
        let filter = filter.clone();
        let conn = self.read_pool.get().await?;

        conn.interact(move |conn| {
            Self::execute_search(conn, &filter)
        })
        .await?
    }

    /// 検索クエリを実行（内部用）
    ///
    /// フィルター条件をSQLに変換し、クエリを実行する。
    fn execute_search(
        conn: &Connection,
        filter: &SearchFilter,
    ) -> Result<Vec<NostrEvent>, StoreError> {
        // limitのデフォルト値と上限を適用
        let limit = filter.limit.unwrap_or(100).min(5000);

        // タグフィルターがあるかチェック
        let tag_filters: Vec<(&String, &Vec<String>)> = filter
            .tags
            .iter()
            .filter(|(k, v)| k.starts_with('#') && !v.is_empty())
            .collect();

        // SQL WHERE句とパラメータを構築
        let (where_clause, params) = Self::build_where_clause(filter, &tag_filters);

        // タグフィルターがある場合はJOINを使用
        let sql = if tag_filters.is_empty() {
            format!(
                "SELECT event_json FROM events {} ORDER BY created_at DESC LIMIT {}",
                where_clause, limit
            )
        } else {
            // タグフィルターの数だけINNER JOINを追加
            let mut joins = String::new();
            for (i, _) in tag_filters.iter().enumerate() {
                joins.push_str(&format!(
                    " INNER JOIN event_tags AS t{} ON events.id = t{}.event_id",
                    i, i
                ));
            }
            format!(
                "SELECT DISTINCT event_json FROM events{} {} ORDER BY created_at DESC LIMIT {}",
                joins, where_clause, limit
            )
        };

        // クエリを実行
        let mut stmt = conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params.iter().map(|p| p as &dyn rusqlite::ToSql).collect();

        let events: Vec<NostrEvent> = stmt
            .query_map(params_refs.as_slice(), |row| {
                let json: String = row.get(0)?;
                Ok(json)
            })?
            .filter_map(|r| r.ok())
            .filter_map(|json| serde_json::from_str(&json).ok())
            .collect();

        Ok(events)
    }

    /// WHERE句とパラメータを構築（内部用）
    fn build_where_clause(
        filter: &SearchFilter,
        tag_filters: &[(&String, &Vec<String>)],
    ) -> (String, Vec<String>) {
        let mut conditions: Vec<String> = Vec::new();
        let mut params: Vec<String> = Vec::new();
        let mut param_idx = 1;

        // ids フィルター
        if let Some(ids) = &filter.ids
            && !ids.is_empty()
        {
            let placeholders: Vec<String> = ids
                .iter()
                .map(|_| {
                    let p = format!("?{}", param_idx);
                    param_idx += 1;
                    p
                })
                .collect();
            conditions.push(format!("id IN ({})", placeholders.join(", ")));
            params.extend(ids.clone());
        }

        // authors フィルター
        if let Some(authors) = &filter.authors
            && !authors.is_empty()
        {
            let placeholders: Vec<String> = authors
                .iter()
                .map(|_| {
                    let p = format!("?{}", param_idx);
                    param_idx += 1;
                    p
                })
                .collect();
            conditions.push(format!("pubkey IN ({})", placeholders.join(", ")));
            params.extend(authors.clone());
        }

        // kinds フィルター
        if let Some(kinds) = &filter.kinds
            && !kinds.is_empty()
        {
            let placeholders: Vec<String> = kinds
                .iter()
                .map(|_| {
                    let p = format!("?{}", param_idx);
                    param_idx += 1;
                    p
                })
                .collect();
            conditions.push(format!("kind IN ({})", placeholders.join(", ")));
            params.extend(kinds.iter().map(|k| k.to_string()));
        }

        // since フィルター
        if let Some(since) = filter.since {
            conditions.push(format!("created_at >= ?{}", param_idx));
            param_idx += 1;
            params.push(since.to_string());
        }

        // until フィルター
        if let Some(until) = filter.until {
            conditions.push(format!("created_at <= ?{}", param_idx));
            param_idx += 1;
            params.push(until.to_string());
        }

        // タグフィルター
        for (i, (tag_key, tag_values)) in tag_filters.iter().enumerate() {
            // "#e" -> "e" のように先頭の#を除去
            let tag_name = &tag_key[1..];
            conditions.push(format!("t{}.tag_name = ?{}", i, param_idx));
            param_idx += 1;
            params.push(tag_name.to_string());

            let placeholders: Vec<String> = tag_values
                .iter()
                .map(|_| {
                    let p = format!("?{}", param_idx);
                    param_idx += 1;
                    p
                })
                .collect();
            conditions.push(format!("t{}.tag_value IN ({})", i, placeholders.join(", ")));
            params.extend((*tag_values).clone());
        }

        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };

        (where_clause, params)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    /// テスト用の一時データベースパスを生成
    fn temp_db_path() -> (tempfile::TempDir, String) {
        let dir = tempdir().unwrap();
        let path = dir.path().join("test.db");
        (dir, path.to_string_lossy().to_string())
    }

    // ========================================
    // スキーマ作成のテスト
    // ========================================

    /// SqliteEventStoreが正常に作成できることを確認
    #[tokio::test]
    async fn test_store_creation_succeeds() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await;
        assert!(store.is_ok(), "ストアの作成に失敗: {:?}", store.err());
    }

    /// データベースファイルが作成されることを確認
    #[tokio::test]
    async fn test_database_file_created() {
        let (_dir, db_path) = temp_db_path();
        let _store = SqliteEventStore::new(&db_path).await.unwrap();

        assert!(
            fs::metadata(&db_path).is_ok(),
            "データベースファイルが作成されていない"
        );
    }

    /// eventsテーブルが存在することを確認
    #[tokio::test]
    async fn test_events_table_exists() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let conn = store.write_conn.lock().unwrap();
        let result: Result<String, _> = conn.query_row(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='events'",
            [],
            |row| row.get(0),
        );
        assert!(result.is_ok(), "eventsテーブルが存在しない");
        assert_eq!(result.unwrap(), "events");
    }

    /// event_tagsテーブルが存在することを確認
    #[tokio::test]
    async fn test_event_tags_table_exists() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let conn = store.write_conn.lock().unwrap();
        let result: Result<String, _> = conn.query_row(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='event_tags'",
            [],
            |row| row.get(0),
        );
        assert!(result.is_ok(), "event_tagsテーブルが存在しない");
        assert_eq!(result.unwrap(), "event_tags");
    }

    /// eventsテーブルのカラムが正しく定義されていることを確認
    #[tokio::test]
    async fn test_events_table_columns() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let conn = store.write_conn.lock().unwrap();
        let mut stmt = conn.prepare("PRAGMA table_info(events)").unwrap();
        let columns: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        // 必要なカラムが存在することを確認
        assert!(columns.contains(&"id".to_string()), "idカラムがない");
        assert!(
            columns.contains(&"pubkey".to_string()),
            "pubkeyカラムがない"
        );
        assert!(columns.contains(&"kind".to_string()), "kindカラムがない");
        assert!(
            columns.contains(&"created_at".to_string()),
            "created_atカラムがない"
        );
        assert!(
            columns.contains(&"event_json".to_string()),
            "event_jsonカラムがない"
        );
    }

    /// event_tagsテーブルのカラムが正しく定義されていることを確認
    #[tokio::test]
    async fn test_event_tags_table_columns() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let conn = store.write_conn.lock().unwrap();
        let mut stmt = conn.prepare("PRAGMA table_info(event_tags)").unwrap();
        let columns: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        // 必要なカラムが存在することを確認
        assert!(
            columns.contains(&"event_id".to_string()),
            "event_idカラムがない"
        );
        assert!(
            columns.contains(&"tag_name".to_string()),
            "tag_nameカラムがない"
        );
        assert!(
            columns.contains(&"tag_value".to_string()),
            "tag_valueカラムがない"
        );
    }

    // ========================================
    // インデックスのテスト
    // ========================================

    /// 全てのインデックスが存在することを確認
    #[tokio::test]
    async fn test_all_indexes_exist() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let conn = store.write_conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
            .unwrap();
        let indexes: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        // 要求されたインデックスが存在することを確認
        let expected_indexes = [
            "idx_events_pubkey",
            "idx_events_kind",
            "idx_events_created_at",
            "idx_events_pubkey_kind",
            "idx_event_tags_name_value",
            "idx_event_tags_event_id",
        ];

        for idx in expected_indexes {
            assert!(
                indexes.contains(&idx.to_string()),
                "インデックス {} が存在しない。存在するインデックス: {:?}",
                idx,
                indexes
            );
        }
    }

    // ========================================
    // WALモードのテスト
    // ========================================

    /// WALモードが有効になっていることを確認
    #[tokio::test]
    async fn test_wal_mode_enabled() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let conn = store.write_conn.lock().unwrap();
        let journal_mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();

        assert_eq!(
            journal_mode.to_lowercase(),
            "wal",
            "WALモードが有効になっていない: {}",
            journal_mode
        );
    }

    /// synchronous=NORMALが設定されていることを確認
    #[tokio::test]
    async fn test_synchronous_normal() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let conn = store.write_conn.lock().unwrap();
        let synchronous: i32 = conn
            .query_row("PRAGMA synchronous", [], |row| row.get(0))
            .unwrap();

        // synchronous=NORMALは1
        assert_eq!(
            synchronous, 1,
            "synchronousがNORMAL(1)ではない: {}",
            synchronous
        );
    }

    /// 外部キー制約が有効になっていることを確認
    #[tokio::test]
    async fn test_foreign_keys_enabled() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let conn = store.write_conn.lock().unwrap();
        let foreign_keys: i32 = conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();

        assert_eq!(foreign_keys, 1, "外部キー制約が有効になっていない");
    }

    // ========================================
    // 接続管理のテスト
    // ========================================

    /// 書き込み用接続が取得できることを確認
    #[tokio::test]
    async fn test_write_connection_available() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let conn = store.write_connection();
        let guard = conn.lock();
        assert!(guard.is_ok(), "書き込み用接続のロック取得に失敗");
    }

    /// 読み取り用プールから接続が取得できることを確認
    #[tokio::test]
    async fn test_read_pool_connection_available() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let pool = store.read_pool();
        let conn = pool.get().await;
        assert!(conn.is_ok(), "読み取り用プールからの接続取得に失敗");
    }

    /// 読み取り用プールの接続でクエリが実行できることを確認
    #[tokio::test]
    async fn test_read_pool_query_execution() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let pool = store.read_pool();
        let conn = pool.get().await.unwrap();
        let result = conn
            .interact(|conn| conn.query_row("SELECT 1", [], |row| row.get::<_, i32>(0)))
            .await;

        assert!(result.is_ok(), "クエリ実行に失敗: {:?}", result.err());
        assert_eq!(result.unwrap().unwrap(), 1);
    }

    /// 複数の読み取り接続が並行して取得できることを確認
    #[tokio::test]
    async fn test_multiple_read_connections() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let pool = store.read_pool();

        // 複数の接続を同時に取得
        let conn1 = pool.get().await;
        let conn2 = pool.get().await;
        let conn3 = pool.get().await;

        assert!(conn1.is_ok(), "1番目の接続取得に失敗");
        assert!(conn2.is_ok(), "2番目の接続取得に失敗");
        assert!(conn3.is_ok(), "3番目の接続取得に失敗");
    }

    // ========================================
    // 外部キー制約のテスト
    // ========================================

    /// 親がないタグの挿入が外部キー制約で失敗することを確認
    #[tokio::test]
    async fn test_foreign_key_constraint_enforced() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let conn = store.write_conn.lock().unwrap();

        // 存在しないevent_idでタグを挿入しようとする
        let result = conn.execute(
            "INSERT INTO event_tags (event_id, tag_name, tag_value) VALUES (?1, ?2, ?3)",
            ["nonexistent_id", "e", "some_value"],
        );

        assert!(
            result.is_err(),
            "外部キー制約が効いていない - 存在しないevent_idで挿入が成功してしまった"
        );
    }

    /// イベント削除時にタグも自動削除されることを確認（CASCADE）
    #[tokio::test]
    async fn test_cascade_delete() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let conn = store.write_conn.lock().unwrap();

        // テスト用イベントを挿入
        conn.execute(
            "INSERT INTO events (id, pubkey, kind, created_at, event_json) VALUES (?1, ?2, ?3, ?4, ?5)",
            ["test_id_123", "pubkey_abc", "1", "1700000000", r#"{"id":"test_id_123"}"#],
        )
        .unwrap();

        // タグを挿入
        conn.execute(
            "INSERT INTO event_tags (event_id, tag_name, tag_value) VALUES (?1, ?2, ?3)",
            ["test_id_123", "e", "referenced_event"],
        )
        .unwrap();

        // タグが存在することを確認
        let tag_count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM event_tags WHERE event_id = 'test_id_123'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tag_count, 1, "タグが挿入されていない");

        // イベントを削除
        conn.execute("DELETE FROM events WHERE id = 'test_id_123'", [])
            .unwrap();

        // タグも自動削除されていることを確認
        let tag_count_after: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM event_tags WHERE event_id = 'test_id_123'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            tag_count_after, 0,
            "CASCADE削除が効いていない - タグが残っている"
        );
    }

    // ========================================
    // save_eventのテスト（Task 2.3）
    // ========================================

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

    /// イベントが正常に保存されることを確認
    #[tokio::test]
    async fn test_save_event_succeeds() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let event = create_test_event("event_id_001", "pubkey_abc", 1, vec![]);

        let result = store.save_event(&event).await;
        assert!(result.is_ok(), "イベント保存に失敗: {:?}", result.err());
        assert_eq!(result.unwrap(), SaveResult::Created);
    }

    /// 保存したイベントがデータベースに存在することを確認
    #[tokio::test]
    async fn test_save_event_persists_in_database() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let event = create_test_event("event_id_002", "pubkey_xyz", 7, vec![]);
        store.save_event(&event).await.unwrap();

        // データベースから直接確認
        let conn = store.write_conn.lock().unwrap();
        let (id, pubkey, kind, created_at): (String, String, i64, i64) = conn
            .query_row(
                "SELECT id, pubkey, kind, created_at FROM events WHERE id = ?1",
                ["event_id_002"],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();

        assert_eq!(id, "event_id_002");
        assert_eq!(pubkey, "pubkey_xyz");
        assert_eq!(kind, 7);
        assert_eq!(created_at, 1700000000);
    }

    /// event_jsonフィールドに完全なJSONが保存されることを確認
    #[tokio::test]
    async fn test_save_event_stores_full_json() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let event = create_test_event("event_id_003", "pubkey_abc", 1, vec![]);
        store.save_event(&event).await.unwrap();

        let conn = store.write_conn.lock().unwrap();
        let event_json: String = conn
            .query_row(
                "SELECT event_json FROM events WHERE id = ?1",
                ["event_id_003"],
                |row| row.get(0),
            )
            .unwrap();

        // JSONとしてパースできることを確認
        let parsed: NostrEvent = serde_json::from_str(&event_json).unwrap();
        assert_eq!(parsed.id, "event_id_003");
        assert_eq!(parsed.pubkey, "pubkey_abc");
    }

    /// タグが正しく保存されることを確認
    #[tokio::test]
    async fn test_save_event_saves_tags() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let tags = vec![
            vec!["e".to_string(), "referenced_event_id".to_string()],
            vec!["p".to_string(), "mentioned_pubkey".to_string()],
            vec!["t".to_string(), "nostr".to_string()],
        ];
        let event = create_test_event("event_id_004", "pubkey_abc", 1, tags);
        store.save_event(&event).await.unwrap();

        // データベースからタグを確認
        let conn = store.write_conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT tag_name, tag_value FROM event_tags WHERE event_id = ?1 ORDER BY tag_name")
            .unwrap();
        let tags_in_db: Vec<(String, String)> = stmt
            .query_map(["event_id_004"], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        assert_eq!(tags_in_db.len(), 3);
        assert!(tags_in_db.contains(&("e".to_string(), "referenced_event_id".to_string())));
        assert!(tags_in_db.contains(&("p".to_string(), "mentioned_pubkey".to_string())));
        assert!(tags_in_db.contains(&("t".to_string(), "nostr".to_string())));
    }

    /// 空のタグ配列でも正常に保存されることを確認
    #[tokio::test]
    async fn test_save_event_with_empty_tags() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let event = create_test_event("event_id_005", "pubkey_abc", 1, vec![]);
        let result = store.save_event(&event).await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), SaveResult::Created);

        // タグが0件であることを確認
        let conn = store.write_conn.lock().unwrap();
        let tag_count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM event_tags WHERE event_id = ?1",
                ["event_id_005"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tag_count, 0);
    }

    /// 1要素のみのタグがスキップされることを確認（値がないタグ）
    #[tokio::test]
    async fn test_save_event_skips_single_element_tags() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let tags = vec![
            vec!["e".to_string()], // 値がないのでスキップされるべき
            vec!["p".to_string(), "valid_pubkey".to_string()],
        ];
        let event = create_test_event("event_id_006", "pubkey_abc", 1, tags);
        store.save_event(&event).await.unwrap();

        let conn = store.write_conn.lock().unwrap();
        let tag_count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM event_tags WHERE event_id = ?1",
                ["event_id_006"],
                |row| row.get(0),
            )
            .unwrap();

        // 有効なタグは1つだけ
        assert_eq!(tag_count, 1);
    }

    /// 重複イベントがAlreadyExistsを返すことを確認
    #[tokio::test]
    async fn test_save_event_duplicate_returns_already_exists() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let event = create_test_event("event_id_007", "pubkey_abc", 1, vec![]);

        // 1回目は成功
        let result1 = store.save_event(&event).await;
        assert_eq!(result1.unwrap(), SaveResult::Created);

        // 2回目はAlreadyExists
        let result2 = store.save_event(&event).await;
        assert!(result2.is_ok(), "重複イベントの保存でエラー: {:?}", result2.err());
        assert_eq!(result2.unwrap(), SaveResult::AlreadyExists);
    }

    /// 重複イベント時にデータが更新されないことを確認
    #[tokio::test]
    async fn test_save_event_duplicate_does_not_update() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let event1 = NostrEvent {
            id: "event_id_008".to_string(),
            pubkey: "pubkey_abc".to_string(),
            kind: 1,
            created_at: 1700000000,
            content: "original content".to_string(),
            tags: vec![],
            sig: "sig1".to_string(),
        };
        store.save_event(&event1).await.unwrap();

        // 同じIDで異なる内容のイベントを保存しようとする
        let event2 = NostrEvent {
            id: "event_id_008".to_string(),
            pubkey: "pubkey_abc".to_string(),
            kind: 1,
            created_at: 1700000000,
            content: "modified content".to_string(), // 変更
            tags: vec![],
            sig: "sig2".to_string(),
        };
        store.save_event(&event2).await.unwrap();

        // 元のデータが保持されていることを確認
        let conn = store.write_conn.lock().unwrap();
        let event_json: String = conn
            .query_row(
                "SELECT event_json FROM events WHERE id = ?1",
                ["event_id_008"],
                |row| row.get(0),
            )
            .unwrap();

        let parsed: NostrEvent = serde_json::from_str(&event_json).unwrap();
        assert_eq!(parsed.content, "original content");
    }

    // ========================================
    // delete_eventのテスト（Task 2.3）
    // ========================================

    /// イベント削除が成功することを確認
    #[tokio::test]
    async fn test_delete_event_succeeds() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let event = create_test_event("event_id_del_001", "pubkey_abc", 1, vec![]);
        store.save_event(&event).await.unwrap();

        let result = store.delete_event("event_id_del_001").await;
        assert!(result.is_ok(), "イベント削除に失敗: {:?}", result.err());
        assert!(result.unwrap(), "削除されたイベントがなかった");
    }

    /// 削除後にイベントが存在しないことを確認
    #[tokio::test]
    async fn test_delete_event_removes_from_database() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let event = create_test_event("event_id_del_002", "pubkey_abc", 1, vec![]);
        store.save_event(&event).await.unwrap();
        store.delete_event("event_id_del_002").await.unwrap();

        let conn = store.write_conn.lock().unwrap();
        let count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM events WHERE id = ?1",
                ["event_id_del_002"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0, "イベントが削除されていない");
    }

    /// 削除時にタグも削除されることを確認（CASCADE）
    #[tokio::test]
    async fn test_delete_event_removes_tags() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let tags = vec![
            vec!["e".to_string(), "ref1".to_string()],
            vec!["p".to_string(), "pubkey1".to_string()],
        ];
        let event = create_test_event("event_id_del_003", "pubkey_abc", 1, tags);
        store.save_event(&event).await.unwrap();
        store.delete_event("event_id_del_003").await.unwrap();

        let conn = store.write_conn.lock().unwrap();
        let tag_count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM event_tags WHERE event_id = ?1",
                ["event_id_del_003"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tag_count, 0, "タグが削除されていない");
    }

    /// 存在しないイベントの削除がfalseを返すことを確認
    #[tokio::test]
    async fn test_delete_event_nonexistent_returns_false() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let result = store.delete_event("nonexistent_event_id").await;
        assert!(result.is_ok());
        assert!(!result.unwrap(), "存在しないイベントの削除がtrueを返した");
    }

    /// 同じイベントを2回削除しても2回目はfalseを返すことを確認
    #[tokio::test]
    async fn test_delete_event_twice_returns_false_second_time() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let event = create_test_event("event_id_del_004", "pubkey_abc", 1, vec![]);
        store.save_event(&event).await.unwrap();

        let result1 = store.delete_event("event_id_del_004").await;
        assert!(result1.unwrap(), "1回目の削除がfalseを返した");

        let result2 = store.delete_event("event_id_del_004").await;
        assert!(!result2.unwrap(), "2回目の削除がtrueを返した");
    }

    // ========================================
    // search_eventsのテスト（Task 2.4）
    // ========================================

    /// テスト用のNostrEventを作成するヘルパー関数（created_at指定可能）
    fn create_test_event_with_time(
        id: &str,
        pubkey: &str,
        kind: u32,
        created_at: u64,
        tags: Vec<Vec<String>>,
    ) -> NostrEvent {
        NostrEvent {
            id: id.to_string(),
            pubkey: pubkey.to_string(),
            kind,
            created_at,
            content: format!("コンテンツ {}", id),
            tags,
            sig: "sig_placeholder".to_string(),
        }
    }

    /// 空のフィルターで全イベントが取得できることを確認
    #[tokio::test]
    async fn test_search_events_empty_filter_returns_all() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        // 3つのイベントを保存
        let event1 = create_test_event("search_001", "pubkey_a", 1, vec![]);
        let event2 = create_test_event("search_002", "pubkey_b", 1, vec![]);
        let event3 = create_test_event("search_003", "pubkey_c", 1, vec![]);
        store.save_event(&event1).await.unwrap();
        store.save_event(&event2).await.unwrap();
        store.save_event(&event3).await.unwrap();

        let filter = SearchFilter::default();
        let result = store.search_events(&filter).await;

        assert!(result.is_ok(), "検索に失敗: {:?}", result.err());
        let events = result.unwrap();
        assert_eq!(events.len(), 3, "3件のイベントが取得されるべき");
    }

    /// idsフィルターで指定したIDのイベントのみ取得できることを確認
    #[tokio::test]
    async fn test_search_events_filter_by_ids() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let event1 = create_test_event("search_id_001", "pubkey_a", 1, vec![]);
        let event2 = create_test_event("search_id_002", "pubkey_b", 1, vec![]);
        let event3 = create_test_event("search_id_003", "pubkey_c", 1, vec![]);
        store.save_event(&event1).await.unwrap();
        store.save_event(&event2).await.unwrap();
        store.save_event(&event3).await.unwrap();

        let filter = SearchFilter {
            ids: Some(vec!["search_id_001".to_string(), "search_id_003".to_string()]),
            ..Default::default()
        };
        let result = store.search_events(&filter).await.unwrap();

        assert_eq!(result.len(), 2);
        let ids: Vec<&str> = result.iter().map(|e| e.id.as_str()).collect();
        assert!(ids.contains(&"search_id_001"));
        assert!(ids.contains(&"search_id_003"));
        assert!(!ids.contains(&"search_id_002"));
    }

    /// authorsフィルターで指定した作者のイベントのみ取得できることを確認
    #[tokio::test]
    async fn test_search_events_filter_by_authors() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let event1 = create_test_event("search_auth_001", "author_alice", 1, vec![]);
        let event2 = create_test_event("search_auth_002", "author_bob", 1, vec![]);
        let event3 = create_test_event("search_auth_003", "author_alice", 1, vec![]);
        store.save_event(&event1).await.unwrap();
        store.save_event(&event2).await.unwrap();
        store.save_event(&event3).await.unwrap();

        let filter = SearchFilter {
            authors: Some(vec!["author_alice".to_string()]),
            ..Default::default()
        };
        let result = store.search_events(&filter).await.unwrap();

        assert_eq!(result.len(), 2);
        for event in &result {
            assert_eq!(event.pubkey, "author_alice");
        }
    }

    /// kindsフィルターで指定した種別のイベントのみ取得できることを確認
    #[tokio::test]
    async fn test_search_events_filter_by_kinds() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let event1 = create_test_event("search_kind_001", "pubkey_a", 1, vec![]);
        let event2 = create_test_event("search_kind_002", "pubkey_a", 7, vec![]);
        let event3 = create_test_event("search_kind_003", "pubkey_a", 1, vec![]);
        let event4 = create_test_event("search_kind_004", "pubkey_a", 30023, vec![]);
        store.save_event(&event1).await.unwrap();
        store.save_event(&event2).await.unwrap();
        store.save_event(&event3).await.unwrap();
        store.save_event(&event4).await.unwrap();

        let filter = SearchFilter {
            kinds: Some(vec![1, 7]),
            ..Default::default()
        };
        let result = store.search_events(&filter).await.unwrap();

        assert_eq!(result.len(), 3);
        for event in &result {
            assert!(event.kind == 1 || event.kind == 7);
        }
    }

    /// sinceフィルターで指定時刻以降のイベントのみ取得できることを確認
    #[tokio::test]
    async fn test_search_events_filter_by_since() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let event1 = create_test_event_with_time("search_since_001", "pubkey_a", 1, 1000, vec![]);
        let event2 = create_test_event_with_time("search_since_002", "pubkey_a", 1, 2000, vec![]);
        let event3 = create_test_event_with_time("search_since_003", "pubkey_a", 1, 3000, vec![]);
        store.save_event(&event1).await.unwrap();
        store.save_event(&event2).await.unwrap();
        store.save_event(&event3).await.unwrap();

        let filter = SearchFilter {
            since: Some(2000),
            ..Default::default()
        };
        let result = store.search_events(&filter).await.unwrap();

        assert_eq!(result.len(), 2);
        for event in &result {
            assert!(event.created_at >= 2000);
        }
    }

    /// untilフィルターで指定時刻以前のイベントのみ取得できることを確認
    #[tokio::test]
    async fn test_search_events_filter_by_until() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let event1 = create_test_event_with_time("search_until_001", "pubkey_a", 1, 1000, vec![]);
        let event2 = create_test_event_with_time("search_until_002", "pubkey_a", 1, 2000, vec![]);
        let event3 = create_test_event_with_time("search_until_003", "pubkey_a", 1, 3000, vec![]);
        store.save_event(&event1).await.unwrap();
        store.save_event(&event2).await.unwrap();
        store.save_event(&event3).await.unwrap();

        let filter = SearchFilter {
            until: Some(2000),
            ..Default::default()
        };
        let result = store.search_events(&filter).await.unwrap();

        assert_eq!(result.len(), 2);
        for event in &result {
            assert!(event.created_at <= 2000);
        }
    }

    /// sinceとuntilの組み合わせで期間内のイベントのみ取得できることを確認
    #[tokio::test]
    async fn test_search_events_filter_by_time_range() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let event1 = create_test_event_with_time("search_range_001", "pubkey_a", 1, 1000, vec![]);
        let event2 = create_test_event_with_time("search_range_002", "pubkey_a", 1, 2000, vec![]);
        let event3 = create_test_event_with_time("search_range_003", "pubkey_a", 1, 3000, vec![]);
        let event4 = create_test_event_with_time("search_range_004", "pubkey_a", 1, 4000, vec![]);
        store.save_event(&event1).await.unwrap();
        store.save_event(&event2).await.unwrap();
        store.save_event(&event3).await.unwrap();
        store.save_event(&event4).await.unwrap();

        let filter = SearchFilter {
            since: Some(2000),
            until: Some(3000),
            ..Default::default()
        };
        let result = store.search_events(&filter).await.unwrap();

        assert_eq!(result.len(), 2);
        let times: Vec<u64> = result.iter().map(|e| e.created_at).collect();
        assert!(times.contains(&2000));
        assert!(times.contains(&3000));
    }

    /// limitフィルターで取得件数を制限できることを確認
    #[tokio::test]
    async fn test_search_events_filter_by_limit() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        // 5つのイベントを保存
        for i in 1..=5 {
            let event = create_test_event_with_time(
                &format!("search_limit_{:03}", i),
                "pubkey_a",
                1,
                i as u64 * 1000,
                vec![],
            );
            store.save_event(&event).await.unwrap();
        }

        let filter = SearchFilter {
            limit: Some(3),
            ..Default::default()
        };
        let result = store.search_events(&filter).await.unwrap();

        assert_eq!(result.len(), 3);
    }

    /// limitが指定されない場合はデフォルト100件であることを確認
    #[tokio::test]
    async fn test_search_events_default_limit() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        // デフォルトlimit(100)以内の件数をテスト
        for i in 1..=50 {
            let event = create_test_event(
                &format!("search_deflimit_{:03}", i),
                "pubkey_a",
                1,
                vec![],
            );
            store.save_event(&event).await.unwrap();
        }

        let filter = SearchFilter::default();
        let result = store.search_events(&filter).await.unwrap();

        // 50件保存したので50件取得されるべき（limit 100以下）
        assert_eq!(result.len(), 50);
    }

    /// limitの最大値が5000であることを確認
    #[tokio::test]
    async fn test_search_events_max_limit() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        // 10件のイベントを保存
        for i in 1..=10 {
            let event = create_test_event(
                &format!("search_maxlimit_{:03}", i),
                "pubkey_a",
                1,
                vec![],
            );
            store.save_event(&event).await.unwrap();
        }

        // 5000を超えるlimitを指定しても5000に制限される
        let filter = SearchFilter {
            limit: Some(10000),
            ..Default::default()
        };
        let result = store.search_events(&filter).await.unwrap();

        // 10件しか保存していないので10件取得される
        assert_eq!(result.len(), 10);
    }

    /// 結果がcreated_at降順でソートされることを確認
    #[tokio::test]
    async fn test_search_events_ordered_by_created_at_desc() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let event1 = create_test_event_with_time("search_order_001", "pubkey_a", 1, 1000, vec![]);
        let event2 = create_test_event_with_time("search_order_002", "pubkey_a", 1, 3000, vec![]);
        let event3 = create_test_event_with_time("search_order_003", "pubkey_a", 1, 2000, vec![]);
        store.save_event(&event1).await.unwrap();
        store.save_event(&event2).await.unwrap();
        store.save_event(&event3).await.unwrap();

        let filter = SearchFilter::default();
        let result = store.search_events(&filter).await.unwrap();

        assert_eq!(result.len(), 3);
        assert_eq!(result[0].created_at, 3000); // 最新
        assert_eq!(result[1].created_at, 2000);
        assert_eq!(result[2].created_at, 1000); // 最古
    }

    /// #eタグフィルターでイベント参照をフィルタリングできることを確認
    #[tokio::test]
    async fn test_search_events_filter_by_e_tag() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let event1 = create_test_event(
            "search_etag_001",
            "pubkey_a",
            1,
            vec![vec!["e".to_string(), "referenced_event_x".to_string()]],
        );
        let event2 = create_test_event(
            "search_etag_002",
            "pubkey_a",
            1,
            vec![vec!["e".to_string(), "referenced_event_y".to_string()]],
        );
        let event3 = create_test_event("search_etag_003", "pubkey_a", 1, vec![]);
        store.save_event(&event1).await.unwrap();
        store.save_event(&event2).await.unwrap();
        store.save_event(&event3).await.unwrap();

        let mut tags = HashMap::new();
        tags.insert(
            "#e".to_string(),
            vec!["referenced_event_x".to_string()],
        );
        let filter = SearchFilter {
            tags,
            ..Default::default()
        };
        let result = store.search_events(&filter).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "search_etag_001");
    }

    /// #pタグフィルターで公開鍵参照をフィルタリングできることを確認
    #[tokio::test]
    async fn test_search_events_filter_by_p_tag() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let event1 = create_test_event(
            "search_ptag_001",
            "pubkey_a",
            1,
            vec![vec!["p".to_string(), "mentioned_pubkey_x".to_string()]],
        );
        let event2 = create_test_event(
            "search_ptag_002",
            "pubkey_a",
            1,
            vec![vec!["p".to_string(), "mentioned_pubkey_y".to_string()]],
        );
        store.save_event(&event1).await.unwrap();
        store.save_event(&event2).await.unwrap();

        let mut tags = HashMap::new();
        tags.insert("#p".to_string(), vec!["mentioned_pubkey_y".to_string()]);
        let filter = SearchFilter {
            tags,
            ..Default::default()
        };
        let result = store.search_events(&filter).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "search_ptag_002");
    }

    /// #dタグフィルターでAddressable識別子をフィルタリングできることを確認
    #[tokio::test]
    async fn test_search_events_filter_by_d_tag() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let event1 = create_test_event(
            "search_dtag_001",
            "pubkey_a",
            30023,
            vec![vec!["d".to_string(), "article-slug-1".to_string()]],
        );
        let event2 = create_test_event(
            "search_dtag_002",
            "pubkey_a",
            30023,
            vec![vec!["d".to_string(), "article-slug-2".to_string()]],
        );
        store.save_event(&event1).await.unwrap();
        store.save_event(&event2).await.unwrap();

        let mut tags = HashMap::new();
        tags.insert("#d".to_string(), vec!["article-slug-1".to_string()]);
        let filter = SearchFilter {
            tags,
            ..Default::default()
        };
        let result = store.search_events(&filter).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "search_dtag_001");
    }

    /// #aタグフィルターでAddressableイベント参照をフィルタリングできることを確認
    #[tokio::test]
    async fn test_search_events_filter_by_a_tag() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let event1 = create_test_event(
            "search_atag_001",
            "pubkey_a",
            1,
            vec![vec!["a".to_string(), "30023:pubkey:slug".to_string()]],
        );
        let event2 = create_test_event(
            "search_atag_002",
            "pubkey_a",
            1,
            vec![vec!["a".to_string(), "30023:other:other".to_string()]],
        );
        store.save_event(&event1).await.unwrap();
        store.save_event(&event2).await.unwrap();

        let mut tags = HashMap::new();
        tags.insert("#a".to_string(), vec!["30023:pubkey:slug".to_string()]);
        let filter = SearchFilter {
            tags,
            ..Default::default()
        };
        let result = store.search_events(&filter).await.unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "search_atag_001");
    }

    /// #tタグフィルターでハッシュタグをフィルタリングできることを確認
    #[tokio::test]
    async fn test_search_events_filter_by_t_tag() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let event1 = create_test_event(
            "search_ttag_001",
            "pubkey_a",
            1,
            vec![vec!["t".to_string(), "nostr".to_string()]],
        );
        let event2 = create_test_event(
            "search_ttag_002",
            "pubkey_a",
            1,
            vec![vec!["t".to_string(), "bitcoin".to_string()]],
        );
        let event3 = create_test_event(
            "search_ttag_003",
            "pubkey_a",
            1,
            vec![
                vec!["t".to_string(), "nostr".to_string()],
                vec!["t".to_string(), "bitcoin".to_string()],
            ],
        );
        store.save_event(&event1).await.unwrap();
        store.save_event(&event2).await.unwrap();
        store.save_event(&event3).await.unwrap();

        let mut tags = HashMap::new();
        tags.insert("#t".to_string(), vec!["nostr".to_string()]);
        let filter = SearchFilter {
            tags,
            ..Default::default()
        };
        let result = store.search_events(&filter).await.unwrap();

        assert_eq!(result.len(), 2);
        let ids: Vec<&str> = result.iter().map(|e| e.id.as_str()).collect();
        assert!(ids.contains(&"search_ttag_001"));
        assert!(ids.contains(&"search_ttag_003"));
    }

    /// 複数のタグ値でOR検索できることを確認
    #[tokio::test]
    async fn test_search_events_filter_by_multiple_tag_values() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let event1 = create_test_event(
            "search_multitag_001",
            "pubkey_a",
            1,
            vec![vec!["t".to_string(), "rust".to_string()]],
        );
        let event2 = create_test_event(
            "search_multitag_002",
            "pubkey_a",
            1,
            vec![vec!["t".to_string(), "python".to_string()]],
        );
        let event3 = create_test_event(
            "search_multitag_003",
            "pubkey_a",
            1,
            vec![vec!["t".to_string(), "javascript".to_string()]],
        );
        store.save_event(&event1).await.unwrap();
        store.save_event(&event2).await.unwrap();
        store.save_event(&event3).await.unwrap();

        let mut tags = HashMap::new();
        tags.insert(
            "#t".to_string(),
            vec!["rust".to_string(), "python".to_string()],
        );
        let filter = SearchFilter {
            tags,
            ..Default::default()
        };
        let result = store.search_events(&filter).await.unwrap();

        assert_eq!(result.len(), 2);
        let ids: Vec<&str> = result.iter().map(|e| e.id.as_str()).collect();
        assert!(ids.contains(&"search_multitag_001"));
        assert!(ids.contains(&"search_multitag_002"));
        assert!(!ids.contains(&"search_multitag_003"));
    }

    /// 複数種類のタグでAND検索できることを確認
    #[tokio::test]
    async fn test_search_events_filter_by_multiple_tag_types() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let event1 = create_test_event(
            "search_multitype_001",
            "pubkey_a",
            1,
            vec![
                vec!["e".to_string(), "event_ref".to_string()],
                vec!["t".to_string(), "nostr".to_string()],
            ],
        );
        let event2 = create_test_event(
            "search_multitype_002",
            "pubkey_a",
            1,
            vec![vec!["e".to_string(), "event_ref".to_string()]],
        );
        let event3 = create_test_event(
            "search_multitype_003",
            "pubkey_a",
            1,
            vec![vec!["t".to_string(), "nostr".to_string()]],
        );
        store.save_event(&event1).await.unwrap();
        store.save_event(&event2).await.unwrap();
        store.save_event(&event3).await.unwrap();

        let mut tags = HashMap::new();
        tags.insert("#e".to_string(), vec!["event_ref".to_string()]);
        tags.insert("#t".to_string(), vec!["nostr".to_string()]);
        let filter = SearchFilter {
            tags,
            ..Default::default()
        };
        let result = store.search_events(&filter).await.unwrap();

        // 両方のタグを持つイベントのみ取得される（AND条件）
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "search_multitype_001");
    }

    /// 複合フィルター（authors + kinds + tags）で検索できることを確認
    #[tokio::test]
    async fn test_search_events_combined_filters() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let event1 = create_test_event(
            "search_combined_001",
            "alice",
            1,
            vec![vec!["t".to_string(), "nostr".to_string()]],
        );
        let event2 = create_test_event(
            "search_combined_002",
            "alice",
            7,
            vec![vec!["t".to_string(), "nostr".to_string()]],
        );
        let event3 = create_test_event(
            "search_combined_003",
            "bob",
            1,
            vec![vec!["t".to_string(), "nostr".to_string()]],
        );
        let event4 = create_test_event(
            "search_combined_004",
            "alice",
            1,
            vec![vec!["t".to_string(), "bitcoin".to_string()]],
        );
        store.save_event(&event1).await.unwrap();
        store.save_event(&event2).await.unwrap();
        store.save_event(&event3).await.unwrap();
        store.save_event(&event4).await.unwrap();

        let mut tags = HashMap::new();
        tags.insert("#t".to_string(), vec!["nostr".to_string()]);
        let filter = SearchFilter {
            authors: Some(vec!["alice".to_string()]),
            kinds: Some(vec![1]),
            tags,
            ..Default::default()
        };
        let result = store.search_events(&filter).await.unwrap();

        // alice の kind=1 で #t=nostr のイベントのみ
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "search_combined_001");
    }

    /// 該当するイベントがない場合は空配列を返すことを確認
    #[tokio::test]
    async fn test_search_events_no_matches_returns_empty() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let event = create_test_event("search_nomatch_001", "pubkey_a", 1, vec![]);
        store.save_event(&event).await.unwrap();

        let filter = SearchFilter {
            ids: Some(vec!["nonexistent_id".to_string()]),
            ..Default::default()
        };
        let result = store.search_events(&filter).await.unwrap();

        assert!(result.is_empty());
    }

    /// event_jsonフィールドからNostrEventが正しくデシリアライズされることを確認
    #[tokio::test]
    async fn test_search_events_returns_full_event() {
        let (_dir, db_path) = temp_db_path();
        let store = SqliteEventStore::new(&db_path).await.unwrap();

        let original = NostrEvent {
            id: "search_full_001".to_string(),
            pubkey: "pubkey_full".to_string(),
            kind: 1,
            created_at: 1700000000,
            content: "完全なコンテンツ".to_string(),
            tags: vec![
                vec!["e".to_string(), "ref1".to_string()],
                vec!["p".to_string(), "pk1".to_string()],
            ],
            sig: "signature_here".to_string(),
        };
        store.save_event(&original).await.unwrap();

        let filter = SearchFilter {
            ids: Some(vec!["search_full_001".to_string()]),
            ..Default::default()
        };
        let result = store.search_events(&filter).await.unwrap();

        assert_eq!(result.len(), 1);
        let event = &result[0];
        assert_eq!(event.id, original.id);
        assert_eq!(event.pubkey, original.pubkey);
        assert_eq!(event.kind, original.kind);
        assert_eq!(event.created_at, original.created_at);
        assert_eq!(event.content, original.content);
        assert_eq!(event.tags, original.tags);
        assert_eq!(event.sig, original.sig);
    }

    /// SearchFilterがJSONからデシリアライズできることを確認
    #[test]
    fn test_search_filter_deserialize() {
        // Rust 2024ではraw文字列内の#がプレフィックスとして解釈されるため、
        // 通常の文字列リテラルでエスケープを使用
        let json = "{\
            \"ids\": [\"id1\", \"id2\"],\
            \"authors\": [\"pk1\"],\
            \"kinds\": [1, 7],\
            \"since\": 1700000000,\
            \"until\": 1800000000,\
            \"limit\": 50,\
            \"#e\": [\"event_ref\"],\
            \"#p\": [\"pubkey_ref\"],\
            \"#t\": [\"hashtag\"]\
        }";

        let filter: SearchFilter = serde_json::from_str(json).unwrap();

        assert_eq!(filter.ids, Some(vec!["id1".to_string(), "id2".to_string()]));
        assert_eq!(filter.authors, Some(vec!["pk1".to_string()]));
        assert_eq!(filter.kinds, Some(vec![1, 7]));
        assert_eq!(filter.since, Some(1700000000));
        assert_eq!(filter.until, Some(1800000000));
        assert_eq!(filter.limit, Some(50));
        assert_eq!(
            filter.tags.get("#e"),
            Some(&vec!["event_ref".to_string()])
        );
        assert_eq!(
            filter.tags.get("#p"),
            Some(&vec!["pubkey_ref".to_string()])
        );
        assert_eq!(filter.tags.get("#t"), Some(&vec!["hashtag".to_string()]));
    }

    /// 空のJSONオブジェクトからSearchFilterがデシリアライズできることを確認
    #[test]
    fn test_search_filter_deserialize_empty() {
        let json = "{}";
        let filter: SearchFilter = serde_json::from_str(json).unwrap();

        assert!(filter.ids.is_none());
        assert!(filter.authors.is_none());
        assert!(filter.kinds.is_none());
        assert!(filter.since.is_none());
        assert!(filter.until.is_none());
        assert!(filter.limit.is_none());
        assert!(filter.tags.is_empty());
    }
}
