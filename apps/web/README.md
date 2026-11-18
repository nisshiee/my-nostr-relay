# Nostr Live Canvas

Nostrのノート・リポスト・リアクションをライブ表示するNext.jsアプリ。

## 改修を始める前に

1. リポジトリルートの `CLAUDE.md` を読む。コメント・コミット・PRは日本語。
2. [購読・配置の契約](../../docs/architecture/live-canvas-contracts.md)で責務と不変条件を確認する。
3. 変更対象の `app/**/__tests__/` で現状を確認し、回帰テストから始める。

入口は `app/page.tsx`、認証・購読と画面をつなぐのは `app/components/Home.tsx`、購読の組合せは `useNostrRelay.ts`。`LiveCanvas.tsx` がカードを統合し、配置の純粋関数 `layoutEngine.ts` を `components/canvas/scene.ts` が呼び出す。測定・hold表示・描画は `CanvasScene.tsx`、移動アニメーションは `sceneMotion.ts` が担当する。

## 開発・検証

Node.js 22以降を使用する。

```sh
npm ci
npm run dev
```

通常の `npm run dev` はアカウントのリレーと公開bootstrapリレーへ接続する。使い捨て鍵による検証は下記の隔離手順を使い、実アカウントでテスト投稿しない。

変更後は次のコマンドで確認する。

```sh
npm run lint
npm test
npx tsc --noEmit --incremental false
npm run build
```

Frontend CIはlint・テスト・buildを実行する。過去のテスト数や警告の記録だけで、現在の変更が検証済みとは扱わない。

## ローカル E2E 動作確認

[ローカル NIP-46 E2E 手順](../../docs/testing/local-nip46-e2e.md)では、アプリの一時コピー、使い捨て鍵、localhostのnakリレー・署名器を使用する。ブラウザで接続・署名・投稿・再取得を確認し、独立した購読で署名を検証する。任意のストリームfixtureと空フォローfixtureも利用できる。

### NIP-46 upstream connection patch

The pinned `window.nostr.js@0.8.1` bundle is patched during `npm ci` / `npm install`
by `scripts/patch-remote-signer.mjs`. Installation fails closed if the version or
the full bundle SHA-256 differs from the audited release. Update/remove this patch
when upgrading the dependency; do not bypass the integrity check.

The patch makes optional `switch_relays` maintenance non-blocking after connecting
and draining the public-key queue. A failed connection rejects queued callers and
creates a fresh internal signer promise for the next attempt. It does not change
identity verification, signing permissions, relay destinations, or saved credentials.
The failure/retry and successful-connect/unsupported-switch cases are tested without
real keys, signing, or network access.

This fixes reproducible upstream lifecycle bugs, not a proven diagnosis of every
remote-signer outage. Real signer approval and response delivery still depend on the
signer and relays. The app's automatic-restoration timeout remains in place.

### 投稿内の動画リンク

本文中の公開HTTPS MP4/WebMリンクは静止した「動画を再生」ボタンとして表示する。
クリックするまではvideo要素、poster、動画の先読み、OGP取得を行わない。
クリック後はCanvas外の通常DOMダイアログでブラウザ標準のcontrolsを使って再生する。
再生開始がブラウザに拒否された場合はcontrolsから開始できる。閉じる、URL変更、
カード削除、エラー時は停止してsrcを解除する。URL変更後は新しい動画を自動で開かない。
動画ダイアログ内にギャラリー切替は設けず、閉じて別のボタンから選択する。

動画はCanvasへ取り込まないためcrossOrigin属性を付けず、CORS許可を再生条件にしない。
画像のanonymous CORS取得は変更しない。動画配信元には利用者のIPやアクセス時刻が伝わり、
ブラウザの通常のCookie・Referrerポリシーが適用される。サーバーproxy、認証情報の注入、
動画URLのHEAD検査やBlobへの全件ダウンロードは行わない。
URL検査は画像と同じ公開HTTPS hostname境界を利用するが、DNSや転送先の完全な検査ではない。
拡張子はコーデック対応を保証しない。再生失敗時は元リンクを残す。
YouTube等のページ埋込、HLS/DASH、カード内再生、動画の自動サムネイル生成は対象外。
