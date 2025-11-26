use lambda_runtime::{service_fn, Error, LambdaEvent};
use serde_json::Value;

#[tokio::main]
async fn main() -> Result<(), Error> {
    let func = service_fn(func);
    lambda_runtime::run(func).await?;
    Ok(())
}

async fn func(_event: LambdaEvent<Value>) -> Result<Value, Error> {
    println!("Disconnect handler invoked");
    Ok(serde_json::json!({
        "statusCode": 200,
        "body": "Disconnected"
    }))
}
