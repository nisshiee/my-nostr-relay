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


## 同一origin画像配信: 本命基盤（既定で無効）

前段の5host標準optimizer試作4fa38daでは、Chrome157のimmutable Previewで画像読み込み・native描画・125%クリック・pan/原点復帰を確認した。認証済み実feedでもavatar表示とconsole errorなしを確認した。これらは以下の新routeの実機検証ではない。

V2の画像wrapperは `/api/canvas-image` へ統一し、配信元hostの固定allowlistを撤去する。V1の画像表示は変更しない。カード・画像・テキストはnative canvas内に残し、DOM画像overlayは使わない。Next optimizerのremotePatternsは空にして取得境界の迂回を防ぐ。

### 有効化ゲート

routeは既定で503を返し、DNS解決も外部取得もしない。有効化には `CANVAS_IMAGE_PROXY_ENABLED=1` と `CANVAS_IMAGE_PROXY_SCOPE=protected-preview` の両方が必要。`VERCEL_ENV` / `VERCEL_TARGET_ENV` のどちらかがproductionまたは未知の値なら拒否する。platform環境変数がない場合、Preview専用scope設定を信頼境界とする。この場合はコードだけでdeploymentのproduction判定を証明できないため、2変数をproductionへ設定しないことが必須であり、「常にproductionを独立検出して拒否」とは主張しない。

E2E中に限定許可を受け、上記2つの非secret設定をVercel target=preview、gitBranch=experiment/html-in-canvas-v2だけへ追加した。projectのSSO保護（全Preview）は維持し、予約system変数の上書き・全project設定変更・新credentialsは行わない。request query/header/cookieはgateの根拠に使わない。QA後はフラグとscopeを無効値へ戻す。既存immutable deploymentには環境snapshotが残るため、復旧後の設定変更だけで既存URLを停止したことにはならない。

一般公開や本番有効化は別の判断であり、この実装だけで完了としない。既定ではV2の外部画像はplaceholderとなる。前段の成功版immutable Previewは比較用に残る。

### 取得・画像境界

- 公開HTTPS標準portのhostnameのみ。userinfo、未許可query/fragment、IP literal、SVGを拒否する。host制限撤去は認証付き画像やsigned URLの対応を意味しない。
- Node runtimeでDNSの全候補を検査し、検査済みIPだけを接続lookupに固定する。TLS hostnameとSNIは元hostnameを維持し、redirectごとに検査する。
- DNSを含む10秒deadline、redirect最大2回、stream入力5MiB上限を設ける。上流cookie/Authorization/Refererは送らず、上流headerを応答へ転送しない。
- JPEG/PNG/WebP/静止AVIFのMIMEと実体を確認し（application/octet-streamはJPEG/PNG/WebPの3形式だけに限定して判定し）、Sharpの1600万画素・1frame・協調的処理時間制限を通して固定幅（32/64/128/640/1280）・quality75のWebPに再エンコードし、出力2MiB上限を設ける。出力byte検査前にnative側でbufferが確保され得るため、この値だけでprocess memory上限を保証しない。SVG・アニメーション等の非対応画像は拒否する。
- 取得・変換失敗時に外部URLへfallbackしない。ファイル選択で自前生成したblobプレビューと自前iconは従来通り。

### 濫用・コスト制約

routeにはprocess内の同時実行制限、token bucket、容量制限付きTTL cache、inflight dedupeを設ける。Sharpのtimeoutは協調的で、native処理の即時停止・強制CPU隔離は保証しない。native decode中のdeadline超過では未終了処理の可能性があるためslotを保持し、2slotが残存した場合そのprocessの新規取得は停止する。通常の取得拒否とDNS/HTTP段階のtimeoutはslotを解放する。ただしserverless複数instance全体のquotaではなく、総費用上限を保証しない。任意URLの量産やinstance増加への分散制御は残る。Nostr pubkeyの提示、Origin/Referer、匿名署名だけを認証・濫用防止と扱わない。

このため一般公開を有効にする前に、分散quotaまたは検証済みの入口制限等を別途整備する必要がある。新権限・資源・設定が必要になれば追加判断を求める。画像URL・bytesはアプリ基盤を経由するためprivacyと課金の評価も必要。新routeの大量feed性能、Vercel上のdecode資源境界、実ブラウザ画像描画は未検証。

### 検証の区別

単体テストではdefault-off、URL検査、DNS/IP固定、redirect、timeout、byte/MIME/decode境界、cache/同時数、V1維持、V2 srcとエラーplaceholderを検証する。mock HTTP/DNSによる境界テストは本番ネットワークの実証ではない。限定Previewの保護と有効化が確認できない場合は新routeの実機QAを行わず、local/test結果のみを報告する。

### 多数画像と実フィード検証

`/v2/lab` の成功は部品検証であり、認証済み実フィードのE2E成功を意味しない。off復旧版で画像がplaceholderになるのはgateの期待動作。これとは別に、旧UIでは同時2件を超えた429も初回onErrorで永久placeholderとなる欠陥があった。

