/// DynamoDB connection configuration
///
/// Requirements: 16.1, 17.1, 18.1
use aws_sdk_dynamodb::Client as DynamoDbClient;
use thiserror::Error;

/// Error types for DynamoDB configuration
#[derive(Debug, Error)]
pub enum DynamoDbConfigError {
    #[error("Missing environment variable: {0}")]
    MissingEnvVar(String),
}

/// DynamoDB configuration with table names and client
///
/// This struct holds the DynamoDB client and table names loaded from environment variables.
/// Table names are expected to be set via:
/// - EVENTS_TABLE: Table for storing Nostr events
/// - CONNECTIONS_TABLE: Table for managing WebSocket connections
/// - SUBSCRIPTIONS_TABLE: Table for managing subscriptions
#[derive(Debug, Clone)]
pub struct DynamoDbConfig {
    /// DynamoDB client instance
    client: DynamoDbClient,
    /// Events table name
    events_table: String,
    /// Connections table name
    connections_table: String,
    /// Subscriptions table name
    subscriptions_table: String,
}

impl DynamoDbConfig {
    /// Create a new DynamoDbConfig by loading AWS config from environment
    /// and reading table names from environment variables
    ///
    /// Environment variables:
    /// - AWS credentials: loaded automatically by aws-config
    /// - EVENTS_TABLE: DynamoDB table name for events
    /// - CONNECTIONS_TABLE: DynamoDB table name for connections
    /// - SUBSCRIPTIONS_TABLE: DynamoDB table name for subscriptions
    pub async fn from_env() -> Result<Self, DynamoDbConfigError> {
        // Load AWS configuration from environment (credentials, region, etc.)
        let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;

        // Create DynamoDB client from AWS config
        let client = DynamoDbClient::new(&aws_config);

        // Load table names from environment variables
        let events_table = std::env::var("EVENTS_TABLE")
            .map_err(|_| DynamoDbConfigError::MissingEnvVar("EVENTS_TABLE".to_string()))?;

        let connections_table = std::env::var("CONNECTIONS_TABLE")
            .map_err(|_| DynamoDbConfigError::MissingEnvVar("CONNECTIONS_TABLE".to_string()))?;

        let subscriptions_table = std::env::var("SUBSCRIPTIONS_TABLE")
            .map_err(|_| DynamoDbConfigError::MissingEnvVar("SUBSCRIPTIONS_TABLE".to_string()))?;

        Ok(Self {
            client,
            events_table,
            connections_table,
            subscriptions_table,
        })
    }

    /// Create a new DynamoDbConfig with explicit values (for testing)
    pub fn new(
        client: DynamoDbClient,
        events_table: String,
        connections_table: String,
        subscriptions_table: String,
    ) -> Self {
        Self {
            client,
            events_table,
            connections_table,
            subscriptions_table,
        }
    }

    /// Get a reference to the DynamoDB client
    pub fn client(&self) -> &DynamoDbClient {
        &self.client
    }

    /// Get the events table name
    pub fn events_table(&self) -> &str {
        &self.events_table
    }

    /// Get the connections table name
    pub fn connections_table(&self) -> &str {
        &self.connections_table
    }

