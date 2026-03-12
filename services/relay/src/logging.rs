//! ログ基盤モジュール

use std::sync::Once;
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

static INIT: Once = Once::new();

/// ログ出力モード
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogMode {
    /// 開発用：人間が読みやすい形式
    Development,
    /// プロダクション用：JSON形式
    Production,
}

impl Default for LogMode {
    fn default() -> Self {
        match std::env::var("LOG_MODE").as_deref() {
            Ok("production" | "json") => LogMode::Production,
            _ => LogMode::Development,
        }
    }
}

/// ログサブスクライバーを初期化
pub fn init_logging() {
    init_logging_with_mode(LogMode::default());
}

/// 指定したモードでログサブスクライバーを初期化
pub fn init_logging_with_mode(mode: LogMode) {
    INIT.call_once(|| {
        let env_filter =
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

        match mode {
            LogMode::Development => {
                let fmt_layer = tracing_subscriber::fmt::layer()
                    .with_target(true)
                    .with_file(false)
                    .with_line_number(false)
                    .compact();

                tracing_subscriber::registry()
                    .with(env_filter)
                    .with(fmt_layer)
                    .init();
            }
            LogMode::Production => {
                let json_layer = tracing_subscriber::fmt::layer()
                    .json()
                    .with_target(true)
                    .with_file(true)
                    .with_line_number(true)
                    .flatten_event(true)
                    .with_current_span(false);

                tracing_subscriber::registry()
                    .with(env_filter)
                    .with(json_layer)
                    .init();
            }
        }
    });
}
