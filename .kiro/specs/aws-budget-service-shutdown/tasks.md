# Implementation Plan

## Task 1: sqlite-api Graceful Shutdown対応

- [x] 1.1 (P) SIGTERMシグナルハンドリングの実装
  - tokio::signalを使用してSIGTERMとCtrl+Cを待機するshutdown_signal()関数を作成
  - axum::serveのwith_graceful_shutdown()でサーバーに統合
  - シグナル受信時に新規リクエスト受付を停止し、処理中リクエストの完了を待機
  - SQLiteコネクションの正常クローズを確保
  - tracingでシグナル受信をログ出力
  - _Requirements: 3.5_

## Task 2: Shutdown Lambda実装

- [x] 2.1 (P) Shutdown Lambdaの基本構造とSNSトリガー対応
  - services/relay/src/bin/shutdown.rsを新規作成
  - lambda_runtimeを使用したSNSイベントハンドラーを実装
  - 環境変数からLambda関数名リスト、EC2インスタンスID、CloudFront ID、SNSトピックARNを読み込み
  - PhaseResult/ShutdownResult構造体を定義し、各フェーズの結果を記録
  - Cargo.tomlにshutdownバイナリターゲットを追加
  - _Requirements: 3.1, 3.8_

- [x] 2.2 Phase 1: relay Lambda関数の無効化処理
  - aws-sdk-lambdaを使用してPutFunctionConcurrency APIを呼び出し
  - 複数のLambda関数（connect/disconnect/default）に対してreserved concurrencyを0に設定
  - 各関数の処理結果をPhaseResultに記録
  - API呼び出し失敗時はログ記録して次の関数に継続
  - _Requirements: 3.2_
  - _Note: 2.1に依存_

- [x] 2.3 Phase 2-4: 待機、sqlite-api停止、EC2停止
  - Phase 2: 実行中Lambda関数の完了を待つため30秒待機
  - Phase 3: aws-sdk-ssmのSendCommand APIでsystemctl stop nostr-apiを実行、GetCommandInvocationで完了確認
  - Phase 4: aws-sdk-ec2のStopInstances APIでEC2インスタンスを停止
  - 各フェーズの失敗は記録して次フェーズに継続（エラー継続戦略）
  - _Requirements: 3.3, 3.4, 3.6_
  - _Note: 2.2に依存_

- [x] 2.4 Phase 5: CloudFront無効化と結果通知
  - aws-sdk-cloudfrontのGetDistribution/UpdateDistribution APIでディストリビューションを無効化
  - 全フェーズの結果をJSON形式でCloudWatch Logsに構造化ログ出力
  - aws-sdk-snsのPublish APIで結果通知SNSトピックにShutdownResult全体を発行
  - overall_success判定（全フェーズ成功時のみtrue）
  - _Requirements: 3.7, 3.9, 3.10_
  - _Note: 2.3に依存_

## Task 3: Recovery Lambda実装

- [x] 3.1 (P) Recovery Lambdaの基本構造とEventBridgeトリガー対応
  - services/relay/src/bin/recovery.rsを新規作成
  - lambda_runtimeを使用したEventBridgeイベントハンドラーを実装
  - 環境変数からLambda関数名リスト、EC2インスタンスID、CloudFront ID、SQLite APIエンドポイント、SNSトピックARNを読み込み
  - StepResult/RecoveryResult構造体を定義
  - Cargo.tomlにrecoveryバイナリターゲットを追加
  - _Requirements: 4.3_

- [x] 3.2 Step 1-2: EC2状態確認と起動処理
  - aws-sdk-ec2のDescribeInstances APIでEC2状態を確認
  - 既にrunning状態の場合はスキップフラグを設定しログ記録
  - stopped状態の場合はStartInstances APIでEC2を起動
  - 起動完了待機（最大2分、DescribeInstancesでrunning確認）
  - _Requirements: 4.4, 4.9_
  - _Note: 3.1に依存_

- [x] 3.3 Step 3: sqlite-apiヘルスチェック
  - reqwestクライアントで既存の/healthエンドポイントにHTTP GETリクエスト
  - リトライロジック実装（最大5回、5秒間隔）
  - ヘルスチェック失敗時は処理中断してエラー結果を通知（エラー中断戦略）
  - _Requirements: 4.5_
  - _Note: 3.2に依存_

- [x] 3.4 Step 4-5: Lambda有効化、CloudFront有効化、結果通知
  - aws-sdk-lambdaのDeleteFunctionConcurrency APIでreserved concurrency設定を削除
  - aws-sdk-cloudfrontのGetDistribution/UpdateDistribution APIでディストリビューションを有効化
  - 各ステップでエラー発生時は即座に処理中断
  - aws-sdk-snsのPublish APIでRecoveryResultをSNSトピックに発行
  - スキップ時と成功/失敗時で異なるメッセージ形式
  - _Requirements: 4.6, 4.7, 4.8_
  - _Note: 3.3に依存_

## Task 4: Terraformモジュール（modules/budget）構築

- [x] 4.1 予算アラート用SNSトピックとAWS Budget設定
  - terraform/modules/budgetディレクトリを新規作成
  - AWS Budgetリソースを作成し月額コスト閾値を設定
  - 閾値超過時に通知を送信するアラートSNSトピックを作成
  - SNSトピックポリシーにbudgets.amazonaws.comからのPublishを許可
  - budget_limit_amount変数で閾値金額を設定可能に
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 5.1_
  - _Note: Lambda実装（Task 2, 3）完了後に実施_

