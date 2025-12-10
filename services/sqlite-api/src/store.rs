//! SQLiteイベントストア
//!
//! Nostrイベントの保存・検索・削除機能を提供する。
//! - 書き込み: 専用の単一接続（Arc<Mutex<Connection>>）
//! - 読み取り: deadpool-sqliteによるasync接続プール

// 後続タスク（2.3-2.6）で使用予定のため、現時点でのdead_code警告を抑制
#![allow(dead_code)]

use std::sync::{Arc, Mutex};

use deadpool_sqlite::{Config, Pool, Runtime};
use rusqlite::Connection;
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
}
