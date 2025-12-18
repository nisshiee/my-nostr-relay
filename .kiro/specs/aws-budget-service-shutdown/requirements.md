# Requirements Document

## Introduction

本ドキュメントは、AWS予算アラートに基づくサービス自動停止機能の要件を定義する。月間AWSコストが設定した閾値を超過した場合、relay（Lambda）およびsqlite-api（EC2）サービスを自動的に停止し、予期しないコスト増加を防止する。

## Requirements

### Requirement 1: 予算閾値設定

**Objective:** As a システム運用者, I want AWS Budgetで月額コストの閾値を設定したい, so that コスト超過を検知できる

#### Acceptance Criteria
1. The Terraform shall AWS Budgetリソースを作成し、月額コストの閾値を設定できること
2. The Terraform shall 閾値金額を変数として設定可能であること
3. When 月額コストが閾値を超過した場合, the AWS Budget shall SNSトピックに通知を送信すること
4. The SNS Topic shall AWS Budgetと同一アカウント内に作成すること（クロスアカウントSNS非対応のため）

### Requirement 2: 通知インフラストラクチャ

**Objective:** As a システム運用者, I want 予算アラートの通知基盤を構築したい, so that 予算超過イベントを適切にハンドリングできる

#### Acceptance Criteria
1. The Terraform shall 予算アラート用のSNSトピックを作成すること
2. The Terraform shall SNSトピックのアクセスポリシーに`budgets.amazonaws.com`からの発行を許可すること
3. The Terraform shall AWS Chatbot（Amazon Q Developer in chat applications）によるSNS→Slack連携を構築すること
4. The Terraform shall 通知先SlackチャンネルIDとワークスペースIDを変数として設定可能であること
5. The Documentation shall Slackワークスペース連携の初期OAuth認証手順（AWS Console手動操作）を記載すること

### Requirement 3: サービス自動停止処理

**Objective:** As a システム運用者, I want 予算超過時にサービスを自動停止したい, so that 予期しないコスト増加を防止できる

#### Acceptance Criteria

**Phase 1: Lambda無効化（即時効果）**
1. When 予算アラートがSNSに発行された場合, the SNS shall Shutdown Lambda関数をトリガーすること
2. When トリガーされた場合, the Shutdown Lambda shall relay Lambda関数（connect/disconnect/default）のreserved concurrencyを0に設定し、新規リクエストを即座にブロックすること

**Phase 2: 処理完了待ち**
3. The Shutdown Lambda shall 実行中のLambda関数が完了するまで待機すること（最大30秒）

**Phase 3: sqlite-api graceful stop**
4. The Shutdown Lambda shall SSM Run Command経由でsqlite-apiプロセスをgraceful stopすること
5. The sqlite-api shall SIGTERMを受信したら新規リクエストを拒否し、処理中リクエストの完了を待ち、SQLiteコネクションを正常にクローズすること

**Phase 4: EC2停止**
6. When sqlite-apiが正常停止した場合, the Shutdown Lambda shall EC2インスタンスを停止すること

**Phase 5: CloudFront無効化（オプション）**
7. The Shutdown Lambda shall CloudFrontディストリビューションを無効化すること（追加のコスト削減、伝播に最大15分）

**結果通知**
8. The Shutdown Lambda shall 各フェーズの処理結果をCloudWatch Logsに記録すること
9. When 全フェーズが完了した場合, the Shutdown Lambda shall 停止結果（成功/失敗）をSNSトピックに発行し、AWS Chatbot（Amazon Q Developer）経由でSlack通知すること
10. If いずれかのフェーズが失敗した場合, the Shutdown Lambda shall 処理を継続し、最終的にすべての結果をまとめて通知すること

### Requirement 4: サービス復旧手順

**Objective:** As a システム運用者, I want 月初に自動でサービスを復旧させたい、また必要に応じて手動でも復旧できるようにしたい, so that 予算リセット後の自動再開と、緊急時の手動対応の両方が可能になる

#### Acceptance Criteria

**自動復旧トリガー**
1. The Terraform shall EventBridgeスケジュールルールを作成し、毎月1日にRecovery Lambdaをトリガーすること
2. The Terraform shall スケジュール実行時刻を変数として設定可能であること（デフォルト: 毎月1日 00:05 JST）

**復旧処理**
3. The Terraform shall サービス復旧用のRecovery Lambda関数を作成すること
4. When 復旧を実行した場合, the Recovery Lambda shall EC2インスタンスを起動すること
5. When EC2が起動完了した場合, the Recovery Lambda shall sqlite-apiの起動を確認すること（SSM Run Command or HTTPヘルスチェック）
6. When sqlite-apiが正常起動した場合, the Recovery Lambda shall relay Lambda関数のreserved concurrency設定を削除し、通常運用に戻すこと
7. When Lambda関数が有効化された場合, the Recovery Lambda shall CloudFrontディストリビューションを有効化すること（無効化されていた場合）
8. When 全ステップが完了した場合, the Recovery Lambda shall 復旧結果をSNSトピックに発行し、Slack通知すること
9. If サービスが既に稼働中の場合, the Recovery Lambda shall 処理をスキップし、その旨をログに記録すること

**手動復旧**
10. The Documentation shall 手動復旧手順（Recovery Lambda手動実行方法）を記載すること

### Requirement 5: インフラストラクチャ管理

**Objective:** As a システム運用者, I want Terraformで予算管理リソースを統一管理したい, so that インフラ変更を追跡・再現可能にできる

#### Acceptance Criteria
1. The Terraform shall 予算関連リソースを専用モジュール（modules/budget）で管理すること
2. The Terraform shall Shutdown Lambda および Recovery Lambda 用のIAMロールとポリシーを作成すること
3. The IAM Policy shall 以下の最小権限を付与すること:
   - Lambda: PutFunctionConcurrency, DeleteFunctionConcurrency, GetFunction（relay Lambda関数のconcurrency制御用）
   - EC2: StartInstances, StopInstances, DescribeInstances（sqlite-api EC2起動/停止用）
   - CloudFront: UpdateDistribution, GetDistribution（CloudFront有効化/無効化用）
   - SSM: SendCommand, GetCommandInvocation（sqlite-api graceful stop/ヘルスチェック用）
   - SNS: Publish（結果通知用）
   - CloudWatch Logs: CreateLogGroup, CreateLogStream, PutLogEvents
4. The Terraform shall Shutdown Lambda および Recovery Lambda をARM64アーキテクチャでデプロイすること
5. The Terraform shall EventBridgeスケジュールルールからRecovery Lambdaを呼び出す権限を設定すること
6. The Terraform shall 停止対象のLambda関数名、EC2インスタンスID、CloudFrontディストリビューションIDを変数として設定可能であること
