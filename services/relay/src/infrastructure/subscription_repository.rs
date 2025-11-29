/// DynamoDBでサブスクリプションを管理するためのサブスクリプションリポジトリ
///
/// 要件: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8
use async_trait::async_trait;
use aws_sdk_dynamodb::types::{AttributeValue, DeleteRequest, WriteRequest};
use aws_sdk_dynamodb::Client as DynamoDbClient;
use nostr::{Event, Filter};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

use crate::domain::FilterEvaluator;

/// サブスクリプションリポジトリ操作のエラー型
#[derive(Debug, Error, Clone, PartialEq)]
pub enum SubscriptionRepositoryError {
    /// DynamoDBへの書き込みに失敗
    #[error("Write error: {0}")]
    WriteError(String),

    /// DynamoDBからの読み取りに失敗
    #[error("Read error: {0}")]
    ReadError(String),

    /// データのシリアライズ/デシリアライズに失敗
    #[error("Serialization error: {0}")]
    SerializationError(String),
}

/// マッチしたサブスクリプション情報
#[derive(Debug, Clone, PartialEq)]
pub struct MatchedSubscription {
    /// API Gateway接続ID
    pub connection_id: String,
    /// サブスクリプションID
    pub subscription_id: String,
}

/// サブスクリプション情報
#[derive(Debug, Clone)]
pub struct SubscriptionInfo {
    /// API Gateway接続ID
    pub connection_id: String,
    /// サブスクリプションID
    pub subscription_id: String,
    /// フィルター条件
    pub filters: Vec<Filter>,
    /// 作成日時（Unixタイムスタンプ）
    pub created_at: i64,
}

/// サブスクリプション管理用トレイト
///
/// このトレイトはサブスクリプション永続化機能を抽象化し、
/// 異なる実装を可能にします（実際のDynamoDB、テスト用モック）。
#[async_trait]
pub trait SubscriptionRepository: Send + Sync {
    /// サブスクリプションを保存（既存は上書き）
    ///
    /// # 引数
    /// * `connection_id` - API Gateway接続ID
    /// * `subscription_id` - サブスクリプションID
    /// * `filters` - フィルター条件
    ///
    /// # 戻り値
    /// * 成功時は`Ok(())`
    /// * 失敗時は`Err(SubscriptionRepositoryError)`
    ///
    /// 要件: 18.1, 18.2, 18.4
    async fn upsert(
        &self,
        connection_id: &str,
        subscription_id: &str,
        filters: &[Filter],
    ) -> Result<(), SubscriptionRepositoryError>;

    /// サブスクリプションを削除
    ///
    /// # 引数
    /// * `connection_id` - API Gateway接続ID
    /// * `subscription_id` - サブスクリプションID
    ///
    /// # 戻り値
    /// * 成功時は`Ok(())`（サブスクリプションが存在しなかった場合も含む）
    /// * 失敗時は`Err(SubscriptionRepositoryError)`
    ///
    /// 要件: 18.3
    async fn delete(
        &self,
        connection_id: &str,
        subscription_id: &str,
    ) -> Result<(), SubscriptionRepositoryError>;

    /// 接続の全サブスクリプションを削除
    ///
    /// # 引数
    /// * `connection_id` - API Gateway接続ID
    ///
    /// # 戻り値
    /// * 成功時は`Ok(())`
    /// * 失敗時は`Err(SubscriptionRepositoryError)`
    ///
    /// 要件: 18.5
    async fn delete_by_connection(
        &self,
        connection_id: &str,
    ) -> Result<(), SubscriptionRepositoryError>;

    /// イベントにマッチするサブスクリプションを検索
    ///
    /// # 引数
    /// * `event` - マッチング対象のイベント
    ///
    /// # 戻り値
    /// * 成功時は`Ok(Vec<MatchedSubscription>)`
    /// * 失敗時は`Err(SubscriptionRepositoryError)`
    ///
    /// 要件: 18.6, 18.7
    async fn find_matching(
        &self,
        event: &Event,
    ) -> Result<Vec<MatchedSubscription>, SubscriptionRepositoryError>;

    /// 接続のサブスクリプションを取得
    ///
    /// # 引数
    /// * `connection_id` - API Gateway接続ID
    /// * `subscription_id` - サブスクリプションID
    ///
    /// # 戻り値
    /// * 見つかった場合は`Ok(Some(SubscriptionInfo))`
    /// * 見つからなかった場合は`Ok(None)`
    /// * 失敗時は`Err(SubscriptionRepositoryError)`
    async fn get(
        &self,
        connection_id: &str,
        subscription_id: &str,
    ) -> Result<Option<SubscriptionInfo>, SubscriptionRepositoryError>;

    /// サブスクリプションの存在確認
    ///
    /// # 引数
    /// * `connection_id` - API Gateway接続ID
    /// * `subscription_id` - サブスクリプションID
    ///
    /// # 戻り値
    /// * 成功時は`Ok(exists)` - 存在する場合true
    /// * 失敗時は`Err(SubscriptionRepositoryError)`
    ///
    /// 要件: 3.2
    async fn exists(
        &self,
        connection_id: &str,
        subscription_id: &str,
    ) -> Result<bool, SubscriptionRepositoryError>;

