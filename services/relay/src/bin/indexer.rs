/// DynamoDB Streams Indexer Lambda関数
///
/// DynamoDB EventsテーブルのストリームイベントをEC2 HTTP API（SQLite）とOpenSearchの両方に
/// インデックス化する（並行稼働モード）。
/// INSERT/MODIFYイベントでPOST /eventsを送信、REMOVEイベントでDELETE /events/{id}を送信。
///
/// 要件: 5.3, 5.4 (search-ec2-sqlite)
/// Task 3.6: SSM Parameter StoreからAPIトークンを取得
/// 並行稼働: SQLiteとOpenSearchの両方に書き込み
use aws_lambda_events::event::dynamodb::Event;
use lambda_runtime::{service_fn, Error, LambdaEvent};
use relay::infrastructure::{
    init_logging, HttpSqliteConfig, HttpSqliteIndexer, Indexer as OpenSearchIndexer,
    IndexerClient, OpenSearchClient, OpenSearchConfig,
};
use tokio::sync::OnceCell;
use tracing::{error, info, warn};

/// IndexerClientの静的インスタンス（SQLite用）
///
/// Lambda warm start時にクライアントを再利用するため、
/// 一度初期化したクライアントを静的に保持する。
/// Task 3.6: 初期化時にSSMからトークンを取得するため非同期に変更
static INDEXER_CLIENT: OnceCell<IndexerClient> = OnceCell::const_new();

/// OpenSearchClientの静的インスタンス（並行稼働用）
///
/// 並行稼働期間中、SQLiteと同時にOpenSearchにもインデックスを作成する。
static OPENSEARCH_CLIENT: OnceCell<OpenSearchClient> = OnceCell::const_new();

/// IndexerClientを取得（初期化されていなければ初期化）
///
/// # 戻り値
/// * `Ok(&'static IndexerClient)` - 静的参照へのクライアント
/// * `Err(HttpSqliteConfigError)` - 設定読み込みエラー
///
/// Task 3.6: SSMからAPIトークンを取得（非同期初期化）
async fn get_indexer_client(
) -> Result<&'static IndexerClient, relay::infrastructure::HttpSqliteConfigError> {
    INDEXER_CLIENT
        .get_or_try_init(|| async {
            let config = HttpSqliteConfig::from_env_with_ssm().await?;
            info!(
                endpoint = config.endpoint(),
                "IndexerClientを初期化（トークンはSSMから取得）"
            );
            Ok(IndexerClient::new(&config))
        })
        .await
}