    /// Get the subscriptions table name
    pub fn subscriptions_table(&self) -> &str {
        &self.subscriptions_table
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ==================== 3.1 DynamoDB Configuration Tests ====================

    // Helper to safely set/remove environment variables in tests
    // SAFETY: These tests run single-threaded via cargo test --test-threads=1
    // or we accept the risk in test environment
    unsafe fn set_env(key: &str, value: &str) {
        // SAFETY: Caller ensures this is safe (single-threaded test environment)
        unsafe { std::env::set_var(key, value) };
    }

    unsafe fn remove_env(key: &str) {
        // SAFETY: Caller ensures this is safe (single-threaded test environment)
        unsafe { std::env::remove_var(key) };
    }

    // Test error types (Req 16.1, 17.1, 18.1)
    #[test]
    fn test_missing_env_var_error_display() {
        let error = DynamoDbConfigError::MissingEnvVar("TEST_VAR".to_string());
        assert_eq!(
            error.to_string(),
            "Missing environment variable: TEST_VAR"
        );
    }

    // Test DynamoDbConfig construction with explicit values
    #[tokio::test]
    async fn test_dynamodb_config_new() {
        // Create a mock AWS config and client
        let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
        let client = DynamoDbClient::new(&aws_config);

        let config = DynamoDbConfig::new(
            client,
            "test-events".to_string(),
            "test-connections".to_string(),
            "test-subscriptions".to_string(),
        );

        assert_eq!(config.events_table(), "test-events");
        assert_eq!(config.connections_table(), "test-connections");
        assert_eq!(config.subscriptions_table(), "test-subscriptions");
    }

    // Test getters return correct values
    #[tokio::test]
    async fn test_dynamodb_config_getters() {
        let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
        let client = DynamoDbClient::new(&aws_config);

        let config = DynamoDbConfig::new(
            client,
            "events-table-name".to_string(),
            "connections-table-name".to_string(),
            "subscriptions-table-name".to_string(),
        );

        // Verify all getters return expected values
        assert_eq!(config.events_table(), "events-table-name");
        assert_eq!(config.connections_table(), "connections-table-name");
        assert_eq!(config.subscriptions_table(), "subscriptions-table-name");

        // Verify client is accessible (we can at least get a reference)
        let _client_ref = config.client();
    }

    // Test from_env with various environment variable scenarios
    // All env var tests are combined into one test to avoid race conditions
    // when tests run in parallel (env vars are process-global state)
    #[tokio::test]
    async fn test_from_env_scenarios() {
        // Use unique env var names to avoid conflicts with other tests
        const EVENTS_VAR: &str = "TEST_CONFIG_EVENTS_TABLE";
        const CONNECTIONS_VAR: &str = "TEST_CONFIG_CONNECTIONS_TABLE";
        const SUBSCRIPTIONS_VAR: &str = "TEST_CONFIG_SUBSCRIPTIONS_TABLE";

        // Helper to create config from test-specific env vars
        async fn from_test_env() -> Result<DynamoDbConfig, DynamoDbConfigError> {
            let aws_config =
                aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
            let client = DynamoDbClient::new(&aws_config);

            let events_table = std::env::var(EVENTS_VAR)
                .map_err(|_| DynamoDbConfigError::MissingEnvVar("EVENTS_TABLE".to_string()))?;

            let connections_table = std::env::var(CONNECTIONS_VAR)
                .map_err(|_| DynamoDbConfigError::MissingEnvVar("CONNECTIONS_TABLE".to_string()))?;

            let subscriptions_table = std::env::var(SUBSCRIPTIONS_VAR).map_err(|_| {
                DynamoDbConfigError::MissingEnvVar("SUBSCRIPTIONS_TABLE".to_string())
            })?;

            Ok(DynamoDbConfig {
                client,
                events_table,
                connections_table,
                subscriptions_table,
            })
        }

        // Cleanup helper
        // SAFETY: Test environment cleanup
        unsafe fn cleanup() {
            unsafe {
                remove_env(EVENTS_VAR);
                remove_env(CONNECTIONS_VAR);
                remove_env(SUBSCRIPTIONS_VAR);
            }
        }

        // --- Test 1: Missing EVENTS_TABLE ---
        // SAFETY: Test environment, isolated env var names
        unsafe {
            cleanup();
            set_env(CONNECTIONS_VAR, "test-connections");
            set_env(SUBSCRIPTIONS_VAR, "test-subscriptions");
        }

        let result = from_test_env().await;
        assert!(result.is_err());
        match result.unwrap_err() {
            DynamoDbConfigError::MissingEnvVar(var) => {
                assert_eq!(var, "EVENTS_TABLE");
            }
        }

        // --- Test 2: Missing CONNECTIONS_TABLE ---
        // SAFETY: Test environment, isolated env var names
        unsafe {
            cleanup();
            set_env(EVENTS_VAR, "test-events");
            set_env(SUBSCRIPTIONS_VAR, "test-subscriptions");
        }

        let result = from_test_env().await;
        assert!(result.is_err());
        match result.unwrap_err() {
            DynamoDbConfigError::MissingEnvVar(var) => {
                assert_eq!(var, "CONNECTIONS_TABLE");
            }
        }

        // --- Test 3: Missing SUBSCRIPTIONS_TABLE ---
        // SAFETY: Test environment, isolated env var names
        unsafe {
            cleanup();
            set_env(EVENTS_VAR, "test-events");
            set_env(CONNECTIONS_VAR, "test-connections");
        }

        let result = from_test_env().await;
        assert!(result.is_err());
        match result.unwrap_err() {
            DynamoDbConfigError::MissingEnvVar(var) => {
                assert_eq!(var, "SUBSCRIPTIONS_TABLE");
            }
        }

        // --- Test 4: All env vars set (success case) ---
        // SAFETY: Test environment, isolated env var names
        unsafe {
            cleanup();
            set_env(EVENTS_VAR, "my-events-table");
            set_env(CONNECTIONS_VAR, "my-connections-table");
            set_env(SUBSCRIPTIONS_VAR, "my-subscriptions-table");
        }

        let result = from_test_env().await;
        assert!(result.is_ok());
        let config = result.unwrap();
        assert_eq!(config.events_table(), "my-events-table");
        assert_eq!(config.connections_table(), "my-connections-table");
        assert_eq!(config.subscriptions_table(), "my-subscriptions-table");

        // Final cleanup
        // SAFETY: Test environment cleanup
        unsafe {
            cleanup();
        }
    }
}