    /// 接続のサブスクリプション数をカウント
    ///
    /// # 引数
    /// * `connection_id` - API Gateway接続ID
    ///
    /// # 戻り値
    /// * 成功時は`Ok(count)`
    /// * 失敗時は`Err(SubscriptionRepositoryError)`
    ///
    /// 要件: 3.2
    async fn count_by_connection(
        &self,
        connection_id: &str,
    ) -> Result<usize, SubscriptionRepositoryError>;
}

/// SubscriptionRepositoryのDynamoDB実装
///
/// この構造体はDynamoDBを使用してサブスクリプション情報を
/// 永続的に保存するSubscriptionRepositoryトレイトを実装します。
#[derive(Debug, Clone)]
pub struct DynamoSubscriptionRepository {
    /// DynamoDBクライアント
    client: DynamoDbClient,
    /// サブスクリプションテーブル名
    table_name: String,
}

impl DynamoSubscriptionRepository {
    /// 新しいDynamoSubscriptionRepositoryを作成
    ///
    /// # 引数
    /// * `client` - DynamoDBクライアント
    /// * `table_name` - サブスクリプションテーブルの名前
    pub fn new(client: DynamoDbClient, table_name: String) -> Self {
        Self { client, table_name }
    }

    /// 現在のUnixタイムスタンプを秒で取得
    fn current_timestamp() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64
    }

    /// フィルター配列をJSON文字列にシリアライズ
    fn serialize_filters(filters: &[Filter]) -> Result<String, SubscriptionRepositoryError> {
        serde_json::to_string(filters)
            .map_err(|e| SubscriptionRepositoryError::SerializationError(e.to_string()))
    }

    /// JSON文字列からフィルター配列をデシリアライズ
    fn deserialize_filters(json: &str) -> Result<Vec<Filter>, SubscriptionRepositoryError> {
        serde_json::from_str(json)
            .map_err(|e| SubscriptionRepositoryError::SerializationError(e.to_string()))
    }
}

#[async_trait]
impl SubscriptionRepository for DynamoSubscriptionRepository {
    async fn upsert(
        &self,
        connection_id: &str,
        subscription_id: &str,
        filters: &[Filter],
    ) -> Result<(), SubscriptionRepositoryError> {
        let created_at = Self::current_timestamp();
        let filters_json = Self::serialize_filters(filters)?;

        self.client
            .put_item()
            .table_name(&self.table_name)
            .item(
                "connection_id",
                AttributeValue::S(connection_id.to_string()),
            )
            .item(
                "subscription_id",
                AttributeValue::S(subscription_id.to_string()),
            )
            .item("filters", AttributeValue::S(filters_json))
            .item("created_at", AttributeValue::N(created_at.to_string()))
            .send()
            .await
            .map_err(|e| SubscriptionRepositoryError::WriteError(e.to_string()))?;

        Ok(())
    }

    async fn delete(
        &self,
        connection_id: &str,
        subscription_id: &str,
    ) -> Result<(), SubscriptionRepositoryError> {
        self.client
            .delete_item()
            .table_name(&self.table_name)
            .key(
                "connection_id",
                AttributeValue::S(connection_id.to_string()),
            )
            .key(
                "subscription_id",
                AttributeValue::S(subscription_id.to_string()),
            )
            .send()
            .await
            .map_err(|e| SubscriptionRepositoryError::WriteError(e.to_string()))?;

        Ok(())
    }

    async fn delete_by_connection(
        &self,
        connection_id: &str,
    ) -> Result<(), SubscriptionRepositoryError> {
        // 接続IDに関連する全サブスクリプションをクエリ
        let result = self
            .client
            .query()
            .table_name(&self.table_name)
            .key_condition_expression("connection_id = :cid")
            .expression_attribute_values(
                ":cid",
                AttributeValue::S(connection_id.to_string()),
            )
            .send()
            .await
            .map_err(|e| SubscriptionRepositoryError::ReadError(e.to_string()))?;

        // 削除リクエストを構築
        if let Some(items) = result.items {
            if items.is_empty() {
                return Ok(());
            }

            // BatchWriteItemは1回最大25件まで
            const BATCH_SIZE: usize = 25;
            let mut write_requests: Vec<WriteRequest> = Vec::new();

            for item in items {
                if let (Some(conn_id), Some(sub_id)) = (
                    item.get("connection_id").and_then(|v| v.as_s().ok()),
                    item.get("subscription_id").and_then(|v| v.as_s().ok()),
                ) {
                    let delete_request = DeleteRequest::builder()
                        .key("connection_id", AttributeValue::S(conn_id.clone()))
                        .key("subscription_id", AttributeValue::S(sub_id.clone()))
                        .build()
                        .map_err(|e| {
                            SubscriptionRepositoryError::WriteError(e.to_string())
                        })?;

                    write_requests.push(WriteRequest::builder().delete_request(delete_request).build());
                }
            }

            // 25件ごとにバッチ処理
            for chunk in write_requests.chunks(BATCH_SIZE) {
                self.client
                    .batch_write_item()
                    .request_items(&self.table_name, chunk.to_vec())
                    .send()
                    .await
                    .map_err(|e| SubscriptionRepositoryError::WriteError(e.to_string()))?;
            }
        }

        Ok(())
    }

