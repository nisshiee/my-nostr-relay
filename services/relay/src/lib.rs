use lambda_runtime::{Error, LambdaEvent};
use serde_json::Value;

// Domain layer modules
pub mod domain;

pub async fn handler(event: LambdaEvent<Value>) -> Result<Value, Error> {
    Ok(event.payload)
}