/// OpenSearchClientを取得（初期化されていなければ初期化、設定がなければNone）
///
/// 並行稼働期間用。OPENSEARCH_ENDPOINT環境変数が設定されている場合のみ初期化。
async fn get_opensearch_client(
) -> Option<&'static OpenSearchClient> {
    // 既に初期化済みならそれを返す
    if let Some(client) = OPENSEARCH_CLIENT.get() {
        return Some(client);
    }

    // 環境変数から設定を読み込み
    let config = match OpenSearchConfig::from_env() {
        Ok(config) => config,
        Err(_) => {
            // OpenSearch設定がない場合はNone（並行稼働モードではない）
            return None;
        }
    };

    // クライアントを初期化
    match OpenSearchClient::new(&config).await {
        Ok(client) => {
            // set()が失敗した場合（別スレッドが先に初期化）は既存のものを返す
            let _ = OPENSEARCH_CLIENT.set(client);
            OPENSEARCH_CLIENT.get()
        }
        Err(e) => {
            warn!(error = %e, "OpenSearchClient初期化失敗、OpenSearchへの書き込みはスキップ");
            None
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    // 構造化ログを初期化
    init_logging();

    // Lambda関数を初期化して実行
    let func = service_fn(handler);
    lambda_runtime::run(func).await?;
    Ok(())
}

/// Lambda関数のメインハンドラー
///
/// # 処理フロー
/// 1. HTTP SQLite設定を環境変数とSSMから読み込み
/// 2. IndexerClientを取得（静的保持でwarm start時再利用）
/// 3. HttpSqliteIndexerとOpenSearchIndexerの両方でDynamoDB Streamsイベントを処理
/// 4. 処理結果をログに記録
///
/// # 要件
/// - 5.3: INSERT/MODIFYイベントでPOST /eventsを送信
/// - 5.4: REMOVEイベントでDELETE /events/{id}を送信
/// - Task 3.6: SSMからAPIトークンを取得
/// - 並行稼働: SQLiteとOpenSearchの両方に書き込み
async fn handler(event: LambdaEvent<Event>) -> Result<(), Error> {
    let event = event.payload;
    let record_count = event.records.len();

    info!(
        record_count = record_count,
        "DynamoDB Streamsイベントを受信"
    );

    // SQLiteへのインデックス処理
    let sqlite_result = process_sqlite_index(&event).await;

    // OpenSearchへのインデックス処理（並行稼働モード）
    let opensearch_result = process_opensearch_index(&event).await;

    // 処理結果をログに記録
    info!(
        sqlite_success = sqlite_result.as_ref().map(|r| r.success_count).unwrap_or(0),
        sqlite_failure = sqlite_result.as_ref().map(|r| r.failure_count).unwrap_or(0),
        sqlite_skip = sqlite_result.as_ref().map(|r| r.skip_count).unwrap_or(0),
        opensearch_success = opensearch_result.as_ref().map(|r| r.success_count).unwrap_or(0),
        opensearch_failure = opensearch_result.as_ref().map(|r| r.failure_count).unwrap_or(0),
        opensearch_skip = opensearch_result.as_ref().map(|r| r.skip_count).unwrap_or(0),
        "インデックス処理完了（並行稼働モード）"
    );

    // SQLiteへの書き込みに失敗があった場合はエラーを返す（Lambda再試行をトリガー）
    // OpenSearchの失敗は警告ログのみ（SQLiteが主系統）
    if let Some(result) = &sqlite_result {
        if result.failure_count > 0 {
            return Err(format!(
                "SQLiteインデックス処理に失敗: {} 件の失敗",
                result.failure_count
            )
            .into());
        }
    } else {
        // SQLite設定がない場合はエラー
        return Err("SQLite設定が見つかりません".into());
    }

    Ok(())
}

/// SQLiteへのインデックス処理
async fn process_sqlite_index(
    event: &Event,
) -> Option<relay::infrastructure::HttpSqliteIndexerResult> {
    // IndexerClientを取得（静的保持でwarm start時再利用）
    let client = match get_indexer_client().await {
        Ok(client) => client,
        Err(err) => {
            error!(error = %err, "IndexerClient初期化失敗（SSMトークン取得エラーの可能性）");
            return None;
        }
    };

    // HttpSqliteIndexerを作成してイベントを処理
    let indexer = HttpSqliteIndexer::new(client.clone());
    let result = indexer.process_event(event.clone()).await;

    info!(
        backend = "sqlite",
        success_count = result.success_count,
        failure_count = result.failure_count,
        skip_count = result.skip_count,
        "SQLiteインデックス処理完了"
    );

    Some(result)
}

/// OpenSearchへのインデックス処理（並行稼働用）
async fn process_opensearch_index(
    event: &Event,
) -> Option<relay::infrastructure::IndexerResult> {
    // OpenSearchClientを取得（設定がなければNone）
    let client = get_opensearch_client().await?;

    info!(
        backend = "opensearch",
        "OpenSearchへのインデックス処理開始（並行稼働モード）"
    );

    // OpenSearchIndexerを作成してイベントを処理
    let indexer = OpenSearchIndexer::new(client.clone());
    let result = indexer.process_event(event.clone()).await;

    // OpenSearchの失敗は警告ログ（SQLiteが主系統なのでエラーにはしない）
    if result.failure_count > 0 {
        warn!(
            backend = "opensearch",
            success_count = result.success_count,
            failure_count = result.failure_count,
            skip_count = result.skip_count,
            "OpenSearchインデックス処理に失敗あり（並行稼働モード、継続）"
        );
    } else {
        info!(
            backend = "opensearch",
            success_count = result.success_count,
            failure_count = result.failure_count,
            skip_count = result.skip_count,
            "OpenSearchインデックス処理完了"
        );
    }

    Some(result)
}
