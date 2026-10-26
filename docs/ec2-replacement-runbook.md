# EC2 リレー入替手順

Nostr リレーの EC2 を新しい Alpine Linux AMI へ入れ替える際の確認事項をまとめる。
通常のアプリケーション配布手順ではなく、インスタンス入替専用の手順である。

## 原則

- 旧インスタンスを削除する前に候補インスタンスを作成し、EIP の付替えで切り替える。
- 候補作成から最終 Terraform plan 完了まで、他の Terraform 実行を禁止する。
- リレーまたは `deploy/` を変更する main への merge と Deploy workflow がない時間帯に行う。
- 候補・旧機保持用の一時 Terraform 定義は Git にコミットしない。
- `terraform apply`、EIP 切替、旧機削除は、それぞれ直前の plan と対象を確認してから実行する。
- main に残すのは最終 AMI、最終 user-data、この手順だけとする。途中状態を表す resource や `moved` block は残さない。

## 実行前に記録するもの

- main の commit SHA
- Terraform state の lineage、serial、S3 VersionId
- 旧 EC2 の instance ID、root volume ID、EIP association ID
- 使用する公式 Alpine AMI の ID、名前、owner、architecture
- S3 の `relay-v2/relay` と `relay-v2/env` の VersionId、更新時刻、size、ETag
- 配布 binary を作成した commit と `Cargo.lock`

S3 の固定 key は作業中に変化し得るため、候補作成前から EIP 切替後の検証完了まで通常 Deploy を止める。
候補上の binary checksum が記録した配布物と一致することを確認する。
user-data は固定 key の最新 version を取得するため、VersionId の記録だけで配布物は固定されない。
候補作成直前にも VersionId を照合し、異なれば作業を止めて plan と検証対象を作り直す。

## State と snapshot

- backend のロックを有効にし、すべての plan と state 操作でロック待ち時間を指定する。
- state bucket の versioning と最新 VersionId を確認し、権限を制限・暗号化したローカル backup も取得する。state の内容はログや PR に出さない。
- 旧 root EBS の snapshot を作成し、`completed` になってから候補作成へ進む。
- state 操作の前後で対象 resource address と実 AWS resource ID を照合する。
- 旧機削除前に候補 resource address を正式な `aws_instance.relay` へ付け替え、旧機だけが一時 address に残ることを確認する。

一時定義は最新 main から専用の Git 管理外ディレクトリへ作り、同じ backend を使う。最初の full plan は候補 EC2 と候補 Security Group の `create` だけで、旧 EC2、EIP、EIP association に変更がないことを確認する。provider の資格情報が不足して full plan を完了できない場合、対象限定 plan だけを根拠に apply してはならない。

## 候補インスタンス

候補は一時的な Terraform 定義で作成し、既存の EC2 と EIP association は変更しない。
本番と同じ instance type、root volume、IAM instance profile、最終版 user-data を使用する。

候補の一時 Security Group は SSH と必要な outbound のみを許可し、port 3000 は許可しない。
これにより CloudFront や外部クライアントから候補へイベントを送れない状態で検証する。

user-data がシリアルコンソールへ出力した ED25519 host key fingerprint と、接続先から取得した公開 host key の fingerprint を比較する。一致する鍵だけを専用の `known_hosts` に登録し、strict host key checking を有効にして接続する。
fingerprint は認証済み AWS API の console output から取得する。`ssh-keyscan` の結果だけを信頼根拠にしない。

候補上では次を確認する。

- Alpine、kernel、OpenRC service の版と状態
- disk、memory、swap の余裕
- `ca-certificates-bundle` が eMudhra 対応版以降であること
- 対象 eMudhra CA が system trust store に存在しないこと
- Python certifi と AWS CLI が system trust store を使用すること
- relay binary の build元と `rustls-webpki` が対策版であること
- localhost の NIP-11 と固定 REQ に対する EVENT、EOSE
- DynamoDB の読み取り

実鍵、署名、EVENT 投稿は使用しない。

## 切替と rollback

切替直前に候補へ本番 Security Group を付与して一時 Security Group を外し、EIP association の接続先だけを候補へ変更する。この二段階の一時定義と plan も Git に残さない。既存 WebSocket 接続は切断されるため、再接続を含めて確認する。

切替後は次を確認する。

- EC2 と OpenRC の health
- 公開 NIP-11
- 固定 REQ の EVENT と EOSE
- 写真サイトの HTTP、表示、console
- DynamoDB の読み取り

失敗時は旧インスタンスが残っている間に EIP association を旧機へ戻す。旧機の OS trust store は eMudhra 対策前の可能性があるため、rollback は可用性回復のための一時措置とする。対策版 `rustls-webpki` を含まない古い relay binary へは戻さない。

安定確認と別承認の後、旧 `aws_instance.relay` の state address を一時的な旧機 address へ移し、候補の address を正式な `aws_instance.relay` へ移す。各操作の直前・直後に resource address と instance ID を照合し、一度に複数の state 操作を行わない。EIP association が候補を参照することを確認してから、旧機だけを対象とする破棄 plan を別承認に回す。

旧機の root volume は終了時に削除されるため、snapshot の完了と保持方針を再確認してから削除する。候補用 Security Group の削除も別 plan で確認する。最後に一時 resource が state と AWS の双方に残っていないこと、および main の最終構成による full plan に差分がないことを確認する。

main の最終構成を移行前の state に直接 apply すると、旧 EC2 と EIP association をその場で置換する。旧機を保持した検証と rollback ができないため、この plan は apply しない。

## 別の未確認事項

GitHub Actions の `aws-actions/configure-aws-credentials@v6` は、正当な relay 配布が発生するまで実配布未確認として扱う。インスタンス入替のためだけに workflow を手動実行しない。
