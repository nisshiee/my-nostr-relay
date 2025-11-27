use lambda_runtime::{Error, LambdaEvent};
use serde_json::Value;

// ドメイン層モジュール
pub mod domain;

// インフラストラクチャ層モジュール
pub mod infrastructure;

pub async fn handler(event: LambdaEvent<Value>) -> Result<Value, Error> {
    Ok(event.payload)
}
