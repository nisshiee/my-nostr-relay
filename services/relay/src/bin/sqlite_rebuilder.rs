/// HTTP SQLiteインデックス再構築Lambda関数
///
/// DynamoDB EventsテーブルからEC2上のSQLiteインデックスを再構築する。
/// Lambda関数としても、ローカルスクリプトとしても実行可能。
///
/// # 環境変数
/// - SQLITE_API_ENDPOINT: EC2 HTTP APIサーバーのエンドポイントURL（必須）
/// - SQLITE_API_TOKEN_PARAM: Parameter Storeのパラメータパス（必須、Lambda環境）
/// - SQLITE_API_TOKEN: APIトークン（テスト/ローカル用）
/// - EVENTS_TABLE: DynamoDB Eventsテーブル名（必須）
/// - REBUILD_BATCH_SIZE: バッチサイズ（デフォルト: 100、コマンドライン引数で上書き可能）
///
/// # Lambda実行
/// Lambda関数として実行する場合、空のペイロードでトリガーする。
/// リカバリー時は`start_key`を指定して中断位置から再開可能。
///
/// # ローカル実行
/// ```bash
/// export SQLITE_API_ENDPOINT=https://xxx.relay.nostr.nisshiee.org
/// export SQLITE_API_TOKEN=your-api-token
/// export EVENTS_TABLE=nostr-relay-events
///
/// # 全件再構築
/// cargo run --bin sqlite_rebuilder
///
/// # バッチサイズ指定
/// cargo run --bin sqlite_rebuilder -- --batch-size 200
///
/// # リカバリー（中断位置から再開）
/// cargo run --bin sqlite_rebuilder -- --start-key '{"id":"abc123..."}'
///
/// # 両方指定
/// cargo run --bin sqlite_rebuilder -- --batch-size 200 --start-key '{"id":"abc123..."}'
/// ```
///
/// 要件: 6.1, 6.2, 6.3, 6.4, 6.5
use aws_sdk_dynamodb::types::AttributeValue;
use clap::Parser;
use lambda_runtime::{service_fn, Error, LambdaEvent};
use relay::infrastructure::{
    init_logging, HttpSqliteConfig, HttpSqliteRebuildConfig, HttpSqliteRebuilder, IndexerClient,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tracing::{error, info};

/// コマンドライン引数（ローカル実行用）
#[derive(Parser, Debug)]
#[command(name = "sqlite_rebuilder")]
#[command(about = "DynamoDB EventsテーブルからSQLiteインデックスを再構築")]
struct CliArgs {
    /// バッチサイズ（1回のスキャンで取得するアイテム数）
    /// 環境変数REBUILD_BATCH_SIZEより優先される
    #[arg(long, short = 'b')]
    batch_size: Option<u32>,

    /// リカバリー用の開始キー（中断位置から再開する場合）
    /// JSON形式: '{"id": "event_id_value"}'
    #[arg(long, short = 's')]
    start_key: Option<String>,
}

/// Lambda関数の入力（空または設定オーバーライド）
#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct RebuildInput {
    /// バッチサイズのオーバーライド
    batch_size: Option<u32>,
    /// リカバリー用の開始キー（中断位置から再開する場合）
    /// 形式: {"id": "event_id_value"} のようなJSONオブジェクト
    start_key: Option<HashMap<String, String>>,
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
    /// スキップされたイベント数（既存イベントまたはevent_json欠損）
    skipped_count: usize,
    /// エラーが発生したイベント数
    error_count: usize,
    /// 最後に処理したキー（リカバリー用）
    #[serde(skip_serializing_if = "Option::is_none")]
    last_evaluated_key: Option<HashMap<String, String>>,
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
        has_start_key = input.start_key.is_some(),
        "HTTP SQLiteインデックス再構築を開始"
    );

    // start_keyをAttributeValue形式に変換
    let start_key = input.start_key.map(|key| {
        key.into_iter()
            .map(|(k, v)| (k, AttributeValue::S(v)))
            .collect()
    });

    match run_rebuild(input.batch_size, start_key).await {
        Ok(result) => {
            // last_evaluated_keyを文字列形式に変換
            let last_key = result.last_evaluated_key.map(|key| {
                key.into_iter()
                    .filter_map(|(k, v)| v.as_s().ok().map(|s| (k, s.to_string())))
                    .collect()
            });

            Ok(RebuildOutput {
                success: true,
                scanned_count: result.scanned_count,
                indexed_count: result.indexed_count,
                skipped_count: result.skipped_count,
                error_count: result.error_count,
                last_evaluated_key: last_key,
                error_message: None,
            })
        }
        Err(e) => {
            error!(error = %e, "HTTP SQLiteインデックス再構築に失敗");
            Ok(RebuildOutput {
                success: false,
                scanned_count: 0,
                indexed_count: 0,
                skipped_count: 0,
                error_count: 0,
                last_evaluated_key: None,
                error_message: Some(e.to_string()),
            })
        }
    }
}