    async fn find_matching(
        &self,
        event: &Event,
    ) -> Result<Vec<MatchedSubscription>, SubscriptionRepositoryError> {
        // 全サブスクリプションをスキャン（個人用リレーの規模では十分な性能）
        let result = self
            .client
            .scan()
            .table_name(&self.table_name)
            .send()
            .await
            .map_err(|e| SubscriptionRepositoryError::ReadError(e.to_string()))?;

        let mut matched = Vec::new();

        if let Some(items) = result.items {
            for item in items {
                // 必要なフィールドを抽出
                let connection_id = item
                    .get("connection_id")
                    .and_then(|v| v.as_s().ok())
                    .cloned();
                let subscription_id = item
                    .get("subscription_id")
                    .and_then(|v| v.as_s().ok())
                    .cloned();
                let filters_json = item.get("filters").and_then(|v| v.as_s().ok());

                if let (Some(conn_id), Some(sub_id), Some(json)) =
                    (connection_id, subscription_id, filters_json)
                    && let Ok(filters) = Self::deserialize_filters(json)
                    && FilterEvaluator::matches_any(event, &filters)
                {
                    matched.push(MatchedSubscription {
                        connection_id: conn_id,
                        subscription_id: sub_id,
                    });
                }
            }
        }

        Ok(matched)
    }

    async fn get(
        &self,
        connection_id: &str,
        subscription_id: &str,
    ) -> Result<Option<SubscriptionInfo>, SubscriptionRepositoryError> {
        let result = self
            .client
            .get_item()
            .table_name(&self.table_name)
            .key(
                "connection_id",
                AttributeValue::S(connection_id.to_string()),
            )
            .key(
                "subscription_id",
                AttributeValue::S(subscription_id.to_string()),
            )
            .send()
            .await
            .map_err(|e| SubscriptionRepositoryError::ReadError(e.to_string()))?;

        match result.item {
            Some(item) => {
                let connection_id = item
                    .get("connection_id")
                    .and_then(|v| v.as_s().ok())
                    .ok_or_else(|| {
                        SubscriptionRepositoryError::SerializationError(
                            "Missing connection_id field".to_string(),
                        )
                    })?
                    .clone();

                let subscription_id = item
                    .get("subscription_id")
                    .and_then(|v| v.as_s().ok())
                    .ok_or_else(|| {
                        SubscriptionRepositoryError::SerializationError(
                            "Missing subscription_id field".to_string(),
                        )
                    })?
                    .clone();

                let filters_json = item.get("filters").and_then(|v| v.as_s().ok()).ok_or_else(
                    || {
                        SubscriptionRepositoryError::SerializationError(
                            "Missing filters field".to_string(),
                        )
                    },
                )?;

                let filters = Self::deserialize_filters(filters_json)?;

                let created_at = item
                    .get("created_at")
                    .and_then(|v| v.as_n().ok())
                    .and_then(|n| n.parse::<i64>().ok())
                    .ok_or_else(|| {
                        SubscriptionRepositoryError::SerializationError(
                            "Missing created_at field".to_string(),
                        )
                    })?;

                Ok(Some(SubscriptionInfo {
                    connection_id,
                    subscription_id,
                    filters,
                    created_at,
                }))
            }
            None => Ok(None),
        }
    }

    async fn exists(
        &self,
        connection_id: &str,
        subscription_id: &str,
    ) -> Result<bool, SubscriptionRepositoryError> {
        // GetItemで存在確認（フィールドは取得せず存在確認のみ）
        let result = self
            .client
            .get_item()
            .table_name(&self.table_name)
            .key(
                "connection_id",
                AttributeValue::S(connection_id.to_string()),
            )
            .key(
                "subscription_id",
                AttributeValue::S(subscription_id.to_string()),
            )
            // 存在確認のみなのでconnection_idだけ取得（転送量削減）
            .projection_expression("connection_id")
            .send()
            .await
            .map_err(|e| SubscriptionRepositoryError::ReadError(e.to_string()))?;

        Ok(result.item.is_some())
    }

    async fn count_by_connection(
        &self,
        connection_id: &str,
    ) -> Result<usize, SubscriptionRepositoryError> {
        // QueryでSelect COUNTを使用し効率的にカウント
        let result = self
            .client
            .query()
            .table_name(&self.table_name)
            .key_condition_expression("connection_id = :cid")
            .expression_attribute_values(
                ":cid",
                AttributeValue::S(connection_id.to_string()),
            )
            .select(aws_sdk_dynamodb::types::Select::Count)
            .send()
            .await
            .map_err(|e| SubscriptionRepositoryError::ReadError(e.to_string()))?;

        Ok(result.count() as usize)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind};
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    // ==================== 3.4 サブスクリプションリポジトリテスト ====================

    // SubscriptionRepositoryError表示メッセージのテスト (要件 18.8)
    #[test]
    fn test_subscription_repository_error_write_error_display() {
        let error = SubscriptionRepositoryError::WriteError("conditional check failed".to_string());
        assert_eq!(
            error.to_string(),
            "Write error: conditional check failed"
        );
    }

