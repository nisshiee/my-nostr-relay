# Nostr Live Canvas

Nostrのノート・リポスト・リアクションをライブ表示するNext.jsアプリ。

## 改修を始める前に

1. リポジトリルートの `CLAUDE.md` を読む。コメント・コミット・PRは日本語。
2. [購読・配置の契約](../../docs/architecture/live-canvas-contracts.md)で責務と不変条件を確認する。
3. 変更対象の `app/**/__tests__/` で現状を確認し、回帰テストから始める。

入口は `app/page.tsx`、認証・購読と画面をつなぐのは `app/components/Home.tsx`、購読の組合せは `useNostrRelay.ts`。`LiveCanvasV2.tsx` がカードを統合し、配置の純粋関数 `layoutEngine.ts` を `components/v2/scene.ts` が呼び出す。測定・hold表示・描画は `CanvasScene.tsx`、移動アニメーションは `sceneMotion.ts` が担当する。

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