/// ローカル実行用関数
async fn run_local() -> Result<(), Error> {
    // コマンドライン引数をパース
    let args = CliArgs::parse();

    info!(
        batch_size = ?args.batch_size,
        start_key = ?args.start_key,
        "コマンドライン引数をパース"
    );

    // start_keyをパースしてAttributeValue形式に変換
    let start_key = if let Some(key_json) = args.start_key {
        let parsed: HashMap<String, String> = serde_json::from_str(&key_json).map_err(|e| {
            error!(error = %e, json = %key_json, "start_keyのJSONパースに失敗");
            Error::from(format!("Invalid start_key JSON: {}", e))
        })?;
        Some(
            parsed
                .into_iter()
                .map(|(k, v)| (k, AttributeValue::S(v)))
                .collect(),
        )
    } else {
        None
    };

    match run_rebuild(args.batch_size, start_key).await {
        Ok(result) => {
            info!(
                scanned_count = result.scanned_count,
                indexed_count = result.indexed_count,
                skipped_count = result.skipped_count,
                error_count = result.error_count,
                "HTTP SQLiteインデックス再構築完了"
            );

            // 要件 6.5: 中断時のLastEvaluatedKeyをログ出力
            if let Some(ref key) = result.last_evaluated_key {
                // リカバリー用にJSON形式でも出力
                let key_json: HashMap<String, String> = key
                    .iter()
                    .filter_map(|(k, v)| v.as_s().ok().map(|s| (k.clone(), s.to_string())))
                    .collect();
                info!(
                    last_evaluated_key = ?key,
                    last_evaluated_key_json = %serde_json::to_string(&key_json).unwrap_or_default(),
                    "次回のリカバリー用キー（未完了の場合）"
                );
            }

            Ok(())
        }
        Err(e) => {
            error!(error = %e, "HTTP SQLiteインデックス再構築に失敗");
            Err(e)
        }
    }
}

/// 再構築を実行
///
/// # 引数
/// * `batch_size_override` - バッチサイズのオーバーライド
/// * `start_key` - リカバリー用の開始キー
///
/// # 要件
/// - 6.5: 障害復旧時の再開をサポート（start_key引数）
async fn run_rebuild(
    batch_size_override: Option<u32>,
    start_key: Option<HashMap<String, AttributeValue>>,
) -> Result<relay::infrastructure::HttpSqliteRebuildResult, Error> {
    // DynamoDB Eventsテーブル名を環境変数から読み込み
    let events_table = std::env::var("EVENTS_TABLE").map_err(|_| {
        error!("EVENTS_TABLE環境変数が設定されていません");
        Error::from("Missing environment variable: EVENTS_TABLE")
    })?;

    // 再構築設定を環境変数から読み込み（オーバーライド適用）
    let mut rebuild_config = HttpSqliteRebuildConfig::from_env().map_err(|e| {
        error!(error = %e, "再構築設定読み込み失敗");
        Error::from(e.to_string())
    })?;

    // オーバーライドを適用
    if let Some(batch_size) = batch_size_override {
        rebuild_config.batch_size = batch_size;
    }

    // HTTP SQLite設定を読み込み
    // Lambda環境ではSSMから、ローカルではSQLITE_API_TOKEN環境変数から取得
    let http_sqlite_config = if std::env::var("AWS_LAMBDA_FUNCTION_NAME").is_ok() {
        // Lambda環境: SSMから取得
        HttpSqliteConfig::from_env_with_ssm().await.map_err(|e| {
            error!(error = %e, "HTTP SQLite設定読み込み失敗（SSM）");
            Error::from(e.to_string())
        })?
    } else {
        // ローカル環境: 環境変数から直接取得
        HttpSqliteConfig::from_env().map_err(|e| {
            error!(error = %e, "HTTP SQLite設定読み込み失敗");
            Error::from(e.to_string())
        })?
    };

    info!(
        sqlite_api_endpoint = %http_sqlite_config.endpoint(),
        events_table = %events_table,
        batch_size = rebuild_config.batch_size,
        has_start_key = start_key.is_some(),
        "設定読み込み完了"
    );

    // IndexerClientを作成
    let indexer_client = IndexerClient::new(&http_sqlite_config);

    // DynamoDBクライアントを初期化
    let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let dynamodb_client = aws_sdk_dynamodb::Client::new(&aws_config);

    // HttpSqliteRebuilderを作成して実行
    let rebuilder = HttpSqliteRebuilder::new(
        dynamodb_client,
        indexer_client,
        events_table,
        rebuild_config,
    );

    // 要件 6.5: 障害復旧時の再開をサポート
    rebuilder.rebuild(start_key).await.map_err(|e| {
        // 要件 6.3: エラー時もログ出力
        error!(error = %e, "再構築処理に失敗");
        Error::from(e.to_string())
    })
}
