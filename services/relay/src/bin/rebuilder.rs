/// OpenSearchインデックス再構築Lambda関数
///
/// DynamoDB EventsテーブルからOpenSearchインデックスを再構築する。
/// Lambda関数としても、ローカルスクリプトとしても実行可能。
///
/// # 環境変数
/// - OPENSEARCH_ENDPOINT: OpenSearchエンドポイントURL（必須）
/// - OPENSEARCH_INDEX: インデックス名（デフォルト: nostr_events）
/// - EVENTS_TABLE: DynamoDB Eventsテーブル名（必須）
/// - REBUILD_BATCH_SIZE: バッチサイズ（デフォルト: 100）
/// - REBUILD_DELETE_INDEX: 既存インデックスを削除するか（"true"で有効）
///
/// # Lambda実行
/// Lambda関数として実行する場合、空のペイロードでトリガーする。
///
/// # ローカル実行
/// ```bash
/// export OPENSEARCH_ENDPOINT=https://...
/// export OPENSEARCH_INDEX=nostr_events
/// export EVENTS_TABLE=nostr-relay-events
/// export REBUILD_BATCH_SIZE=100
/// export REBUILD_DELETE_INDEX=true
/// cargo run --bin rebuilder
/// ```
///
/// 要件: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
use lambda_runtime::{service_fn, Error, LambdaEvent};
use relay::infrastructure::{
    init_logging, OpenSearchClient, OpenSearchConfig, RebuildConfig, Rebuilder,
};
use serde::{Deserialize, Serialize};
use tracing::{error, info};

/// Lambda関数の入力（空または設定オーバーライド）
#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct RebuildInput {
    /// バッチサイズのオーバーライド
    batch_size: Option<u32>,
    /// インデックス削除フラグのオーバーライド
    delete_before_rebuild: Option<bool>,
}

/// Lambda関数の出力
#[derive(Debug, Serialize)]
struct RebuildOutput {
    /// 処理成功フラグ
    success: bool,
    /// スキャンしたイベント数
    scanned_count: usize,
    /// インデックス化されたイベント数
    indexed_count: usize,
    /// スキップされたイベント数
    skipped_count: usize,
    /// エラーが発生したイベント数
    error_count: usize,
    /// エラーメッセージ（エラー時のみ）
    #[serde(skip_serializing_if = "Option::is_none")]
    error_message: Option<String>,
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    // 構造化ログを初期化
    init_logging();

    // Lambda環境かどうかを判定
    if std::env::var("AWS_LAMBDA_FUNCTION_NAME").is_ok() {
        // Lambda環境で実行
        info!("Lambda関数として起動");
        let func = service_fn(handler);
        lambda_runtime::run(func).await?;
    } else {
        // ローカル環境で実行
        info!("ローカルスクリプトとして起動");
        run_local().await?;
    }

    Ok(())
}

/// Lambda関数のメインハンドラー
async fn handler(event: LambdaEvent<RebuildInput>) -> Result<RebuildOutput, Error> {
    let input = event.payload;

    info!(
        batch_size_override = ?input.batch_size,
        delete_override = ?input.delete_before_rebuild,
        "インデックス再構築を開始"
    );

    match run_rebuild(input.batch_size, input.delete_before_rebuild).await {
        Ok(result) => Ok(RebuildOutput {
            success: true,
            scanned_count: result.scanned_count,
            indexed_count: result.indexed_count,
            skipped_count: result.skipped_count,
            error_count: result.error_count,
            error_message: None,
        }),
        Err(e) => {
            error!(error = %e, "インデックス再構築に失敗");
            Ok(RebuildOutput {
                success: false,
                scanned_count: 0,
                indexed_count: 0,
                skipped_count: 0,
                error_count: 0,
                error_message: Some(e.to_string()),
            })
        }
    }
}

/// ローカル実行用関数
async fn run_local() -> Result<(), Error> {
    match run_rebuild(None, None).await {
        Ok(result) => {
            info!(
                scanned_count = result.scanned_count,
                indexed_count = result.indexed_count,
                skipped_count = result.skipped_count,
                error_count = result.error_count,
                "インデックス再構築完了"
            );
            Ok(())
        }
        Err(e) => {
            error!(error = %e, "インデックス再構築に失敗");
            Err(e)
        }
    }
}

/// 再構築を実行
async fn run_rebuild(
    batch_size_override: Option<u32>,
    delete_override: Option<bool>,
) -> Result<relay::infrastructure::RebuildResult, Error> {
    // OpenSearch設定を環境変数から読み込み
    let opensearch_config = OpenSearchConfig::from_env().map_err(|e| {
        error!(error = %e, "OpenSearch設定読み込み失敗");
        Error::from(e.to_string())
    })?;

    // DynamoDB Eventsテーブル名を環境変数から読み込み
    let events_table = std::env::var("EVENTS_TABLE").map_err(|_| {
        error!("EVENTS_TABLE環境変数が設定されていません");
        Error::from("Missing environment variable: EVENTS_TABLE")
    })?;

    // 再構築設定を環境変数から読み込み（オーバーライド適用）
    let mut rebuild_config = RebuildConfig::from_env().map_err(|e| {
        error!(error = %e, "再構築設定読み込み失敗");
        Error::from(e.to_string())
    })?;

    // オーバーライドを適用
    if let Some(batch_size) = batch_size_override {
        rebuild_config.batch_size = batch_size;
    }
    if let Some(delete) = delete_override {
        rebuild_config.delete_before_rebuild = delete;
    }

    info!(
        opensearch_endpoint = %opensearch_config.endpoint(),
        opensearch_index = %opensearch_config.index_name(),
        events_table = %events_table,
        batch_size = rebuild_config.batch_size,
        delete_before_rebuild = rebuild_config.delete_before_rebuild,
        "設定読み込み完了"
    );

    // OpenSearchクライアントを初期化
    let opensearch_client = OpenSearchClient::new(&opensearch_config).await.map_err(|e| {
        error!(error = %e, "OpenSearchクライアント初期化失敗");
        Error::from(e.to_string())
    })?;

    // DynamoDBクライアントを初期化
    let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let dynamodb_client = aws_sdk_dynamodb::Client::new(&aws_config);

    // Rebuilderを作成して実行
    let rebuilder = Rebuilder::new(
        dynamodb_client,
        opensearch_client,
        events_table,
        rebuild_config,
    );

    rebuilder.rebuild().await.map_err(|e| {
        error!(error = %e, "再構築処理に失敗");
        Error::from(e.to_string())
    })
}