- [x] 4.2 結果通知用SNSトピックとAWS Chatbot Slack連携
  - 停止/復旧結果通知用の別SNSトピックを作成
  - aws_chatbot_slack_channel_configurationリソースでSlack連携を設定
  - slack_workspace_idとslack_channel_id変数で通知先を設定可能に
  - ChatbotがSNSトピックをサブスクライブするIAMロールを作成
  - _Requirements: 2.3, 2.4_
  - _Note: 4.1に依存_

- [x] 4.3 Shutdown/Recovery Lambda用IAMロールとポリシー
  - Shutdown Lambda用IAMロールを作成
  - Lambda PutFunctionConcurrency/DeleteFunctionConcurrency/GetFunction権限を付与
  - EC2 StopInstances/StartInstances/DescribeInstances権限を付与
  - SSM SendCommand/GetCommandInvocation権限を付与
  - CloudFront UpdateDistribution/GetDistribution権限を付与
  - SNS Publish権限を付与
  - CloudWatch Logs権限を付与
  - リソースARNを限定して最小権限を実現
  - Recovery Lambda用IAMロールも同様に作成
  - _Requirements: 5.2, 5.3_
  - _Note: 4.1に依存_

- [x] 4.4 Lambda関数とEventBridge Scheduleリソース
  - Shutdown Lambda関数をARM64アーキテクチャで定義
  - Recovery Lambda関数をARM64アーキテクチャで定義
  - 両Lambda関数のタイムアウトを180秒、メモリを256MBに設定
  - 環境変数でLambda関数名リスト、EC2インスタンスID、CloudFront ID、SNSトピックARN、sqlite-apiエンドポイントを設定
  - SNSトピックからShutdown Lambdaを起動する権限（aws_lambda_permission）を設定
  - EventBridge Scheduleルールを作成（デフォルト: 毎月1日 00:05 JST）
  - recovery_schedule_time変数でスケジュール時刻を設定可能に
  - EventBridgeからRecovery Lambdaを起動する権限を設定
  - _Requirements: 4.1, 4.2, 5.4, 5.5_
  - _Note: 4.3に依存_

- [x] 4.5 モジュール変数と出力、メイン設定への統合
  - relay_lambda_function_names、ec2_instance_id、cloudfront_distribution_id変数を定義
  - 既存モジュール（modules/api, modules/ec2-search）から必要なリソースIDを参照
  - alert_sns_topic_arn、result_sns_topic_arn、shutdown/recovery_lambda_function_name出力を定義
  - terraform/main.tfにmodule.budget呼び出しを追加
  - _Requirements: 5.6_
  - _Note: 4.4に依存_

## Task 5: ビルドと統合

- [ ] 5.1 Lambda関数のビルドとデプロイ準備
  - cargo lambda build --release --arm64でShutdown/Recovery Lambdaをビルド
  - Terraformが参照するビルド成果物パスを確認
  - 既存のLambdaビルドワークフローとの整合性を確認
  - _Requirements: 5.4_
  - _Note: Task 2, 3完了後に実施_

- [ ] 5.2 sqlite-apiのビルドとデプロイ
  - cargo zigbuild --release --target aarch64-unknown-linux-gnuでsqlite-apiをビルド
  - S3へバイナリをアップロード
  - SSM Run Commandでバイナリ更新を実行
  - graceful shutdownが動作することをjournalctlで確認
  - _Requirements: 3.5_
  - _Note: Task 1完了後に実施_

- [ ] 5.3 Terraformモジュール適用
  - terraform planで変更内容を確認
  - terraform applyでmodules/budgetリソースを作成
  - Budget、SNS、Lambda、EventBridge、IAMリソースが正しく作成されたことを確認
  - _Requirements: 5.1_
  - _Note: Task 4, 5.1, 5.2完了後に実施_

## Task 6: 動作確認テスト

- [ ] 6.1 Shutdown Lambda単体動作確認
  - AWS CLIまたはコンソールからShutdown Lambdaを手動invoke
  - Lambda concurrency設定が0になることを確認
  - SSM Run Commandがsqlite-apiを停止することを確認
  - EC2インスタンスが停止することを確認
  - CloudFrontが無効化されることを確認
  - SNS通知がSlackに届くことを確認
  - CloudWatch Logsに構造化ログが記録されることを確認
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.6, 3.7, 3.8, 3.9, 3.10_
  - _Note: Task 5.3完了後に実施_

- [ ] 6.2 Recovery Lambda単体動作確認
  - AWS CLIまたはコンソールからRecovery Lambdaを手動invoke
  - EC2インスタンスが起動することを確認
  - sqlite-apiのヘルスチェックが成功することを確認
  - Lambda concurrency設定が削除されることを確認
  - CloudFrontが有効化されることを確認
  - SNS通知がSlackに届くことを確認
  - 既にサービス稼働中の場合にスキップされることを確認
  - _Requirements: 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9_
  - _Note: 6.1完了後に実施（6.1で停止した状態から復旧テスト）_

- [ ] 6.3 エンドツーエンド動作確認
  - AWS Budgetの閾値を一時的に低く設定してアラートをトリガー
  - Shutdown Lambdaが自動起動し全サービスが停止することを確認
  - EventBridge Scheduleの次回実行時刻を確認
  - 手動でRecovery Lambdaを実行してサービスが復旧することを確認
  - 本番用の閾値に戻す
  - _Requirements: 1.1, 1.2, 1.3_
  - _Note: 6.2完了後に実施_