    #[test]
    fn test_subscription_repository_error_read_error_display() {
        let error = SubscriptionRepositoryError::ReadError("item not found".to_string());
        assert_eq!(error.to_string(), "Read error: item not found");
    }

    #[test]
    fn test_subscription_repository_error_serialization_error_display() {
        let error =
            SubscriptionRepositoryError::SerializationError("invalid format".to_string());
        assert_eq!(error.to_string(), "Serialization error: invalid format");
    }

    // SubscriptionRepositoryError等価性のテスト
    #[test]
    fn test_subscription_repository_error_equality() {
        assert_eq!(
            SubscriptionRepositoryError::WriteError("test".to_string()),
            SubscriptionRepositoryError::WriteError("test".to_string())
        );
        assert_ne!(
            SubscriptionRepositoryError::WriteError("test1".to_string()),
            SubscriptionRepositoryError::WriteError("test2".to_string())
        );
        assert_ne!(
            SubscriptionRepositoryError::WriteError("test".to_string()),
            SubscriptionRepositoryError::ReadError("test".to_string())
        );
    }

    // SubscriptionRepositoryErrorクローンのテスト
    #[test]
    fn test_subscription_repository_error_clone() {
        let error = SubscriptionRepositoryError::WriteError("test".to_string());
        let cloned = error.clone();
        assert_eq!(error, cloned);
    }

    // MatchedSubscriptionフィールドのテスト
    #[test]
    fn test_matched_subscription_fields() {
        let matched = MatchedSubscription {
            connection_id: "conn-123".to_string(),
            subscription_id: "sub-456".to_string(),
        };

        assert_eq!(matched.connection_id, "conn-123");
        assert_eq!(matched.subscription_id, "sub-456");
    }

    // MatchedSubscriptionクローンと等価性のテスト
    #[test]
    fn test_matched_subscription_clone_and_equality() {
        let matched = MatchedSubscription {
            connection_id: "conn-123".to_string(),
            subscription_id: "sub-456".to_string(),
        };
        let cloned = matched.clone();
        assert_eq!(matched, cloned);
    }

    // SubscriptionInfoフィールドのテスト
    #[test]
    fn test_subscription_info_fields() {
        let info = SubscriptionInfo {
            connection_id: "conn-123".to_string(),
            subscription_id: "sub-456".to_string(),
            filters: vec![Filter::new().kind(Kind::TextNote)],
            created_at: 1700000000,
        };

        assert_eq!(info.connection_id, "conn-123");
        assert_eq!(info.subscription_id, "sub-456");
        assert_eq!(info.filters.len(), 1);
        assert_eq!(info.created_at, 1700000000);
    }

    // フィルターシリアライズのテスト
    #[test]
    fn test_serialize_filters() {
        let filters = vec![Filter::new().kind(Kind::TextNote)];
        let json = DynamoSubscriptionRepository::serialize_filters(&filters);
        assert!(json.is_ok());
        let json_str = json.unwrap();
        assert!(json_str.contains("kinds"));
    }

    // フィルターデシリアライズのテスト
    #[test]
    fn test_deserialize_filters() {
        let filters = vec![Filter::new().kind(Kind::TextNote)];
        let json = DynamoSubscriptionRepository::serialize_filters(&filters).unwrap();
        let deserialized = DynamoSubscriptionRepository::deserialize_filters(&json);
        assert!(deserialized.is_ok());
        let result = deserialized.unwrap();
        assert_eq!(result.len(), 1);
    }

    // 空フィルターのシリアライズ/デシリアライズテスト
    #[test]
    fn test_serialize_deserialize_empty_filters() {
        let filters: Vec<Filter> = vec![];
        let json = DynamoSubscriptionRepository::serialize_filters(&filters).unwrap();
        let deserialized = DynamoSubscriptionRepository::deserialize_filters(&json).unwrap();
        assert!(deserialized.is_empty());
    }

    // 不正なJSONのデシリアライズエラーテスト
    #[test]
    fn test_deserialize_invalid_json() {
        let result = DynamoSubscriptionRepository::deserialize_filters("invalid json");
        assert!(result.is_err());
        match result.unwrap_err() {
            SubscriptionRepositoryError::SerializationError(_) => {}
            _ => panic!("Expected SerializationError"),
        }
    }

    // current_timestampが妥当な値を返すテスト
    #[test]
    fn test_current_timestamp() {
        let timestamp = DynamoSubscriptionRepository::current_timestamp();

        // 2020年1月1日（1577836800）より後であるべき
        assert!(timestamp > 1577836800);
        // 3000年より前であるべき（健全性チェック）
        assert!(timestamp < 32503680000);
    }

    // ==================== モックサブスクリプションリポジトリ ====================

    /// ユニットテスト用のモックSubscriptionRepository
    #[derive(Debug, Clone)]
    pub struct MockSubscriptionRepository {
        /// 保存されたサブスクリプション: (connection_id, subscription_id) -> SubscriptionInfo
        subscriptions: Arc<Mutex<HashMap<(String, String), SubscriptionInfo>>>,
        /// 次の操作で返すエラー（エラーパスのテスト用）
        next_error: Arc<Mutex<Option<SubscriptionRepositoryError>>>,
        /// upsert操作専用のエラー（他の操作では消費されない）
        upsert_error: Arc<Mutex<Option<SubscriptionRepositoryError>>>,
    }

