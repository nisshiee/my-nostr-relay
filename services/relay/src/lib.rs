use lambda_runtime::{service_fn, Error, LambdaEvent};
use serde_json::Value;

pub async fn handler(event: LambdaEvent<Value>) -> Result<Value, Error> {
    Ok(event.payload)
}
