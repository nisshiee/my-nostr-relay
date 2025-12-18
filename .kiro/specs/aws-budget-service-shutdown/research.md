# Research & Design Decisions

## Summary
- **Feature**: `aws-budget-service-shutdown`
- **Discovery Scope**: Extension (既存システムへの新機能追加)
- **Key Findings**:
  - AWS Budgetは同一アカウント内のSNSトピックにのみ通知可能（クロスアカウントSNS非対応）
  - Lambda reserved concurrencyを0に設定することで即座に新規リクエストをブロック可能
  - axum 0.8では`with_graceful_shutdown()`でSIGTERMハンドリングが可能

## Research Log

### AWS Budgets SNS通知

- **Context**: 予算超過時の通知トリガー方式を調査
- **Sources Consulted**:
  - [AWS Budgets SNS Topic Documentation](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-sns-policy.html)
  - [Budget Controls for AWS Blog](https://aws.amazon.com/blogs/aws-cloud-financial-management/introducing-budget-controls-for-aws-automatically-manage-your-cloud-costs/)
- **Findings**:
  - SNSトピックは予算と同一アカウント内に作成が必要
  - SNSトピックポリシーに`budgets.amazonaws.com`からのPublish許可が必要
  - 通知遅延が発生する可能性がある（リソース使用から課金反映までのタイムラグ）
  - 80%/90%の2段階アラート設定が推奨（Budget Controls for AWS）
- **Implications**: 本設計では閾値超過時にSNS経由でLambdaをトリガーする方式を採用

### AWS Chatbot / Amazon Q Developer Slack連携

- **Context**: Slack通知基盤の実装方式を調査
- **Sources Consulted**:
  - [Terraform aws_chatbot_slack_channel_configuration](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/chatbot_slack_channel_configuration)
  - [terraform-aws-chatbot-slack GitHub](https://github.com/panos--/terraform-aws-chatbot-slack)
- **Findings**:
  - Slackワークスペース連携は初回のみAWS Console手動操作が必要（OAuth認証）
  - TerraformではSlackワークスペース連携後にチャンネル設定が可能
  - `aws_chatbot_slack_channel_configuration`リソースで設定
  - IAMロールとSNSトピックサブスクリプションが必要
- **Implications**: ドキュメントにOAuth認証手順を記載、Terraformでチャンネル設定を管理

### Lambda Reserved Concurrency制御

- **Context**: Lambda関数の即座無効化方法を調査
- **Sources Consulted**:
  - [AWS Lambda Concurrency Documentation](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html)
  - [Terraform Issue #3803](https://github.com/terraform-providers/terraform-provider-aws/issues/3803)
- **Findings**:
  - reserved concurrencyを0に設定すると即座にスロットリング状態になる
  - すべての新規invocationが429エラーで拒否される
  - AWS SDK `PutFunctionConcurrency` APIで動的に設定可能
  - 削除には `DeleteFunctionConcurrency` APIを使用
- **Implications**: Shutdown Lambdaで`PutFunctionConcurrency(0)`を呼び出し、Recovery Lambdaで`DeleteFunctionConcurrency`を呼び出す

### axum Graceful Shutdown実装

- **Context**: sqlite-apiのSIGTERMハンドリング方式を調査
- **Sources Consulted**:
  - [axum graceful-shutdown example](https://github.com/tokio-rs/axum/blob/main/examples/graceful-shutdown/src/main.rs)
  - [Tokio Graceful Shutdown](https://tokio.rs/tokio/topics/shutdown)
  - [Medium: Rust Async Graceful Shutdown](https://medium.com/@wedevare/rust-async-graceful-shutdown-for-axum-servers-signals-draining-cleanup-done-right-3b52375412ec)
- **Findings**:
  - `tokio::signal::unix::signal(SignalKind::terminate())`でSIGTERMを受信
  - `axum::serve(...).with_graceful_shutdown(shutdown_signal())`で統合
  - 処理中リクエスト完了後にサーバーが停止
  - タイムアウト設定で無限待機を防止可能
- **Implications**: sqlite-apiに`shutdown_signal()`関数を追加し、`with_graceful_shutdown()`を使用

### SSM Run Command経由のプロセス停止

- **Context**: EC2上のsqlite-apiプロセスをgraceful stopする方法を調査
- **Sources Consulted**:
  - [AWS SSM send-command](https://docs.aws.amazon.com/cli/latest/reference/ssm/send-command.html)
  - [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)
- **Findings**:
  - systemdの`systemctl stop`はデフォルトでSIGTERMを送信
  - TimeoutStopSec（デフォルト90秒）経過後にSIGKILLを送信
  - SSM Run Commandで`systemctl stop nostr-api`を実行可能
  - `GetCommandInvocation`で完了確認が可能
- **Implications**: SSM Run Commandで`systemctl stop nostr-api`を実行し、完了を待機

### EventBridge Schedulerによる月次トリガー

- **Context**: 月初自動復旧のスケジュール設定方式を調査
- **Sources Consulted**:
  - [AWS EventBridge Scheduler with Lambda](https://docs.aws.amazon.com/lambda/latest/dg/with-eventbridge-scheduler.html)
  - [Terraform EventBridge Module](https://github.com/terraform-aws-modules/terraform-aws-eventbridge)
- **Findings**:
  - cron式で毎月1日指定が可能: `cron(5 15 1 * ? *)` (JST 00:05)
  - タイムゾーン設定をサポート（Asia/Tokyo）
  - IAMロールとLambda invoke権限が必要
  - `aws_cloudwatch_event_rule` + `aws_cloudwatch_event_target`で設定
- **Implications**: EventBridge Ruleで毎月1日00:05 JSTにRecovery Lambdaをトリガー

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| A. Step Functions統合 | Step Functionsで停止/復旧ワークフローを管理 | ワークフロー可視化、再試行制御 | 複雑性増、追加コスト | 本プロジェクトにはオーバースペック |
| B. 単一Lambda方式 | Shutdown/Recoveryそれぞれ単一Lambdaで実装 | シンプル、低コスト | 大きなLambda関数になる可能性 | **選択**: プロジェクト規模に適合 |
| C. マイクロサービス分割 | 各操作を独立したLambdaに分割 | 責務分離、個別スケール | 管理複雑、コールドスタート増 | 不要な複雑性 |

## Design Decisions

### Decision: Lambda関数の配置場所

- **Context**: Shutdown/Recovery Lambda関数を既存services/relayに追加するか、新規serviceを作成するか
- **Alternatives Considered**:
  1. services/relay/src/bin/に追加 — 既存Rustプロジェクトを活用
  2. services/budget/を新規作成 — 責務分離
- **Selected Approach**: services/relay/src/bin/に追加
- **Rationale**:
  - 既存のCargo.tomlとAWS SDK依存を再利用
  - 運用系Lambda（shutdown, recovery）もrelayサービスの一部として管理
  - structure.mdの「運用ツール系」カテゴリに適合
- **Trade-offs**: relay serviceが大きくなるが、依存関係の一元管理が可能
- **Follow-up**: 将来的に運用ツールが増加した場合は分離を検討

### Decision: SSM Document vs 直接Run Command

- **Context**: sqlite-api停止にカスタムSSM Documentを使用するか直接AWS-RunShellScriptを使用するか
- **Alternatives Considered**:
  1. AWS-RunShellScript直接使用 — シンプル
  2. カスタムSSM Document作成 — 再利用性、パラメータ化
- **Selected Approach**: AWS-RunShellScript直接使用
- **Rationale**:
  - 停止コマンドは単純（`systemctl stop nostr-api`）
  - 既存のSSM Documentパターン（update-binary）との一貫性不要
  - Lambda内でコマンドを柔軟に制御可能
- **Trade-offs**: コマンドがLambdaコードにハードコード
- **Follow-up**: 複雑なシーケンスが必要になった場合はDocument化を検討

### Decision: CloudFront無効化の実装

- **Context**: CloudFront無効化をオプションとして実装するかデフォルトとするか
- **Alternatives Considered**:
  1. 常に無効化 — 最大限のコスト削減
  2. 設定可能（環境変数） — 柔軟性
  3. 実装しない — シンプル化
- **Selected Approach**: 常に無効化（要件通り）
- **Rationale**:
  - 予算超過時は最大限のコスト削減が必要
  - CloudFront無効化で追加の転送コストを防止
  - 復旧時に自動で有効化
- **Trade-offs**: 無効化伝播に最大15分かかる

## Risks & Mitigations

- **通知遅延リスク** — AWS Budgetの通知は遅延する可能性がある。閾値を低めに設定することで余裕を持たせる
- **処理中リクエストの喪失リスク** — sqlite-apiのgraceful shutdownと待機時間設定で軽減
- **月初復旧失敗リスク** — Recovery Lambdaの失敗時はSNS通知でオペレーターに警告
- **IAM権限不足リスク** — 最小権限ポリシーを設計段階で定義し、テストで検証

## References

- [AWS Budgets SNS Policy](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-sns-policy.html) — SNSトピック設定
- [aws_chatbot_slack_channel_configuration](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/chatbot_slack_channel_configuration) — Terraform Chatbot設定
- [AWS Lambda Concurrency](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html) — Reserved Concurrency
- [axum graceful-shutdown](https://github.com/tokio-rs/axum/blob/main/examples/graceful-shutdown/src/main.rs) — 公式サンプル
- [Tokio Graceful Shutdown](https://tokio.rs/tokio/topics/shutdown) — シャットダウンパターン
- [AWS SSM send-command](https://docs.aws.amazon.com/cli/latest/reference/ssm/send-command.html) — Run Command API
