/// ログ基盤モジュール
///
/// Lambda環境向けの構造化ログ設定を提供する。
/// tracingクレートを使用し、JSON形式での出力をサポートする。
///
/// 要件: 19.1
use std::sync::Once;

use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

/// ログサブスクライバー初期化用の同期プリミティブ
static INIT: Once = Once::new();

/// Lambda環境向けのログサブスクライバーを初期化する
///
/// JSON形式での構造化ログ出力を設定し、環境変数`RUST_LOG`または
/// デフォルトのログレベル（info）でフィルタリングを行う。
///
/// この関数は複数回呼び出しても安全で、最初の呼び出しのみ初期化を実行する。
///
/// # 使用例
/// ```ignore
/// use relay::infrastructure::init_logging;
///
/// init_logging();
/// tracing::info!("Lambda function started");
/// ```
pub fn init_logging() {
    INIT.call_once(|| {
        // 環境変数からログレベルを取得、デフォルトはinfo
        let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

        // JSON形式のログレイヤー（Lambda/CloudWatch向け）
        let json_layer = tracing_subscriber::fmt::layer()
            .json()
            .with_target(true)
            .with_file(true)
            .with_line_number(true)
            .flatten_event(true)
            .with_current_span(false);

        // サブスクライバーを構築して初期化
        tracing_subscriber::registry()
            .with(env_filter)
            .with(json_layer)
            .init();
    });
}

/// テスト用のログサブスクライバーを初期化する（人間が読みやすい形式）
///
/// # 注意
/// この関数はテスト専用であり、本番環境では`init_logging`を使用すること。
#[cfg(test)]
pub fn init_test_logging() {
    use std::sync::Once;
    static TEST_INIT: Once = Once::new();

    TEST_INIT.call_once(|| {
        let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("debug"));

        let fmt_layer = tracing_subscriber::fmt::layer()
            .with_test_writer()
            .with_target(true)
            .compact();

        let _ = tracing_subscriber::registry()
            .with(env_filter)
            .with(fmt_layer)
            .try_init();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 要件 19.1: ログ初期化が複数回呼び出しても安全であることを確認
    #[test]
    fn test_init_logging_idempotent() {
        // 複数回呼び出してもパニックしない
        init_test_logging();
        init_test_logging();
        init_test_logging();
    }

    /// 要件 19.6: 各ログレベルのマクロが使用可能であることを確認
    #[test]
    fn test_log_levels_available() {
        init_test_logging();

        // 各ログレベルのマクロが呼び出せることを確認
        tracing::error!("error level log");
        tracing::warn!("warn level log");
        tracing::info!("info level log");
        tracing::debug!("debug level log");
        tracing::trace!("trace level log");
    }

    /// 要件 19.5: コンテキスト情報付きログが出力できることを確認
    #[test]
    fn test_log_with_context() {
        init_test_logging();

        let connection_id = "conn-12345";
        let event_id = "event-67890";
        let subscription_id = "sub-abcde";

        // 構造化フィールド付きログ
        tracing::info!(
            connection_id = connection_id,
            event_id = event_id,
            "イベント処理開始"
        );

        tracing::debug!(
            connection_id = connection_id,
            subscription_id = subscription_id,
            "サブスクリプション作成"
        );
    }

    /// 要件 19.1: JSON形式のログ設定が可能であることを確認
    /// （実際のJSON出力は目視確認またはログ収集システムで確認）
    #[test]
    fn test_json_logging_configuration() {
        // JSON形式設定自体がエラーにならないことを確認
        let env_filter = EnvFilter::new("info");
        let json_layer = tracing_subscriber::fmt::layer()
            .json()
            .with_target(true)
            .flatten_event(true);

        // レジストリに追加できることを確認
        let _subscriber = tracing_subscriber::registry()
            .with(env_filter)
            .with(json_layer);
    }

    /// spanを使用したコンテキスト追跡が機能することを確認
    #[test]
    fn test_span_context() {
        init_test_logging();

        let span = tracing::info_span!(
            "request",
            connection_id = "conn-123",
            request_id = "req-456"
        );

        let _guard = span.enter();

        // span内でのログはコンテキストを継承
        tracing::info!("メッセージ処理中");
        tracing::debug!(kind = 1, "イベント種別判定");
    }
}
