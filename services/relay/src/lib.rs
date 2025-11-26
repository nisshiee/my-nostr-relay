use lambda_runtime::{Error, LambdaEvent};
use serde_json::Value;

// Domain layer modules
pub mod domain;

// Infrastructure layer modules
pub mod infrastructure;

pub async fn handler(event: LambdaEvent<Value>) -> Result<Value, Error> {
    Ok(event.payload)
}