    impl MockSubscriptionRepository {
        pub fn new() -> Self {
            Self {
                subscriptions: Arc::new(Mutex::new(HashMap::new())),
                next_error: Arc::new(Mutex::new(None)),
                upsert_error: Arc::new(Mutex::new(None)),
            }
        }

        pub fn set_next_error(&self, error: SubscriptionRepositoryError) {
            *self.next_error.lock().unwrap() = Some(error);
        }

        /// upsert操作専用のエラーを設定（他の操作では消費されない）
        pub fn set_upsert_error(&self, error: SubscriptionRepositoryError) {
            *self.upsert_error.lock().unwrap() = Some(error);
        }

        pub fn subscription_count(&self) -> usize {
            self.subscriptions.lock().unwrap().len()
        }

        pub fn get_subscription_sync(
            &self,
            connection_id: &str,
            subscription_id: &str,
        ) -> Option<SubscriptionInfo> {
            self.subscriptions
                .lock()
                .unwrap()
                .get(&(connection_id.to_string(), subscription_id.to_string()))
                .cloned()
        }

        fn take_error(&self) -> Option<SubscriptionRepositoryError> {
            self.next_error.lock().unwrap().take()
        }

        fn take_upsert_error(&self) -> Option<SubscriptionRepositoryError> {
            self.upsert_error.lock().unwrap().take()
        }

        fn current_timestamp() -> i64 {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64
        }
    }

    #[async_trait]
    impl SubscriptionRepository for MockSubscriptionRepository {
        async fn upsert(
            &self,
            connection_id: &str,
            subscription_id: &str,
            filters: &[Filter],
        ) -> Result<(), SubscriptionRepositoryError> {
            // upsert専用エラーを優先的にチェック
            if let Some(error) = self.take_upsert_error() {
                return Err(error);
            }
            // 汎用エラーもチェック
            if let Some(error) = self.take_error() {
                return Err(error);
            }

            let info = SubscriptionInfo {
                connection_id: connection_id.to_string(),
                subscription_id: subscription_id.to_string(),
                filters: filters.to_vec(),
                created_at: Self::current_timestamp(),
            };

            self.subscriptions
                .lock()
                .unwrap()
                .insert((connection_id.to_string(), subscription_id.to_string()), info);

            Ok(())
        }

        async fn delete(
            &self,
            connection_id: &str,
            subscription_id: &str,
        ) -> Result<(), SubscriptionRepositoryError> {
            if let Some(error) = self.take_error() {
                return Err(error);
            }

            self.subscriptions
                .lock()
                .unwrap()
                .remove(&(connection_id.to_string(), subscription_id.to_string()));

            Ok(())
        }

        async fn delete_by_connection(
            &self,
            connection_id: &str,
        ) -> Result<(), SubscriptionRepositoryError> {
            if let Some(error) = self.take_error() {
                return Err(error);
            }

            self.subscriptions
                .lock()
                .unwrap()
                .retain(|(conn_id, _), _| conn_id != connection_id);

            Ok(())
        }

        async fn find_matching(
            &self,
            event: &Event,
        ) -> Result<Vec<MatchedSubscription>, SubscriptionRepositoryError> {
            if let Some(error) = self.take_error() {
                return Err(error);
            }

            let subscriptions = self.subscriptions.lock().unwrap();
            let mut matched = Vec::new();

            for ((conn_id, sub_id), info) in subscriptions.iter() {
                if FilterEvaluator::matches_any(event, &info.filters) {
                    matched.push(MatchedSubscription {
                        connection_id: conn_id.clone(),
                        subscription_id: sub_id.clone(),
                    });
                }
            }

            Ok(matched)
        }

        async fn get(
            &self,
            connection_id: &str,
            subscription_id: &str,
        ) -> Result<Option<SubscriptionInfo>, SubscriptionRepositoryError> {
            if let Some(error) = self.take_error() {
                return Err(error);
            }

            Ok(self
                .subscriptions
                .lock()
                .unwrap()
                .get(&(connection_id.to_string(), subscription_id.to_string()))
                .cloned())
        }

        async fn exists(
            &self,
            connection_id: &str,
            subscription_id: &str,
        ) -> Result<bool, SubscriptionRepositoryError> {
            if let Some(error) = self.take_error() {
                return Err(error);
            }

            Ok(self
                .subscriptions
                .lock()
                .unwrap()
                .contains_key(&(connection_id.to_string(), subscription_id.to_string())))
        }

        async fn count_by_connection(
            &self,
            connection_id: &str,
        ) -> Result<usize, SubscriptionRepositoryError> {
            if let Some(error) = self.take_error() {
                return Err(error);
            }

            let subscriptions = self.subscriptions.lock().unwrap();
            let count = subscriptions
                .keys()
                .filter(|(conn_id, _)| conn_id == connection_id)
                .count();

            Ok(count)
        }
    }

    // ==================== モックリポジトリを使用したテスト ====================

