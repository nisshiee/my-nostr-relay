//! 削除処理モジュール
//!
//! NIP-09削除リクエストの処理を統括し、削除対象の抽出・検証・削除を実行する。
//! Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 4.1, 5.1, 5.2

use nostr::Event;
use thiserror::Error;

use crate::domain::{DeletionTarget, DeletionTargetKind, DeletionValidator};
use crate::infrastructure::{EventRepository, EventRepositoryError, SaveResult};

/// 削除処理結果
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeletionResult {
    /// 削除に成功したイベント数
    pub deleted_count: usize,
    /// スキップしたイベント数（pubkey不一致、存在しない、kind:5等）
    pub skipped_count: usize,
}

/// 削除処理エラー
#[derive(Debug, Error, Clone, PartialEq)]
pub enum DeletionError {
    /// リポジトリエラー
    #[error("Repository error: {0}")]
    RepositoryError(String),
}

impl From<EventRepositoryError> for DeletionError {
    fn from(err: EventRepositoryError) -> Self {
        DeletionError::RepositoryError(err.to_string())
    }
}

/// 削除ロジックモジュール
///
/// kind:5削除リクエストの処理を統括し、削除対象の抽出・検証・削除を実行する。
pub struct DeletionHandler<ER>
where
    ER: EventRepository,
{
    /// イベントリポジトリ
    event_repo: ER,
}

