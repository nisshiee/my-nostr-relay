# ライブラリ更新 Phase 0 基準記録

記録日: 2026-10-24 (JST)

基準 commit: `e4d6ddc7f343924ed8e201448402b60571c1c2b3`

この文書は依存ライブラリ更新前の基準と、テスト・配布前ゲートの確認範囲を記録する。
本番への書込み、投稿、署名、鍵取得、設定変更、ロールバック操作は行っていない。

## Web 基準

lakche (macOS ARM64、Node.js v22.16.0、npm 10.9.2) で以下を実行した。

```console
cd apps/web
npm ci
npm run lint
npm test
npm run build
```

- install: 成功。lockfile の変更なし。
- lint: 成功。ただし既存の warning が24件（error は0件）。
- test: 10 files、194 tests が成功。
- build: 成功。10 routes を生成。
- 既存 warning: Vitest config の将来互換警告、複数 lockfile による Next.js workspace root 推論警告、npm audit の脆弱性報告がある。Phase 0 では依存更新や既存 warning の修正を行わない。

Frontend CI は `npm test` を lint と build の間で実行する。`apps/web/**` に加えて workflow 自身の変更でも起動する。

## Rust 基準

lakche (macOS ARM64、Rust 1.97.1) で以下を実行した。

```console
cd services/relay
cargo fmt -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

- fmt: 成功。
- clippy: 成功（全 target、全 feature、warning を error 化）。
- test: unit 182件、E2E 30件、NIP-11 4件の合計216件が成功。
- 既存 warning: default feature の `cargo test` では `src/main.rs` の `tracing::error` が未使用として1件報告される。`dynamo` feature では使用される import であり、今回の変更起因ではない。

本番相当の ARM64 Linux コンテナ (`rust:1.97.1-bookworm`) で `musl-tools` と対象をセットアップし、次を実行した。

```console
cargo build --locked --release --target aarch64-unknown-linux-musl --features dynamo
```

build は成功した。実 workflow も同じ target、feature、lockfile を用いる。README 相当の古い SSM/AL2023 記載ではなく、現行実装は Alpine Linux の EC2 に GitHub Actions から SSH し、`doas /usr/local/bin/nostr-relay-deploy.sh` を実行する。

## DynamoDB Local

変更前の `cargo test --features dynamo store::dynamo::tests -- --nocapture` は DynamoDB Local が起動していなくても保存エラーを捕捉して return し、2 tests を成功扱いにしていた。

Phase 0 では Rust CI に公式 DynamoDB Local コンテナを追加し、次を明示的に実行する。

```console
cargo test --features dynamo store::dynamo::tests
```

テスト自身が本番と同じ主キー、GSI、provisioned capacity の一時テーブルを作成する。接続、テーブル作成、保存、置換、再ロード、削除のいずれかが失敗すればテストも失敗する。実 AWS のテーブルやデータには接続しない。

## 配布ゲート

変更前は Rust CI と Deploy が `main` push で別々に起動し、Deploy は同じ SHA の CI 成功を待たなかった。

Phase 0 後の順序は次のとおり。

1. `services/relay/**` または `deploy/**` の main 変更で Rust CI を起動する。
2. Rust CI が fmt、clippy、通常テスト、DynamoDB Local テスト、本番 musl build を実行する。
3. Deploy は `workflow_run` で Rust CI 完了後にのみ起動する。
4. Rust CI の結論が `success` で、branch が `main` の場合だけ、`workflow_run.head_sha` を checkout する。
5. 同じ SHA に `services/relay` または `deploy` の変更がある場合だけ既存の AWS 認証、S3 upload、SSH deploy を実行する。

Rust CI の失敗・cancel・skip では deploy job の条件が false となり、AWS 認証より前で配布を抑止する。workflow だけの変更では Rust CI は起動して定義を検証するが、配布対象判定は false となる。OIDC/IAM、secret、SSH、AWS resource の権限は変更していない。任意 branch から CI を迂回できた手動 Deploy は廃止した。

## 公開系 read-only 基準

lakche の国内回線から確認した。

- 固定 REQ: `wss://relay.nostr.nisshiee.org/` に `["REQ","phase0-baseline",{"kinds":[1],"limit":1}]` を送信し、EVENT 1件と対応する EOSE を受信した。CLOSE 以外の書込みは行っていない。
- NIP-11: `Accept: application/nostr+json` で取得成功。`version` は `2.0.0`、`supported_nips` は `[1,9,11,70]`。
- 写真サイト: `https://nisshiee.org/photos` は redirect 後も同 URL、HTTP 200、`text/html; charset=utf-8`。

## ロールバック調査

確認できた事実:

- Deploy は SHA 固有 key ではなく `s3://nostr-relay-binary-426192960050/relay-v2/relay` を上書きする。
- EC2 の deploy script も同じ固定 key を `/opt/nostr-relay-v2/relay` に取得して service を再起動する。
- Terraform は配布 bucket の S3 Versioning を `Enabled` と定義し、EC2 role に `s3:GetObjectVersion` を許可している。
- Git の旧 commit と `Cargo.lock`、固定 Rust toolchain から旧バイナリを再 build する経路はある。

未確認・制約:

- 実 bucket の versioning 状態と、固定 key に残る具体的な VersionId 一覧は AWS MFA 入力が必要だったため未確認。Terraform の定義だけから旧成果物が実在すると仮定してはならない。
- 現 workflow は Git commit と S3 VersionId の対応表や SHA 固有 artifact を保存していない。
- したがってロールバック前には、権限を持つ運用者が `list-object-versions` で対象 VersionId と時刻を確認するか、旧 commit を checkout して lockfile 固定で再 build し、候補バイナリを検証する必要がある。
- VersionId 指定の復元、固定 key への再 upload、SSH deploy は本番変更になるため Phase 0 では実行していない。