    // MockSubscriptionRepository upsert成功のテスト (要件 18.1, 18.2)
    #[tokio::test]
    async fn test_mock_repo_upsert_success() {
        let repo = MockSubscriptionRepository::new();
        let filters = vec![Filter::new().kind(Kind::TextNote)];

        let result = repo.upsert("conn-123", "sub-456", &filters).await;

        assert!(result.is_ok());
        assert_eq!(repo.subscription_count(), 1);

        let info = repo.get_subscription_sync("conn-123", "sub-456").unwrap();
        assert_eq!(info.connection_id, "conn-123");
        assert_eq!(info.subscription_id, "sub-456");
        assert_eq!(info.filters.len(), 1);
        assert!(info.created_at > 0);
    }

    // 複数サブスクリプション保存のテスト (要件 18.1)
    #[tokio::test]
    async fn test_mock_repo_upsert_multiple() {
        let repo = MockSubscriptionRepository::new();
        let filters = vec![Filter::new().kind(Kind::TextNote)];

        repo.upsert("conn-1", "sub-1", &filters).await.unwrap();
        repo.upsert("conn-1", "sub-2", &filters).await.unwrap();
        repo.upsert("conn-2", "sub-1", &filters).await.unwrap();

        assert_eq!(repo.subscription_count(), 3);
    }

    // 同じsubscription_idで上書きするテスト (要件 18.4)
    #[tokio::test]
    async fn test_mock_repo_upsert_overwrite() {
        let repo = MockSubscriptionRepository::new();
        let old_filters = vec![Filter::new().kind(Kind::TextNote)];
        let new_filters = vec![Filter::new().kind(Kind::Metadata)];

        repo.upsert("conn-123", "sub-456", &old_filters)
            .await
            .unwrap();
        repo.upsert("conn-123", "sub-456", &new_filters)
            .await
            .unwrap();

        assert_eq!(repo.subscription_count(), 1);
        let info = repo.get_subscription_sync("conn-123", "sub-456").unwrap();
        // 新しいフィルターで上書きされているはず
        assert!(info.filters[0].kinds.is_some());
    }

    // 削除成功のテスト (要件 18.3)
    #[tokio::test]
    async fn test_mock_repo_delete_success() {
        let repo = MockSubscriptionRepository::new();
        let filters = vec![Filter::new().kind(Kind::TextNote)];

        repo.upsert("conn-123", "sub-456", &filters).await.unwrap();
        assert_eq!(repo.subscription_count(), 1);

        let result = repo.delete("conn-123", "sub-456").await;
        assert!(result.is_ok());
        assert_eq!(repo.subscription_count(), 0);
    }

    // 存在しないサブスクリプションの削除のテスト (要件 18.3)
    #[tokio::test]
    async fn test_mock_repo_delete_non_existent() {
        let repo = MockSubscriptionRepository::new();

        let result = repo.delete("non-existent", "sub").await;
        assert!(result.is_ok());
    }

    // 接続の全サブスクリプション削除のテスト (要件 18.5)
    #[tokio::test]
    async fn test_mock_repo_delete_by_connection() {
        let repo = MockSubscriptionRepository::new();
        let filters = vec![Filter::new().kind(Kind::TextNote)];

        repo.upsert("conn-1", "sub-1", &filters).await.unwrap();
        repo.upsert("conn-1", "sub-2", &filters).await.unwrap();
        repo.upsert("conn-2", "sub-1", &filters).await.unwrap();

        assert_eq!(repo.subscription_count(), 3);

        let result = repo.delete_by_connection("conn-1").await;
        assert!(result.is_ok());

        assert_eq!(repo.subscription_count(), 1);
        assert!(repo.get_subscription_sync("conn-1", "sub-1").is_none());
        assert!(repo.get_subscription_sync("conn-1", "sub-2").is_none());
        assert!(repo.get_subscription_sync("conn-2", "sub-1").is_some());
    }

    // マッチするサブスクリプション検索のテスト (要件 18.6, 18.7)
    #[tokio::test]
    async fn test_mock_repo_find_matching() {
        let repo = MockSubscriptionRepository::new();

        // kind=1のフィルターを持つサブスクリプション
        let filters1 = vec![Filter::new().kind(Kind::TextNote)];
        repo.upsert("conn-1", "sub-1", &filters1).await.unwrap();

        // kind=0のフィルターを持つサブスクリプション
        let filters2 = vec![Filter::new().kind(Kind::Metadata)];
        repo.upsert("conn-2", "sub-2", &filters2).await.unwrap();

        // kind=1のイベントを作成
        let keys = Keys::generate();
        let event = EventBuilder::text_note("test content")
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        let result = repo.find_matching(&event).await;
        assert!(result.is_ok());

        let matched = result.unwrap();
        assert_eq!(matched.len(), 1);
        assert_eq!(matched[0].connection_id, "conn-1");
        assert_eq!(matched[0].subscription_id, "sub-1");
    }