impl<ER> DeletionHandler<ER>
where
    ER: EventRepository,
{
    /// 新しいDeletionHandlerを作成
    pub fn new(event_repo: ER) -> Self {
        Self { event_repo }
    }

    /// 削除リクエストイベントを処理
    ///
    /// # Arguments
    /// * `deletion_event` - kind:5の削除リクエストイベント
    ///
    /// # Returns
    /// * `Ok(DeletionResult)` - 削除処理結果
    /// * `Err(DeletionError)` - 処理エラー
    ///
    /// # Processing
    /// 1. 削除対象を抽出（eタグ・aタグ）
    /// 2. 各対象に対して検証・削除を実行
    ///    - eタグ: イベント取得 → pubkey検証 → kind:5保護チェック → 物理削除
    ///    - aタグ: Addressable検索 → 時刻境界フィルタ → 物理削除
    /// 3. 削除リクエストイベント自体を保存
    pub async fn process_deletion(
        &self,
        deletion_event: &Event,
    ) -> Result<DeletionResult, DeletionError> {
        let mut deleted_count = 0;
        let mut skipped_count = 0;

        // 1. 削除対象を抽出
        let targets = DeletionTarget::parse_from_event(deletion_event);

        // 2. 各削除対象を処理
        for target in targets {
            match &target.target {
                DeletionTargetKind::EventId(event_id) => {
                    // eタグ対象の処理
                    match self.process_event_id_deletion(&target, event_id).await {
                        Ok(true) => deleted_count += 1,
                        Ok(false) => skipped_count += 1,
                        Err(e) => {
                            // エラーはログして継続（部分的な削除を許容）
                            tracing::warn!(
                                event_id = %event_id,
                                error = %e,
                                "eタグ削除処理中にエラー発生、スキップして継続"
                            );
                            skipped_count += 1;
                        }
                    }
                }
                DeletionTargetKind::Address { kind, pubkey, d_tag } => {
                    // aタグ対象の処理
                    match self
                        .process_address_deletion(&target, *kind, pubkey, d_tag)
                        .await
                    {
                        Ok(count) => {
                            if count > 0 {
                                deleted_count += count;
                            } else {
                                skipped_count += 1;
                            }
                        }
                        Err(e) => {
                            tracing::warn!(
                                kind = *kind,
                                pubkey = %pubkey,
                                d_tag = %d_tag,
                                error = %e,
                                "aタグ削除処理中にエラー発生、スキップして継続"
                            );
                            skipped_count += 1;
                        }
                    }
                }
            }
        }

        // 3. 削除リクエストイベント自体を保存
        match self.event_repo.save(deletion_event).await {
            Ok(SaveResult::Saved) | Ok(SaveResult::Replaced) => {
                tracing::debug!(
                    event_id = %deletion_event.id.to_hex(),
                    "削除リクエストイベントを保存"
                );
            }
            Ok(SaveResult::Duplicate) => {
                tracing::debug!(
                    event_id = %deletion_event.id.to_hex(),
                    "削除リクエストイベントは既に保存済み"
                );
            }
            Err(e) => {
                return Err(DeletionError::from(e));
            }
        }

        Ok(DeletionResult {
            deleted_count,
            skipped_count,
        })
    }

    /// eタグ対象（個別イベントID）の削除処理
    ///
    /// # Returns
    /// * `Ok(true)` - 削除成功
    /// * `Ok(false)` - スキップ（対象不存在、pubkey不一致、kind:5）
    /// * `Err` - エラー
    async fn process_event_id_deletion(
        &self,
        target: &DeletionTarget,
        event_id: &str,
    ) -> Result<bool, DeletionError> {
        // 1. イベントを取得
        let event = match self.event_repo.get_by_id(event_id).await? {
            Some(e) => e,
            None => {
                tracing::debug!(
                    event_id = %event_id,
                    "削除対象イベントが存在しない、スキップ"
                );
                return Ok(false); // 対象不存在
            }
        };

        // 2. pubkey検証
        if !DeletionValidator::validate_pubkey_match(
            &event.pubkey.to_hex(),
            &target.requester_pubkey,
        ) {
            tracing::debug!(
                event_id = %event_id,
                target_pubkey = %event.pubkey.to_hex(),
                requester_pubkey = %target.requester_pubkey,
                "pubkey不一致のため削除をスキップ"
            );
            return Ok(false); // pubkey不一致
        }

        // 3. kind:5保護チェック
        if DeletionValidator::is_protected_kind(event.kind.as_u16()) {
            tracing::debug!(
                event_id = %event_id,
                kind = event.kind.as_u16(),
                "kind:5イベントは削除保護対象、スキップ"
            );
            return Ok(false); // kind:5保護
        }

        // 4. 物理削除
        let deleted = self.event_repo.delete_by_id(event_id).await?;
        if deleted {
            tracing::info!(
                event_id = %event_id,
                "イベントを削除"
            );
        }

        Ok(deleted)
    }

    /// aタグ対象（Addressable識別子）の削除処理
    ///
    /// # Returns
    /// * `Ok(count)` - 削除したイベント数
    /// * `Err` - エラー
    async fn process_address_deletion(
        &self,
        target: &DeletionTarget,
        kind: u16,
        pubkey: &str,
        d_tag: &str,
    ) -> Result<usize, DeletionError> {
        // kind:5はAddressableとして削除対象にはならない（NIP-09仕様）
        // ただし、aタグでkind:5を指定することは通常ないが、念のため保護
        if DeletionValidator::is_protected_kind(kind) {
            tracing::debug!(
                kind = kind,
                "kind:5はaタグ削除でも保護対象、スキップ"
            );
            return Ok(0);
        }

        // Addressable削除（時刻境界付き）
        let deleted_count = self
            .event_repo
            .delete_by_address(pubkey, kind, d_tag, target.request_created_at)
            .await?;

        if deleted_count > 0 {
            tracing::info!(
                kind = kind,
                pubkey = %pubkey,
                d_tag = %d_tag,
                before_timestamp = target.request_created_at,
                deleted_count = deleted_count,
                "Addressableイベントを削除"
            );
        }

        Ok(deleted_count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::event_repository::tests::MockEventRepository;
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};

    // ==================== テストヘルパー ====================

    /// テスト用のDeletionHandlerを作成
    fn create_test_handler() -> (DeletionHandler<MockEventRepository>, MockEventRepository) {
        let event_repo = MockEventRepository::new();
        let handler = DeletionHandler::new(event_repo.clone());
        (handler, event_repo)
    }

    /// テスト用のkind:5削除リクエストイベントを作成
    fn create_deletion_event(keys: &Keys, tags: Vec<Tag>) -> Event {
        EventBuilder::new(Kind::from(5), "deletion request")
            .tags(tags)
            .sign_with_keys(keys)
            .expect("Failed to create deletion event")
    }

    /// テスト用の通常イベント（kind:1）を作成
    fn create_text_note(keys: &Keys, content: &str) -> Event {
        EventBuilder::text_note(content)
            .sign_with_keys(keys)
            .expect("Failed to create text note")
    }

    /// 指定されたcreated_atを持つAddressableイベントを作成
    fn create_addressable_event(keys: &Keys, kind: u16, d_tag: &str, timestamp: u64) -> Event {
        let tag = Tag::parse(["d", d_tag]).unwrap();
        EventBuilder::new(Kind::from(kind), "addressable content")
            .tags(vec![tag])
            .custom_created_at(Timestamp::from(timestamp))
            .sign_with_keys(keys)
            .expect("Failed to create addressable event")
    }

    /// kind:5削除リクエストイベントを指定タイムスタンプで作成
    fn create_deletion_event_with_timestamp(keys: &Keys, tags: Vec<Tag>, timestamp: u64) -> Event {
        EventBuilder::new(Kind::from(5), "deletion request")
            .tags(tags)
            .custom_created_at(Timestamp::from(timestamp))
            .sign_with_keys(keys)
            .expect("Failed to create deletion event")
    }

    // ==================== DeletionResult/DeletionError テスト ====================

    #[test]
    fn test_deletion_result_equality() {
        let result1 = DeletionResult {
            deleted_count: 1,
            skipped_count: 2,
        };
        let result2 = DeletionResult {
            deleted_count: 1,
            skipped_count: 2,
        };
        assert_eq!(result1, result2);
    }

    #[test]
    fn test_deletion_error_display() {
        let error = DeletionError::RepositoryError("test error".to_string());
        assert_eq!(error.to_string(), "Repository error: test error");
    }

    #[test]
    fn test_deletion_error_from_event_repository_error() {
        let repo_error = EventRepositoryError::WriteError("write failed".to_string());
        let deletion_error: DeletionError = repo_error.into();
        assert!(matches!(deletion_error, DeletionError::RepositoryError(_)));
    }

    // ==================== eタグ削除テスト ====================

    /// eタグで指定したイベントが存在し、pubkeyが一致する場合は削除される
    #[tokio::test]
    async fn test_process_deletion_e_tag_success() {
        let (handler, event_repo) = create_test_handler();
        let keys = Keys::generate();

        // 削除対象イベントを保存
        let target_event = create_text_note(&keys, "target content");
        let target_event_id = target_event.id.to_hex();
        event_repo.save(&target_event).await.unwrap();
        assert_eq!(event_repo.event_count(), 1);

        // 削除リクエストを作成
        let e_tag = Tag::parse(["e", &target_event_id]).unwrap();
        let deletion_event = create_deletion_event(&keys, vec![e_tag]);

        // 削除処理実行
        let result = handler.process_deletion(&deletion_event).await.unwrap();

        assert_eq!(result.deleted_count, 1);
        assert_eq!(result.skipped_count, 0);

        // 対象イベントが削除されていることを確認（削除リクエスト自体は保存される）
        let remaining = event_repo.get_by_id(&target_event_id).await.unwrap();
        assert!(remaining.is_none());

        // 削除リクエストイベント自体は保存されている
        assert_eq!(event_repo.event_count(), 1);
    }

    /// eタグで指定したイベントが存在しない場合はスキップ
    #[tokio::test]
    async fn test_process_deletion_e_tag_nonexistent_event() {
        let (handler, event_repo) = create_test_handler();
        let keys = Keys::generate();

        // 存在しないイベントIDで削除リクエスト
        let nonexistent_id = "a".repeat(64);
        let e_tag = Tag::parse(["e", &nonexistent_id]).unwrap();
        let deletion_event = create_deletion_event(&keys, vec![e_tag]);

        let result = handler.process_deletion(&deletion_event).await.unwrap();

        assert_eq!(result.deleted_count, 0);
        assert_eq!(result.skipped_count, 1);

        // 削除リクエストイベント自体は保存される
        assert_eq!(event_repo.event_count(), 1);
    }

    /// eタグで指定したイベントのpubkeyが不一致の場合はスキップ
    #[tokio::test]
    async fn test_process_deletion_e_tag_pubkey_mismatch() {
        let (handler, event_repo) = create_test_handler();
        let owner_keys = Keys::generate();
        let other_keys = Keys::generate();

        // owner_keysでイベントを保存
        let target_event = create_text_note(&owner_keys, "target content");
        let target_event_id = target_event.id.to_hex();
        event_repo.save(&target_event).await.unwrap();

        // other_keysで削除リクエスト（pubkey不一致）
        let e_tag = Tag::parse(["e", &target_event_id]).unwrap();
        let deletion_event = create_deletion_event(&other_keys, vec![e_tag]);

        let result = handler.process_deletion(&deletion_event).await.unwrap();

        assert_eq!(result.deleted_count, 0);
        assert_eq!(result.skipped_count, 1);

        // 対象イベントは削除されていない
        let remaining = event_repo.get_by_id(&target_event_id).await.unwrap();
        assert!(remaining.is_some());

        // 削除リクエストイベント自体は保存される
        assert_eq!(event_repo.event_count(), 2);
    }

    /// eタグで指定したイベントがkind:5の場合はスキップ（削除リクエストの削除を防止）
    #[tokio::test]
    async fn test_process_deletion_e_tag_kind5_protected() {
        let (handler, event_repo) = create_test_handler();
        let keys = Keys::generate();

        // kind:5イベントを保存
        let kind5_event = create_deletion_event(&keys, vec![]);
        let kind5_event_id = kind5_event.id.to_hex();
        event_repo.save(&kind5_event).await.unwrap();

        // kind:5を削除しようとする削除リクエスト
        let e_tag = Tag::parse(["e", &kind5_event_id]).unwrap();
        let deletion_event = create_deletion_event(&keys, vec![e_tag]);

        let result = handler.process_deletion(&deletion_event).await.unwrap();

        assert_eq!(result.deleted_count, 0);
        assert_eq!(result.skipped_count, 1);

        // kind:5イベントは削除されていない
        let remaining = event_repo.get_by_id(&kind5_event_id).await.unwrap();
        assert!(remaining.is_some());
    }

    /// 複数のeタグを含む削除リクエスト
    #[tokio::test]
    async fn test_process_deletion_multiple_e_tags() {
        let (handler, event_repo) = create_test_handler();
        let keys = Keys::generate();

        // 3つのイベントを保存
        let event1 = create_text_note(&keys, "content 1");
        let event2 = create_text_note(&keys, "content 2");
        let event3 = create_text_note(&keys, "content 3");
        event_repo.save(&event1).await.unwrap();
        event_repo.save(&event2).await.unwrap();
        event_repo.save(&event3).await.unwrap();
        assert_eq!(event_repo.event_count(), 3);

        // 3つ全てを削除する削除リクエスト
        let e_tag1 = Tag::parse(["e", &event1.id.to_hex()]).unwrap();
        let e_tag2 = Tag::parse(["e", &event2.id.to_hex()]).unwrap();
        let e_tag3 = Tag::parse(["e", &event3.id.to_hex()]).unwrap();
        let deletion_event = create_deletion_event(&keys, vec![e_tag1, e_tag2, e_tag3]);

        let result = handler.process_deletion(&deletion_event).await.unwrap();

        assert_eq!(result.deleted_count, 3);
        assert_eq!(result.skipped_count, 0);

        // 削除リクエストイベント自体のみが残る
        assert_eq!(event_repo.event_count(), 1);
    }

    // ==================== aタグ削除テスト ====================

    /// aタグで指定したAddressableイベントが時刻境界内にある場合は削除される
    #[tokio::test]
    async fn test_process_deletion_a_tag_success() {
        let (handler, event_repo) = create_test_handler();
        let keys = Keys::generate();
        let pubkey = keys.public_key().to_hex();

        // Addressableイベントを保存（created_at = 1000）
        let target_event = create_addressable_event(&keys, 30000, "test-id", 1000);
        event_repo.save(&target_event).await.unwrap();
        assert_eq!(event_repo.event_count(), 1);

        // 時刻境界内で削除リクエスト（created_at = 2000）
        let a_tag_value = format!("30000:{}:test-id", pubkey);
        let a_tag = Tag::parse(["a", &a_tag_value]).unwrap();
        let deletion_event = create_deletion_event_with_timestamp(&keys, vec![a_tag], 2000);

        let result = handler.process_deletion(&deletion_event).await.unwrap();

        assert_eq!(result.deleted_count, 1);
        assert_eq!(result.skipped_count, 0);

        // 削除リクエストイベント自体のみが残る
        assert_eq!(event_repo.event_count(), 1);
    }

    /// aタグで指定したAddressableイベントが時刻境界外の場合はスキップ
    #[tokio::test]
    async fn test_process_deletion_a_tag_outside_time_window() {
        let (handler, event_repo) = create_test_handler();
        let keys = Keys::generate();
        let pubkey = keys.public_key().to_hex();

        // Addressableイベントを保存（created_at = 2000）
        let target_event = create_addressable_event(&keys, 30000, "test-id", 2000);
        let target_event_id = target_event.id.to_hex();
        event_repo.save(&target_event).await.unwrap();

        // 時刻境界外で削除リクエスト（created_at = 1000、イベントより古い）
        let a_tag_value = format!("30000:{}:test-id", pubkey);
        let a_tag = Tag::parse(["a", &a_tag_value]).unwrap();
        let deletion_event = create_deletion_event_with_timestamp(&keys, vec![a_tag], 1000);

        let result = handler.process_deletion(&deletion_event).await.unwrap();

        assert_eq!(result.deleted_count, 0);
        assert_eq!(result.skipped_count, 1);

        // イベントは削除されていない
        let remaining = event_repo.get_by_id(&target_event_id).await.unwrap();
        assert!(remaining.is_some());
    }

    /// aタグで指定したAddressableイベントが存在しない場合はスキップ
    #[tokio::test]
    async fn test_process_deletion_a_tag_nonexistent() {
        let (handler, event_repo) = create_test_handler();
        let keys = Keys::generate();
        let pubkey = keys.public_key().to_hex();

        // 存在しないアドレスで削除リクエスト
        let a_tag_value = format!("30000:{}:nonexistent", pubkey);
        let a_tag = Tag::parse(["a", &a_tag_value]).unwrap();
        let deletion_event = create_deletion_event_with_timestamp(&keys, vec![a_tag], 2000);

        let result = handler.process_deletion(&deletion_event).await.unwrap();

        assert_eq!(result.deleted_count, 0);
        assert_eq!(result.skipped_count, 1);

        // 削除リクエストイベント自体のみが保存される
        assert_eq!(event_repo.event_count(), 1);
    }

    // ==================== 混合タグテスト ====================

    /// eタグとaタグが混在する削除リクエスト
    #[tokio::test]
    async fn test_process_deletion_mixed_tags() {
        let (handler, event_repo) = create_test_handler();
        let keys = Keys::generate();
        let pubkey = keys.public_key().to_hex();

        // 通常イベントを保存
        let text_note = create_text_note(&keys, "text content");
        let text_note_id = text_note.id.to_hex();
        event_repo.save(&text_note).await.unwrap();

        // Addressableイベントを保存
        let addressable = create_addressable_event(&keys, 30000, "test-id", 1000);
        event_repo.save(&addressable).await.unwrap();

        assert_eq!(event_repo.event_count(), 2);

        // eタグとaタグの両方を含む削除リクエスト
        let e_tag = Tag::parse(["e", &text_note_id]).unwrap();
        let a_tag_value = format!("30000:{}:test-id", pubkey);
        let a_tag = Tag::parse(["a", &a_tag_value]).unwrap();
        let deletion_event = create_deletion_event_with_timestamp(&keys, vec![e_tag, a_tag], 2000);

        let result = handler.process_deletion(&deletion_event).await.unwrap();

        assert_eq!(result.deleted_count, 2);
        assert_eq!(result.skipped_count, 0);

        // 削除リクエストイベント自体のみが残る
        assert_eq!(event_repo.event_count(), 1);
    }

    /// 一部成功、一部スキップの削除リクエスト
    #[tokio::test]
    async fn test_process_deletion_partial_success() {
        let (handler, event_repo) = create_test_handler();
        let owner_keys = Keys::generate();
        let other_keys = Keys::generate();

        // owner_keysでイベントを保存
        let event1 = create_text_note(&owner_keys, "content 1");
        event_repo.save(&event1).await.unwrap();

        // 存在しないイベントIDと他人のイベントIDと自分のイベントIDを含む削除リクエスト
        let e_tag1 = Tag::parse(["e", &event1.id.to_hex()]).unwrap(); // 成功するはず
        let e_tag2 = Tag::parse(["e", &"b".repeat(64)]).unwrap(); // 存在しない

        // other_keysで削除リクエスト
        let deletion_event = create_deletion_event(&other_keys, vec![e_tag1, e_tag2]);

        let result = handler.process_deletion(&deletion_event).await.unwrap();

        // event1はpubkey不一致、存在しないイベントは対象不存在
        assert_eq!(result.deleted_count, 0);
        assert_eq!(result.skipped_count, 2);

        // event1は残っている（pubkey不一致で削除されなかった）
        assert_eq!(event_repo.event_count(), 2); // event1 + 削除リクエスト
    }

    // ==================== 削除リクエストイベント保存テスト ====================

    /// 削除リクエストイベント自体は常に保存される
    #[tokio::test]
    async fn test_deletion_event_itself_is_saved() {
        let (handler, event_repo) = create_test_handler();
        let keys = Keys::generate();

        // 空のタグで削除リクエスト（削除対象なし）
        let deletion_event = create_deletion_event(&keys, vec![]);
        let deletion_event_id = deletion_event.id.to_hex();

        let result = handler.process_deletion(&deletion_event).await.unwrap();

        assert_eq!(result.deleted_count, 0);
        assert_eq!(result.skipped_count, 0);

        // 削除リクエストイベント自体が保存されている
        let saved = event_repo.get_by_id(&deletion_event_id).await.unwrap();
        assert!(saved.is_some());
        assert_eq!(saved.unwrap().kind.as_u16(), 5);
    }

    /// 重複する削除リクエストイベントも正常に処理される
    #[tokio::test]
    async fn test_duplicate_deletion_event() {
        let (handler, event_repo) = create_test_handler();
        let keys = Keys::generate();

        let deletion_event = create_deletion_event(&keys, vec![]);

        // 1回目
        let result1 = handler.process_deletion(&deletion_event).await.unwrap();
        assert_eq!(result1.deleted_count, 0);
        assert_eq!(result1.skipped_count, 0);
        assert_eq!(event_repo.event_count(), 1);

        // 2回目（重複）
        let result2 = handler.process_deletion(&deletion_event).await.unwrap();
        assert_eq!(result2.deleted_count, 0);
        assert_eq!(result2.skipped_count, 0);
        assert_eq!(event_repo.event_count(), 1); // 重複なので増えない
    }

    // ==================== エラーハンドリングテスト ====================

    /// リポジトリエラー時にDeletionErrorを返す
    #[tokio::test]
    async fn test_process_deletion_repository_save_error() {
        let (handler, event_repo) = create_test_handler();
        let keys = Keys::generate();

        // 削除リクエスト保存時にエラーを発生させる設定
        // ただし、saveは最後に呼ばれるので、その前にエラーをセット
        let deletion_event = create_deletion_event(&keys, vec![]);

        // エラーをセット
        event_repo.set_next_error(EventRepositoryError::WriteError("DB error".to_string()));

        let result = handler.process_deletion(&deletion_event).await;

        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), DeletionError::RepositoryError(_)));
    }
}
