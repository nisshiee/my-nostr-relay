// アプリケーション層モジュール
pub mod message_parser;

// 再エクスポート
pub use message_parser::{ClientMessage, MessageParser, ParseError};