    // マッチするサブスクリプションがない場合のテスト
    #[tokio::test]
    async fn test_mock_repo_find_matching_no_match() {
        let repo = MockSubscriptionRepository::new();

        // kind=0のフィルターを持つサブスクリプション
        let filters = vec![Filter::new().kind(Kind::Metadata)];
        repo.upsert("conn-1", "sub-1", &filters).await.unwrap();

        // kind=1のイベントを作成
        let keys = Keys::generate();
        let event = EventBuilder::text_note("test content")
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        let result = repo.find_matching(&event).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    // 複数マッチのテスト (要件 18.6)
    #[tokio::test]
    async fn test_mock_repo_find_matching_multiple() {
        let repo = MockSubscriptionRepository::new();

        // 両方ともkind=1のフィルターを持つ
        let filters = vec![Filter::new().kind(Kind::TextNote)];
        repo.upsert("conn-1", "sub-1", &filters).await.unwrap();
        repo.upsert("conn-2", "sub-2", &filters).await.unwrap();

        // kind=1のイベントを作成
        let keys = Keys::generate();
        let event = EventBuilder::text_note("test content")
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        let result = repo.find_matching(&event).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 2);
    }

    // getテスト
    #[tokio::test]
    async fn test_mock_repo_get_success() {
        let repo = MockSubscriptionRepository::new();
        let filters = vec![Filter::new().kind(Kind::TextNote)];

        repo.upsert("conn-123", "sub-456", &filters).await.unwrap();

        let result = repo.get("conn-123", "sub-456").await;
        assert!(result.is_ok());

        let info = result.unwrap().unwrap();
        assert_eq!(info.connection_id, "conn-123");
        assert_eq!(info.subscription_id, "sub-456");
    }

    // 存在しないサブスクリプションの取得テスト
    #[tokio::test]
    async fn test_mock_repo_get_non_existent() {
        let repo = MockSubscriptionRepository::new();

        let result = repo.get("non-existent", "sub").await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }

