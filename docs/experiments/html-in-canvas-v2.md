# HTML-in-Canvas V2 実験

## 入口と安全性

- `/`: 既存 V1。`LiveCanvas.tsx` / `useCardLayout.ts` / `layoutEngine.ts` は変更しない。
- `/v2`: 同じ認証・購読・署名・投稿を新しい描画エンジンへ接続する。投稿やリアクションは**実リレーへ送信される**。
- `/v2/lab`: 固定カードを使う隔離した描画確認画面。AuthProviderを起動せず、署名・リレー接続・投稿を行わない。
- V1/V2間の移動は画面を作り直す。**未送信の下書きは移動前に処理する**。同じV2内のnative/DOM切替はカードのDOMとReact stateを維持する。

これは描画・配置を入れ替えるV2の最初の縦切り実装。認証、Nostr購読、スレッド構築、署名、カードの内容部品は再利用する。旧配置・Framer Motion依存の描画はV2から切り離した。全機能の作り直し・性能改善の実測・本番移行完了ではない。

## 新しい分離

1. `Home`: V1/V2共通の接続境界。
2. `LiveCanvasV2`: スコア、下書き、楽観的投稿、返信のslotId統合。署名権限は従来通り。
3. `v2/scene.ts`: CSS pxの配置とカメラ。既存順序を維持し、新着は末尾の短い列へ追加。V1の引力・dominoとは意図的に別仕様。
4. `v2/CanvasScene.tsx`: 直接のcanvas子要素をHTMLで組み、paintで`drawElementImage`。DOMの複製やhtml2canvasは使わない。ViewportサイズのbitmapをDPR対応で確保し、カメラで移動・拡大する。
5. SSRと初回hydrationではportalを出さず、hydration完了後に接続する。カードは安定したportal先を持つ。nativeが失敗したら同じDOMを通常表示へ移すため、入力やカードstateを再生成しない。

## 対応検出

`requestPaint` と `drawElementImage` が両方あることを確認する。`content` がある世代は `content="drawable"` と子の `drawable`、旧世代は `layoutsubtree` を使う。旧世代だけ戻り値のDOMMatrixをtransformに反映する。modernでは自動geometry更新に任せる。

能力検出だけでnative成功とは表示しない。最初のdrawが成功してからnativeバッジを表示する。APIなし、draw例外、最初のpaintが期限内に来ない場合はDOMへ戻す。手動切替も可能。

Chrome公式記事では157で正式搭載。旧Chromeや他エンジンの対応はバージョン文字列で断定せず、実際の能力を調べる。Chromeフラグや利用者のブラウザ設定は変更しない。

- https://developer.chrome.com/blog/html-in-canvas
- https://developer.chrome.com/blog/html-in-canvas-ot-changes
- https://developer.chrome.com/docs/web-platform/html-in-canvas/concepts
- https://developer.chrome.com/docs/web-platform/html-in-canvas/2d
- https://wicg.github.io/html-in-canvas/

## 操作・制約

余白ドラッグ、ホイール移動、Ctrl/Meta+ホイールズーム、縮小/拡大ボタン、原点ボタン。ズームボタンは画面中央を基準に35〜200%の範囲で操作できる。領域にフォーカスして上下キー/Homeも使用できる。入力欄のホイールは奪わない。リンク・ボタン・入力をnative DOMとして残し、座標だけの独自クリック配送はしない。

- 新着や高さ変化はResizeObserverで測定し、rAFで配置、paintで描画する。常時animation loopを回さない。
- 操作中のカードはholdし、非holdカードの重なりを押し下げる。複数holdカード同士の成長による衝突解消は未対応。
- 現段階では全カードを描画し、カリングはしない。既存購読側の上限は維持するが、巨大スレッド/画像/動画の性能実測はこれから。
- cross-origin画像を含むbitmapのPNG出力は実装しない。
- アニメーション、タッチpinch、V1引力レイアウトの再現は未実装。

## 確認手順

```sh
cd apps/web
npm ci
npm run lint
npm test
npx tsc --noEmit --incremental false
npm run build
npm run dev
```

最初は `/v2/lab` を開く。nativeバッジ、実際の描画、ボタンの当たり判定、Tab、入力、DOM切替前後の入力保持、スクロールとズーム、原点、追加・削除、ウィンドウサイズ変更、DPR 1/2を確認する。nativeのモックテストはブラウザでの確認の代わりではない。

実データの署名・投稿は `docs/testing/local-nip46-e2e.md` の隔離リレーと使い捨て鍵で行う。本アカウントへのテスト投稿は禁止。

## 実ブラウザ確認とhydration修正

lakcheのChrome 157.0.8103.51からVercel Previewの `/v2/lab` を確認した。

- native modernで6枚のカードが目視でき、実際の画面座標クリックでボタンのカウントが増加した。
- 日本語のtextarea入力、選択範囲4〜9、段落のドラッグ選択を確認した。
- native→DOM→nativeの往復後も入力値とクリック数を維持した。
- 余白ドラッグでカメラを移動した後も別カードの画面座標クリックが正しく動作した。通常ホイールの移動と原点復帰も確認した。
- 7枚目の追加・削除、Tabでtextboxからリンクへの移動を確認した。
- `/v2` は未認証ログイン画面のみ確認し、ログイン・署名・実リレー送信は行っていない。

同時に初回読込でReact hydrationエラー #418 を確認した。serverでは空、clientではportalを即時描画する差を `useSyncExternalStore` のserver snapshotで解消する。SSR→hydrateRootの回帰テストは修正前にエラーを再現し、修正後は回復可能エラーなしで入力フォーカスとボタン操作まで確認する。portal接続はカードのautofocusより先に完了する。追加した縮小/拡大ボタンは中心座標維持・範囲制限・原点復帰を単体テストする。

## この変更で未検証のもの

hydration修正後のPreviewでの再確認と、新しいズームボタンによるnative拡大後のヒットテストはこれから。DPR切替、モバイル、巨大スレッド/メディア負荷、実リレーE2Eも未検証。モックnative APIのテストは実ブラウザ検証とは区別する。クラウドの独立Chromium起動はOSのsocket権限で制限されたため、上記の目視確認はlakcheで行った。Draft PRとして扱い、本番採用判断は残る検証後に行う。
