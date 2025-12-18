//! SNS操作モジュール
//!
//! Shutdown/Recovery Lambdaで使用するSNS通知機能を提供する。
//! - 結果メッセージのSNSトピックへの発行
//!
//! 要件: 3.9, 4.8

use async_trait::async_trait;
use aws_sdk_sns::Client as SnsClient;
use serde::Serialize;
use thiserror::Error;
use tracing::{info, warn};

/// SNS操作のエラー型
#[derive(Debug, Error)]
pub enum SnsOpsError {
    /// AWS SDK エラー
    #[error("AWS SNS APIエラー: {0}")]
    AwsSdkError(String),
    /// JSON シリアライズエラー
    #[error("JSONシリアライズエラー: {0}")]
    SerializeError(String),
}

/// SNSメッセージ発行結果
#[derive(Debug, Clone)]
pub struct PublishResult {
    /// メッセージID
    pub message_id: String,
    /// 発行先トピックARN
    pub topic_arn: String,
    /// 成功したかどうか
    pub success: bool,
    /// 結果メッセージ
    pub message: String,
}

impl PublishResult {
    /// 成功結果を作成
    pub fn success(topic_arn: impl Into<String>, message_id: impl Into<String>) -> Self {
        let arn = topic_arn.into();
        let id = message_id.into();
        Self {
            message_id: id.clone(),
            topic_arn: arn.clone(),
            success: true,
            message: format!("メッセージを発行しました (message_id: {})", id),
        }
    }

    /// 失敗結果を作成
    pub fn failure(topic_arn: impl Into<String>, error: impl std::fmt::Display) -> Self {
        let arn = topic_arn.into();
        Self {
            message_id: String::new(),
            topic_arn: arn.clone(),
            success: false,
            message: format!("メッセージ発行に失敗しました: {}", error),
        }
    }
}

/// SNS操作トレイト（テスト用の抽象化）
#[async_trait]
pub trait SnsOps: Send + Sync {
    /// メッセージをSNSトピックに発行する
    ///
    /// # 引数
    /// * `topic_arn` - SNSトピックARN
    /// * `message` - 発行するメッセージ（JSON文字列）
    /// * `subject` - メッセージの件名（オプション）
    ///
    /// # 戻り値
    /// * `Ok(PublishResult)` - 発行結果
    /// * `Err(SnsOpsError)` - エラー
    async fn publish(
        &self,
        topic_arn: &str,
        message: &str,
        subject: Option<&str>,
    ) -> Result<PublishResult, SnsOpsError>;

    /// シリアライズ可能な値をJSONとしてSNSトピックに発行する
    ///
    /// # 引数
    /// * `topic_arn` - SNSトピックARN
    /// * `value` - シリアライズする値
    /// * `subject` - メッセージの件名（オプション）
    ///
    /// # 戻り値
    /// * `Ok(PublishResult)` - 発行結果
    /// * `Err(SnsOpsError)` - エラー
    async fn publish_json<T: Serialize + Send + Sync>(
        &self,
        topic_arn: &str,
        value: &T,
        subject: Option<&str>,
    ) -> Result<PublishResult, SnsOpsError> {
        let message = serde_json::to_string(value)
            .map_err(|e| SnsOpsError::SerializeError(e.to_string()))?;

        self.publish(topic_arn, &message, subject).await
    }
}

/// 実際のAWS SNS SDKを使用したSNS操作実装
pub struct AwsSnsOps {
    client: SnsClient,
}

impl AwsSnsOps {
    /// 新しいAwsSnsOpsを作成
    pub fn new(client: SnsClient) -> Self {
        Self { client }
    }

    /// AWS設定からデフォルトのクライアントを作成
    pub async fn from_config() -> Self {
        let config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
        let client = SnsClient::new(&config);
        Self::new(client)
    }
}