    // エラーパスのテスト (要件 18.8)
    #[tokio::test]
    async fn test_mock_repo_upsert_error() {
        let repo = MockSubscriptionRepository::new();
        repo.set_next_error(SubscriptionRepositoryError::WriteError(
            "DynamoDB unavailable".to_string(),
        ));

        let result = repo.upsert("conn-123", "sub-456", &[]).await;

        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            SubscriptionRepositoryError::WriteError("DynamoDB unavailable".to_string())
        );
    }

    #[tokio::test]
    async fn test_mock_repo_delete_error() {
        let repo = MockSubscriptionRepository::new();
        repo.set_next_error(SubscriptionRepositoryError::WriteError(
            "DynamoDB unavailable".to_string(),
        ));

        let result = repo.delete("conn-123", "sub-456").await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_mock_repo_delete_by_connection_error() {
        let repo = MockSubscriptionRepository::new();
        repo.set_next_error(SubscriptionRepositoryError::ReadError(
            "DynamoDB unavailable".to_string(),
        ));

        let result = repo.delete_by_connection("conn-123").await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_mock_repo_find_matching_error() {
        let repo = MockSubscriptionRepository::new();
        repo.set_next_error(SubscriptionRepositoryError::ReadError(
            "DynamoDB unavailable".to_string(),
        ));

        let keys = Keys::generate();
        let event = EventBuilder::text_note("test")
            .sign_with_keys(&keys)
            .expect("Failed to create event");

        let result = repo.find_matching(&event).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_mock_repo_get_error() {
        let repo = MockSubscriptionRepository::new();
        repo.set_next_error(SubscriptionRepositoryError::ReadError(
            "DynamoDB unavailable".to_string(),
        ));

        let result = repo.get("conn-123", "sub-456").await;

        assert!(result.is_err());
    }

    // 1つの削除が他に影響しないテスト
    #[tokio::test]
    async fn test_delete_does_not_affect_others() {
        let repo = MockSubscriptionRepository::new();
        let filters = vec![Filter::new().kind(Kind::TextNote)];

        repo.upsert("conn-1", "sub-1", &filters).await.unwrap();
        repo.upsert("conn-1", "sub-2", &filters).await.unwrap();
        repo.upsert("conn-2", "sub-1", &filters).await.unwrap();

        repo.delete("conn-1", "sub-1").await.unwrap();

        assert_eq!(repo.subscription_count(), 2);
        assert!(repo.get_subscription_sync("conn-1", "sub-1").is_none());
        assert!(repo.get_subscription_sync("conn-1", "sub-2").is_some());
        assert!(repo.get_subscription_sync("conn-2", "sub-1").is_some());
    }

    // フィルター条件がJSON形式で保存されることのテスト (要件 18.2)
    #[test]
    fn test_filters_stored_as_json() {
        let filters = vec![
            Filter::new().kind(Kind::TextNote),
            Filter::new().kind(Kind::Metadata),
        ];
        let json = DynamoSubscriptionRepository::serialize_filters(&filters).unwrap();

        // JSONとしてパース可能であることを確認
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(parsed.is_array());

        // 元に戻せることを確認
        let restored = DynamoSubscriptionRepository::deserialize_filters(&json).unwrap();
        assert_eq!(restored.len(), 2);
    }

    // ==================== exists / count_by_connection テスト (Task 5) ====================

    // exists: サブスクリプションが存在する場合trueを返す (要件 3.2)
    #[tokio::test]
    async fn test_mock_repo_exists_returns_true_when_exists() {
        let repo = MockSubscriptionRepository::new();
        let filters = vec![Filter::new().kind(Kind::TextNote)];

        repo.upsert("conn-123", "sub-456", &filters).await.unwrap();

        let result = repo.exists("conn-123", "sub-456").await;
        assert!(result.is_ok());
        assert!(result.unwrap());
    }

    // exists: サブスクリプションが存在しない場合falseを返す (要件 3.2)
    #[tokio::test]
    async fn test_mock_repo_exists_returns_false_when_not_exists() {
        let repo = MockSubscriptionRepository::new();

        let result = repo.exists("conn-123", "sub-456").await;
        assert!(result.is_ok());
        assert!(!result.unwrap());
    }

    // exists: 異なるconnection_idの場合falseを返す
    #[tokio::test]
    async fn test_mock_repo_exists_different_connection_id() {
        let repo = MockSubscriptionRepository::new();
        let filters = vec![Filter::new().kind(Kind::TextNote)];

        repo.upsert("conn-123", "sub-456", &filters).await.unwrap();

        let result = repo.exists("conn-different", "sub-456").await;
        assert!(result.is_ok());
        assert!(!result.unwrap());
    }

    // exists: 異なるsubscription_idの場合falseを返す
    #[tokio::test]
    async fn test_mock_repo_exists_different_subscription_id() {
        let repo = MockSubscriptionRepository::new();
        let filters = vec![Filter::new().kind(Kind::TextNote)];

        repo.upsert("conn-123", "sub-456", &filters).await.unwrap();

        let result = repo.exists("conn-123", "sub-different").await;
        assert!(result.is_ok());
        assert!(!result.unwrap());
    }

    // exists: エラーパスのテスト
    #[tokio::test]
    async fn test_mock_repo_exists_error() {
        let repo = MockSubscriptionRepository::new();
        repo.set_next_error(SubscriptionRepositoryError::ReadError(
            "DynamoDB unavailable".to_string(),
        ));

        let result = repo.exists("conn-123", "sub-456").await;
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            SubscriptionRepositoryError::ReadError("DynamoDB unavailable".to_string())
        );
    }

    // count_by_connection: サブスクリプションがない場合0を返す (要件 3.2)
    #[tokio::test]
    async fn test_mock_repo_count_by_connection_returns_zero_when_empty() {
        let repo = MockSubscriptionRepository::new();

        let result = repo.count_by_connection("conn-123").await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 0);
    }

    // count_by_connection: 1つのサブスクリプションがある場合1を返す (要件 3.2)
    #[tokio::test]
    async fn test_mock_repo_count_by_connection_returns_one() {
        let repo = MockSubscriptionRepository::new();
        let filters = vec![Filter::new().kind(Kind::TextNote)];

        repo.upsert("conn-123", "sub-1", &filters).await.unwrap();

        let result = repo.count_by_connection("conn-123").await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 1);
    }

    // count_by_connection: 複数のサブスクリプションがある場合正しい数を返す (要件 3.2)
    #[tokio::test]
    async fn test_mock_repo_count_by_connection_returns_multiple() {
        let repo = MockSubscriptionRepository::new();
        let filters = vec![Filter::new().kind(Kind::TextNote)];

        repo.upsert("conn-123", "sub-1", &filters).await.unwrap();
        repo.upsert("conn-123", "sub-2", &filters).await.unwrap();
        repo.upsert("conn-123", "sub-3", &filters).await.unwrap();

        let result = repo.count_by_connection("conn-123").await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 3);
    }

    // count_by_connection: 他の接続のサブスクリプションをカウントしない (要件 3.2)
    #[tokio::test]
    async fn test_mock_repo_count_by_connection_only_counts_specified_connection() {
        let repo = MockSubscriptionRepository::new();
        let filters = vec![Filter::new().kind(Kind::TextNote)];

        repo.upsert("conn-123", "sub-1", &filters).await.unwrap();
        repo.upsert("conn-123", "sub-2", &filters).await.unwrap();
        repo.upsert("conn-456", "sub-1", &filters).await.unwrap();
        repo.upsert("conn-789", "sub-1", &filters).await.unwrap();

        let result = repo.count_by_connection("conn-123").await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 2);

        let result = repo.count_by_connection("conn-456").await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 1);
    }

    // count_by_connection: エラーパスのテスト
    #[tokio::test]
    async fn test_mock_repo_count_by_connection_error() {
        let repo = MockSubscriptionRepository::new();
        repo.set_next_error(SubscriptionRepositoryError::ReadError(
            "DynamoDB unavailable".to_string(),
        ));

        let result = repo.count_by_connection("conn-123").await;
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            SubscriptionRepositoryError::ReadError("DynamoDB unavailable".to_string())
        );
    }

    // count_by_connection: サブスクリプション削除後の正しいカウント
    #[tokio::test]
    async fn test_mock_repo_count_by_connection_after_delete() {
        let repo = MockSubscriptionRepository::new();
        let filters = vec![Filter::new().kind(Kind::TextNote)];

        repo.upsert("conn-123", "sub-1", &filters).await.unwrap();
        repo.upsert("conn-123", "sub-2", &filters).await.unwrap();
        repo.upsert("conn-123", "sub-3", &filters).await.unwrap();

        repo.delete("conn-123", "sub-2").await.unwrap();

        let result = repo.count_by_connection("conn-123").await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 2);
    }
}
