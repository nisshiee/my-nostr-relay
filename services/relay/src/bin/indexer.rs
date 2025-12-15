/// DynamoDB Streams Indexer Lambda関数
///
/// DynamoDB EventsテーブルのストリームイベントをEC2 HTTP API（SQLite）に
/// インデックス化する。
/// INSERT/MODIFYイベントでPOST /eventsを送信、REMOVEイベントでDELETE /events/{id}を送信。
///
/// 要件: 5.3, 5.4 (search-ec2-sqlite)
/// Task 3.6: SSM Parameter StoreからAPIトークンを取得
/// Task 6.1: OpenSearch参照を削除し、SQLiteのみを使用
use aws_lambda_events::event::dynamodb::Event;
use lambda_runtime::{service_fn, Error, LambdaEvent};
use relay::infrastructure::{
    init_logging, HttpSqliteConfig, HttpSqliteIndexer, IndexerClient,
};
use tokio::sync::OnceCell;
use tracing::{error, info};

/// IndexerClientの静的インスタンス（SQLite用）
///
/// Lambda warm start時にクライアントを再利用するため、
/// 一度初期化したクライアントを静的に保持する。
/// Task 3.6: 初期化時にSSMからトークンを取得するため非同期に変更
static INDEXER_CLIENT: OnceCell<IndexerClient> = OnceCell::const_new();

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
/// 3. HttpSqliteIndexerでDynamoDB Streamsイベントを処理
/// 4. 処理結果をログに記録
///
/// # 要件
/// - 5.3: INSERT/MODIFYイベントでPOST /eventsを送信
/// - 5.4: REMOVEイベントでDELETE /events/{id}を送信
/// - Task 3.6: SSMからAPIトークンを取得
/// - Task 6.1: SQLiteのみを使用（OpenSearch廃止）
async fn handler(event: LambdaEvent<Event>) -> Result<(), Error> {
    let event = event.payload;
    let record_count = event.records.len();

    info!(
        record_count = record_count,
        "DynamoDB Streamsイベントを受信"
    );

    // IndexerClientを取得（静的保持でwarm start時再利用）
    let client = match get_indexer_client().await {
        Ok(client) => client,
        Err(err) => {
            error!(error = %err, "IndexerClient初期化失敗（SSMトークン取得エラーの可能性）");
            return Err(format!("IndexerClient初期化失敗: {}", err).into());
        }
    };

    // HttpSqliteIndexerを作成してイベントを処理
    let indexer = HttpSqliteIndexer::new(client.clone());
    let result = indexer.process_event(event).await;

    // 処理結果をログに記録
    info!(
        success_count = result.success_count,
        failure_count = result.failure_count,
        skip_count = result.skip_count,
        "インデックス処理完了"
    );

    // 失敗があった場合はエラーを返す（Lambda再試行をトリガー）
    if result.failure_count > 0 {
        return Err(format!(
            "インデックス処理に失敗: {} 件の失敗",
            result.failure_count
        )
        .into());
    }

    Ok(())
}
