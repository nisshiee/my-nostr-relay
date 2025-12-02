/// DynamoDB Streams Indexer Lambda関数
///
/// DynamoDB EventsテーブルのストリームイベントをOpenSearchにインデックス化する。
/// INSERT/MODIFYイベントでインデックス作成、REMOVEイベントで削除を行う。
///
/// 要件: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 8.4
use aws_lambda_events::event::dynamodb::Event;
use lambda_runtime::{service_fn, Error, LambdaEvent};
use relay::infrastructure::{init_logging, Indexer, OpenSearchClient, OpenSearchConfig};
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
/// 1. OpenSearch設定を環境変数から読み込み
/// 2. OpenSearchクライアントを初期化
/// 3. Indexerを使用してDynamoDB Streamsイベントを処理
/// 4. 処理結果をログに記録
async fn handler(event: LambdaEvent<Event>) -> Result<(), Error> {
    let event = event.payload;
    let record_count = event.records.len();

    info!(
        record_count = record_count,
        "DynamoDB Streamsイベントを受信"
    );

    // OpenSearch設定を環境変数から読み込み
    let config = match OpenSearchConfig::from_env() {
        Ok(config) => config,
        Err(err) => {
            error!(error = %err, "OpenSearch設定読み込み失敗");
            return Err(err.into());
        }
    };

    // OpenSearchクライアントを初期化
    let client = match OpenSearchClient::new(&config).await {
        Ok(client) => client,
        Err(err) => {
            error!(error = %err, "OpenSearchクライアント初期化失敗");
            return Err(err.into());
        }
    };

    // Indexerを作成してイベントを処理
    let indexer = Indexer::new(client);
    let result = indexer.process_event(event).await;

    // 要件 8.4: 処理結果をログに記録
    info!(
        success_count = result.success_count,
        failure_count = result.failure_count,
        skip_count = result.skip_count,
        "インデックス処理完了"
    );

    // 失敗があった場合はエラーを返す（Lambda再試行をトリガー）
    // 要件 3.5: 失敗時のリトライ対応（Lambda標準リトライに依存）
    if result.failure_count > 0 {
        return Err(format!(
            "インデックス処理に失敗: {} 件の失敗",
            result.failure_count
        )
        .into());
    }

    Ok(())
}