V2専用のsame-origin fetch queue（max2）、同一URLdedupe、bounded retry/cooldown、未使用blobに32件/16MiB/30秒の制限を持つcacheを追加する。表示中blobは参照がある間保持するため、この値は全体memory上限ではない。429はRetry-Afterに従い専用再試行8回まで、通常失敗は追加1回まで、503は停止する。元の外部URLへのfallbackはしない。成功画像bytesのblob URLは同一originとして扱うが、native描画の実機確認を別途行う。V1は変更しない。

serverは同時2件を維持し、process bucketをburst60・毎秒4補充へ調整する。これは保護Preview内の補助制限であり、一般公開の費用保証ではない。実feedの多数画像、pan、profile表示、非対応query/formatによる欠落と一時制限による欠落を分けて確認するまでE2E完了とはしない。

### 実フィードのMIME不整合

認証済み実フィードでavatar/本文写真・pan後の増分画像・profile開閉を確認した。残失敗の1例は通常imgで表示できる画像がVercel取得時に `application/octet-stream` を返すことが固定分類ログで判明した。拡張子を信用せず、octet-streamだけは入力上限内でbytesを読み、JPEG/PNG/WebP magicと完全decodeを通ったもののみWebPへ再encodeする。HTML/SVG/GIF/未知形式は通さず、標準MIMEとmagicの不一致も拒否する。query/認証/ネットワーク制限は変更しない。

### 静止AVIFと観測済みquery

実feedの残失敗1件を単独routeと固定MIMEログでAVIFと特定した。AVIFはISOBMFF ftyp brand/box構造を検査し、avis/moov等のsequence・未知brandを拒否する。SharpのHEIF形式・AV1圧縮・pages1検査と既存画素/byte/deadlineを通してWebPへ変換する。octet-streamのAVIFはまだ対象外。

queryはclientとserver共通の狭い許可ルールを使う。実feedで正常表示される0.gravatar.comの /avatar/32桁または64桁hex に限り、唯一のsize=整数1..2048を許可する。公開X metadataで確認したpbs.twimg.com/media/安全なfilenameに限り、format=webpとname=largeの2組だけを許可する。未知key・重複・認証/署名値・別host/pathへは広げない。redirectも同じ検査を通す。

これらは公開サイズ/形式指定でありsecretを含む任意queryは受け付けない。許可された画像URL自体はVercelのリクエスト/キャッシュへ渡るが、アプリはURL全文や上流headerをログしない。Kojiraのv queryは用途未確定で、追加取得403後は調査を止め未許可とした。HTTP画像はTLS制約のため引き続き拒否する。

### 埋込みrasterと追加の公開変換query

実フィードの代替表示6箇所を調査した。1件はHTTPではなくdata:image/png;base64（437x437）、3件は2.gravatar.comのsize/d、1件はXの動画thumbnail、1件はBASEの画像変換queryだった。表示文言だけからHTTPや取得失敗と断定しない。

埋込み画像はclientで厳密なbase64とJPEG/PNG/WebP/AVIFラベルを検査し、decoded 2MiB以内だけを同一origin POST /api/canvas-imageへ送る。URIをURL queryへ入れず、JSON本文はstream 3MiB・5秒・同時読取2件に制限する。serverはbase64/実体/animation/pixel/deadlineを独立検査し既存Sharp変換を共有する。GETとPOSTは同じgate、同時decode枠、token予算を使う。cache keyはdigestであり、raw dataをログしない。SVG/GIFや任意data MIMEは許可しない。client入力構文チェックだけをdecoder安全性とは扱わない。

Gravatarは実際に観測した0.gravatar.comと2.gravatar.comのavatar hex pathに限り、size整数1..2048と任意のd=initialsだけを許可する。Gravatar公式はdに外部URLも認めるため、その一般仕様を丸ごと許可しない。Xは同じ固定format=webp/name=largeに対して、観測したamplify_video_thumb/数字/img/安全なfilenameパスを追加する。Xのこのパスを公式保証としては扱わない。

BASEはbaseec-img-mng.akamaized.netの/images/item/origin/32hex画像だけ、観測済みimformat=generic、q=90、im=Resize,width=1200,type=normalの3組を許可する。Akamaiのimは一般には複雑な変換DSLなので、任意構文・Composite・外部URL・未知の数値指定は許可しない。qの一般仕様を検証済みとはせず観測値だけに固定する。初回公開page読取と既受信metadataのDOM確認を根拠とし、追加取得のHTTP拒否後に別取得経路で回避はしていない。

資料: https://docs.gravatar.com/sdk/images/ 、 https://techdocs.akamai.com/ivm/docs/imquery 。新しいdata/追加queryの実フィードE2Eは公開後に別途実施する。従来ded8413aでは認証済み実フィードの225画像、AVIF/Gravatar/X画像のnative表示、pan/zoom/profile/新着を確認済みだが、新経路の成功とは区別する。保護されたbranch Previewはユーザーの継続確認用に有効のまま維持し、設定削除・本番有効化は行わない。

POSTにはJSON読取前のprocess token bucket（burst10・毎秒1補充）も追加する。無効なJSONも予算を消費し、枯渇時は本文を読む前に429を返す。これもinstance内の補助制限であり、分散課金上限・強制CPU停止の保証ではない。
