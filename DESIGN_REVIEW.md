## 総合評価
要修正（軽微）

## 良い点
- **ドメインモデルの命名と粒度が適切**: `Placement`, `Grid`, `ColumnSlots`, `DisplaceChain`, `LayoutResult` の5つの型で配置問題の全概念を過不足なくカバーしている。既存コード内のインライン定義（`CardPlacement`, `columns`, `movedInChain` + `chainOrder`）を名前付き型に昇格させただけで、新しい概念を持ち込んでいない
- **エンジンのReact非依存が明確**: `layoutEngine.ts` は React を一切 import せず、`layoutTypes.ts` と定数のみに依存。テスタビリティが大幅に向上する
- **公開API が3関数に整理されている**: `buildInitialLayout`, `insertCard`, `reflow` の3シナリオに分けたことで、呼び出し側の判定ロジックが明確になっている
- **実装に忠実な設計**: ステップ2の「高さによる除外」がコメントにはあるが実装にはない点を正確に把握し、実装側に合わせている
- **既存動作チェックリストが網羅的**: 対応表と挙動チェックリストで既存コードとの対応が一目でわかる
- **過度な抽象化がない**: 560行のコードに対して、型定義ファイル + エンジンファイル + 定数ファイルの3ファイル追加は妥当。Strategy パターンや過剰なインターフェース階層がなく、現実的

## 指摘事項

### [軽微] Grid（ReadonlyMap）と placeCard の mutable Map の関係が不明確
- 問題: `Grid` は `ReadonlyMap<string, Placement>` と定義されているが、`placeCard` は `grid: Map<string, Placement>` を受け取り in-place で更新する。公開API（`insertCard` 等）は `prevGrid: Grid`（ReadonlyMap）を受け取って `LayoutResult`（`grid: Grid` = ReadonlyMap）を返す。この中間で ReadonlyMap → mutable Map → ReadonlyMap の変換が必要だが、設計ドキュメント上でこの変換責任が明記されていない
- 提案: 公開API関数の実装ガイドラインとして「prevGrid を `new Map(prevGrid)` でコピーしてから placeCard に渡し、結果をそのまま Grid として返す」旨を明記する。あるいは `placeCard` の `grid` パラメータの型注釈に「※ 呼び出し側が clone 責任」と書いてあるので、公開API側にも対応する一文を追加する

### [軽微] reflow 内の列内ソート順の仕様が暗黙的
- 問題: 現在のコードの高さ変更/カード削除ブランチでは、`scoredNotes`（スコア降順ソート済み）を `filter` して列ごとのカードを取得している。filter は元配列の順序を保持するため、列内はスコア降順で積み上げられる。しかし DESIGN.md の `reflow` のシグネチャでは `activeNotes: readonly CanvasNote[]` が「スコア降順ソート済みであること」が前提条件として明記されていない
- 提案: `reflow` の JSDoc に「activeNotes はスコア降順でソート済みであること（列内の積み上げ順序に影響する）」を追記する

### [軽微] reflow で prevGrid に存在するが activeNotes にないカード（削除済み）の扱いが暗黙的
- 問題: `reflow` は `prevGrid` と `activeNotes` の両方を受け取るが、prevGrid にあって activeNotes にないカード（削除されたカード）の処理が設計上明記されていない。現在のコードでは `scoredNotes.filter(n => layout.get(n.id)?.col === col)` で activeNotes 側を起点にイテレートしているため削除済みカードは自然に除外されるが、この挙動を仕様として明文化すべき
- 提案: `reflow` の説明に「prevGrid に存在し activeNotes に含まれないカードは結果の Grid から除外される」を追記する

### [軽微] reflow で activeNotes にあるが prevGrid にないカードの扱いが未定義
- 問題: 通常フローでは発生しないが、`reflow` が呼ばれた時点で prevGrid に存在しないカードが activeNotes に含まれるエッジケースの挙動が未定義。現在のコードでは `layoutState.layout.get(n.id)` が undefined を返すため、どの列にも配置されずに消失する
- 提案: このケースは現在のコードでも未処理なので、設計上も「prevGrid に存在しないカードは無視する（insertCard で対応すべきケース）」と明記するか、将来的にフォールバック列（col=0）に配置するかを決める

### [軽微] DisplaceCandidate のエクスポート範囲
- 問題: `DisplaceCandidate` は `placeCard` 内部のステップ1〜3でのみ使用される型。エクスポートされているが、外部から参照する消費者がいない
- 提案: `layoutEngine.ts` 内のローカル型（非エクスポート）にするか、テスト用にエクスポートする旨をコメントで明記する

### [軽微] React側シナリオBで複数ノート挿入時の chainOrder 重複
- 問題: セクション4のシナリオBで、複数の新規ノートを順次 `insertCard` で処理する際、各呼び出しの `chainOrder` は 0 から始まる。`mergedChainOrder` に `set` で上書きマージしているため、同じカードが複数回の挿入で移動した場合、後の挿入の order が上書きされる。現在のコードでも同じ挙動なので「バグ」ではないが、設計として意図的かどうかが不明
- 提案: 複数ノード同時挿入は実運用で稀（WebSocket で1件ずつ到着）なので、現状維持でよい。ただし「複数同時挿入時の chainOrder は最後の挿入の値が優先される」旨をコメントとして残すと保守性が上がる

## 既存動作チェックリスト
- [x] 初期配置（スコア昇順→先頭スコア最低の列に配置）— `buildInitialLayout` で同一ロジックを実装。`notesAsc` のソートと `topScore` による列選択が設計に含まれている
- [x] 新規カード挿入（左列、y=0、押し出し連鎖）— `insertCard` で `bestCol = 0` をハードコード、`placeCard` に委譲
- [x] 押し出しステップ0（列の一番下→最後尾に配置）— `placeCard` 内部ロジック（セクション3の擬似コード）で明記
- [x] 押し出しステップ1（同列直下 + 左右重なりカード候補リスト）— `placeCard` 内部ロジックのステップ1a, 1b で明記
- [x] 押し出しステップ2（別列候補の除外条件）— `placeCard` 内部ロジック。高さ除外を実装に合わせて省略している点も正確
- [x] 押し出しステップ3（スコア最低を選択→再帰）— `placeCard` の再帰呼び出しで明記
- [x] ドミノアニメーション遅延 — `DisplaceChain.chainOrder` × `DOMINO_DELAY` → React側 `delayMap`
- [x] z-index制御（スコア降順インデックス）— React側に残す方針が対応表で明記。`colNotes.length - colNotes.indexOf(note)` のロジック維持
- [x] 高さ変更時の再配置 — `reflow` で列割り当て維持・y座標のみ再計算
- [x] カード削除時の処理 — React側の `cleanGrid` でのフィルタリング + `reflow` の組み合わせ
- [x] カラム数変更時の再配置 — シナリオ判定で `columnCount !== prevColumnCount` → `buildInitialLayout` を呼び出し
