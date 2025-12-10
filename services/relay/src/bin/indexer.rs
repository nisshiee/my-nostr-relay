/// DynamoDB Streams Indexer Lambda関数
///
/// DynamoDB EventsテーブルのストリームイベントをEC2 HTTP API（SQLite）にインデックス化する。
/// INSERT/MODIFYイベントでPOST /eventsを送信、REMOVEイベントでDELETE /events/{id}を送信。
///
/// 要件: 5.3, 5.4 (search-ec2-sqlite)
use aws_lambda_events::event::dynamodb::Event;
use lambda_runtime::{service_fn, Error, LambdaEvent};
use relay::infrastructure::{init_logging, HttpSqliteConfig, HttpSqliteIndexer, IndexerClient};
use tracing::{error, info};

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
/// 1. HTTP SQLite設定を環境変数から読み込み
/// 2. IndexerClientを初期化
/// 3. HttpSqliteIndexerを使用してDynamoDB Streamsイベントを処理
/// 4. 処理結果をログに記録
///
/// # 要件
/// - 5.3: INSERT/MODIFYイベントでPOST /eventsを送信
/// - 5.4: REMOVEイベントでDELETE /events/{id}を送信
async fn handler(event: LambdaEvent<Event>) -> Result<(), Error> {
    let event = event.payload;
    let record_count = event.records.len();

    info!(
        record_count = record_count,
        "DynamoDB Streamsイベントを受信"
    );

    // HTTP SQLite設定を環境変数から読み込み
    let config = match HttpSqliteConfig::from_env() {
        Ok(config) => config,
        Err(err) => {
            error!(error = %err, "HTTP SQLite設定読み込み失敗");
            return Err(err.into());
        }
    };

    // IndexerClientを初期化
    let client = IndexerClient::new(&config);

    // HttpSqliteIndexerを作成してイベントを処理
    let indexer = HttpSqliteIndexer::new(client);
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
