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

hydration修正23004d4はChrome157で再確認し、#418なし、125%拡大後のクリック、100%復帰を確認済み。DPR切替、モバイル、巨大スレッド/メディア負荷、実リレーE2Eも未検証。モックnative APIのテストは実ブラウザ検証とは区別する。クラウドの独立Chromium起動はOSのsocket権限で制限されたため、上記の目視確認はlakcheで行った。Draft PRとして扱い、本番採用判断は残る検証後に行う。


## 同一origin画像配信の限定試作

実フィードで読み込み済みの外部アバターやpreview画像がnative snapshotでは透明になることを確認した。未公開だった画像DOM合成案は採用せず、標準Next Image Optimizationの `/_next/image` から画像を配信する。

`CanvasImageProvider` の配下（V2カード）だけに画像ポリシーを適用する。avatar、引用avatar、本文、preview、カスタム絵文字、リアクション画像、画像lightboxを共通wrapperへ通す。V1では元のNext Image/unoptimizedまたはimgを使う。カード・画像・テキスト・クリック領域はnative canvas内に残し、画像用DOM overlayは作らない。

### 許可範囲と失敗時

- 実feedで確認した `share.yabu.me`、`i.gyazo.com`、`0.gravatar.com`、`cdn.nostrcheck.me`、`i.floppy.media` のexact host、HTTPS、標準port、queryなしのみ。subdomain wildcardは使わない。
- UIのsource検査ではuserinfo、query/fragment、外部SVG、その他host、blob/data URLを拒否する。gravatarのsize/default等のqueryも初期段階では未対応。ファイル選択で自前生成したblobプレビューだけは既存の同一origin表示を維持する。非対応・取得失敗は理由付きplaceholderにし、元の外部URLへ自動fallbackしない。
- optimizerは固定width（32/64/128/640/1280）とquality75、SVG無効、localPatterns空、厳しい画像CSPを指定する。自前 `/icon.svg` だけは最適化不要の同一origin画像として直接表示する。
- `<img>`で元URLが読み込めても、optimizer側からの取得拒否・redirect・format・サイズ・認証依存によって失敗し得る。全Nostr画像対応を目指した設定ではない。

### Vercelで保証していない点

`maximumRedirects: 0`、`maximumResponseBody: 5_000_000`、`dangerouslyAllowLocalIP: false` はself-host Nextの設定として指定した。ただしVercel managed image serviceでこれらの設定が同じ制限として適用されるか確認できていないため、**Vercel Previewでredirect0・5MB上限・private-IP拒否がこの設定により保証されるとは主張しない**。managed側の実挙動は別途確認が必要であり、実運用に十分な安全対策を完了した状態ではない。

クライアントのURL検査は公開optimizer endpointの包括的な認証・安全境界ではない。第三者によるendpoint直接利用、許可hostからのredirect、DNS変化、取得・変換の課金/負荷は残る検討事項。queryなしのexact-host制限はserver remotePatternsにも設定するが、任意hostは許可しない。cookieや認証headerを転送する独自処理、独自fetch proxy route、外部proxyサービスは追加しない。

画像URLと画像bytesはアプリの配信基盤/Vercelを経由し、キャッシュやログに残り得る。非公開画像・signed URLは対象外。最低cache TTLは60秒にするが、上流header/基盤のcache設定により更新反映が遅れる場合がある。ネットワーク/変換費用と多数画像の性能は未計測。

### 検証

単体テストでsource許可/拒否、固定width/quality、V1維持、V2の同一origin src、srcsetからの迂回防止、エラーplaceholder、src更新時の再試行を検証する。`/v2/lab` は初期状態では外部通信なしで、URLを明示入力した場合だけこのポリシーを通して取得する。新Previewでは実画像のnative描画・zoom後クリック、許可外/query/SVGの拒否、Vercelのredirect/size挙動を分けて検証する。成功する実画像の表示確認と、server安全制限の適用確認を混同しない。