#[async_trait]
impl SnsOps for AwsSnsOps {
    async fn publish(
        &self,
        topic_arn: &str,
        message: &str,
        subject: Option<&str>,
    ) -> Result<PublishResult, SnsOpsError> {
        info!(
            topic_arn = %topic_arn,
            message_length = message.len(),
            "SNSメッセージ発行開始"
        );

        let mut request = self
            .client
            .publish()
            .topic_arn(topic_arn)
            .message(message);

        // 件名が指定されている場合は設定
        if let Some(subj) = subject {
            request = request.subject(subj);
        }

        let result = request.send().await;

        match result {
            Ok(response) => {
                let message_id = response.message_id().unwrap_or("unknown").to_string();

                info!(
                    topic_arn = %topic_arn,
                    message_id = %message_id,
                    "SNS Publish成功"
                );

                Ok(PublishResult::success(topic_arn, message_id))
            }
            Err(err) => {
                warn!(
                    topic_arn = %topic_arn,
                    error = %err,
                    "SNS Publishエラー"
                );
                Err(SnsOpsError::AwsSdkError(err.to_string()))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// テスト用のモックSNS操作
    struct MockSnsOps {
        /// 成功させるトピックARNのリスト
        success_topics: Vec<String>,
        /// publish呼び出し回数
        call_count: Arc<AtomicUsize>,
        /// 発行されたメッセージを記録
        published_messages: std::sync::Mutex<Vec<(String, String, Option<String>)>>,
    }

    impl MockSnsOps {
        fn new(success_topics: Vec<String>) -> Self {
            Self {
                success_topics,
                call_count: Arc::new(AtomicUsize::new(0)),
                published_messages: std::sync::Mutex::new(Vec::new()),
            }
        }

        fn call_count(&self) -> usize {
            self.call_count.load(Ordering::SeqCst)
        }

        fn get_published_messages(&self) -> Vec<(String, String, Option<String>)> {
            self.published_messages.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl SnsOps for MockSnsOps {
        async fn publish(
            &self,
            topic_arn: &str,
            message: &str,
            subject: Option<&str>,
        ) -> Result<PublishResult, SnsOpsError> {
            self.call_count.fetch_add(1, Ordering::SeqCst);

            // メッセージを記録
            self.published_messages.lock().unwrap().push((
                topic_arn.to_string(),
                message.to_string(),
                subject.map(|s| s.to_string()),
            ));

            if self.success_topics.contains(&topic_arn.to_string()) {
                Ok(PublishResult::success(
                    topic_arn,
                    format!("mock-message-id-{}", self.call_count()),
                ))
            } else {
                Err(SnsOpsError::AwsSdkError("mock error".to_string()))
            }
        }
    }

    // ==================== PublishResult テスト ====================

    #[test]
    fn test_publish_result_success() {
        let result = PublishResult::success(
            "arn:aws:sns:ap-northeast-1:123456789012:test-topic",
            "msg-123",
        );

        assert!(result.success);
        assert_eq!(result.message_id, "msg-123");
        assert_eq!(
            result.topic_arn,
            "arn:aws:sns:ap-northeast-1:123456789012:test-topic"
        );
        assert!(result.message.contains("msg-123"));
    }

    #[test]
    fn test_publish_result_failure() {
        let result = PublishResult::failure(
            "arn:aws:sns:ap-northeast-1:123456789012:test-topic",
            "API error",
        );

        assert!(!result.success);
        assert!(result.message_id.is_empty());
        assert!(result.message.contains("失敗"));
        assert!(result.message.contains("API error"));
    }

    // ==================== SnsOpsError テスト ====================

    #[test]
    fn test_sns_ops_error_display() {
        let sdk_error = SnsOpsError::AwsSdkError("API呼び出し失敗".to_string());
        assert_eq!(sdk_error.to_string(), "AWS SNS APIエラー: API呼び出し失敗");

        let serialize_error = SnsOpsError::SerializeError("JSONエラー".to_string());
        assert_eq!(
            serialize_error.to_string(),
            "JSONシリアライズエラー: JSONエラー"
        );
    }

    // ==================== MockSnsOps テスト ====================

    #[tokio::test]
    async fn test_mock_sns_ops_publish_success() {
        let mock = MockSnsOps::new(vec![
            "arn:aws:sns:ap-northeast-1:123456789012:test-topic".to_string(),
        ]);

        let result = mock
            .publish(
                "arn:aws:sns:ap-northeast-1:123456789012:test-topic",
                r#"{"test":"message"}"#,
                Some("Test Subject"),
            )
            .await;

        assert!(result.is_ok());
        let result = result.unwrap();
        assert!(result.success);
        assert_eq!(mock.call_count(), 1);

        // メッセージが記録されたことを確認
        let messages = mock.get_published_messages();
        assert_eq!(messages.len(), 1);
        assert_eq!(
            messages[0].0,
            "arn:aws:sns:ap-northeast-1:123456789012:test-topic"
        );
        assert_eq!(messages[0].1, r#"{"test":"message"}"#);
        assert_eq!(messages[0].2, Some("Test Subject".to_string()));
    }

    #[tokio::test]
    async fn test_mock_sns_ops_publish_failure() {
        let mock = MockSnsOps::new(vec![]);

        let result = mock
            .publish(
                "arn:aws:sns:ap-northeast-1:123456789012:unknown-topic",
                r#"{"test":"message"}"#,
                None,
            )
            .await;

        assert!(result.is_err());
        match result.unwrap_err() {
            SnsOpsError::AwsSdkError(_) => {}
            _ => panic!("Expected AwsSdkError"),
        }
        assert_eq!(mock.call_count(), 1);
    }

    #[tokio::test]
    async fn test_mock_sns_ops_publish_without_subject() {
        let mock = MockSnsOps::new(vec![
            "arn:aws:sns:ap-northeast-1:123456789012:test-topic".to_string(),
        ]);

        let result = mock
            .publish(
                "arn:aws:sns:ap-northeast-1:123456789012:test-topic",
                r#"{"test":"message"}"#,
                None,
            )
            .await;

        assert!(result.is_ok());

        // 件名がNoneであることを確認
        let messages = mock.get_published_messages();
        assert_eq!(messages[0].2, None);
    }

    // ==================== publish_json テスト ====================

    #[derive(Debug, Clone, Serialize, Deserialize)]
    struct TestMessage {
        pub name: String,
        pub value: i32,
    }

    #[tokio::test]
    async fn test_publish_json_success() {
        let mock = MockSnsOps::new(vec![
            "arn:aws:sns:ap-northeast-1:123456789012:test-topic".to_string(),
        ]);

        let message = TestMessage {
            name: "test".to_string(),
            value: 42,
        };

        let result = mock
            .publish_json(
                "arn:aws:sns:ap-northeast-1:123456789012:test-topic",
                &message,
                Some("Test"),
            )
            .await;

        assert!(result.is_ok());

        // JSON形式でシリアライズされたことを確認
        let messages = mock.get_published_messages();
        assert_eq!(messages.len(), 1);
        let json: TestMessage = serde_json::from_str(&messages[0].1).unwrap();
        assert_eq!(json.name, "test");
        assert_eq!(json.value, 42);
    }
}
