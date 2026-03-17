# CODE_REVIEW.md — 配置エンジン リファクタリング コードレビュー

## 総合評価
要修正（軽微）

全体として設計に忠実で高品質なリファクタリング。placeCard の再帰ロジック、buildInitialLayout のソート・列選択、insertCard の bestCol=0 はすべて元コードと一致している。型安全性も向上しており、`any` の使用はゼロ。1件の軽微な動作差異と数件の改善提案がある。

---

## 設計との整合性

### 型定義（layoutTypes.ts）
- ✅ `Placement`, `Grid`, `ColumnSlots`, `DisplaceChain`, `LayoutResult` — DESIGN.md のドメインモデルと完全一致
- ✅ `Grid = ReadonlyMap<string, Placement>` — 設計通り
- ✅ `DisplaceChain` が `movedIds`(ReadonlySet) と `chainOrder`(ReadonlyMap) を統合 — 設計通り

### 定数（layoutConstants.ts）
- ✅ `GAP = 12`, `DOMINO_DELAY = 0.5` — 元コードと同一値

### 公開API シグネチャ（layoutEngine.ts）
- ✅ `buildInitialLayout(sortedNotes, columnCount, heightMap) → LayoutResult`
- ✅ `insertCard(prevGrid, note, allNotes, columnCount, heightMap) → LayoutResult`
- ✅ `reflow(prevGrid, activeNotes, columnCount, heightMap) → LayoutResult`
- すべて DESIGN.md セクション3のシグネチャと一致

### placeCard のステップ0-3
- ✅ ステップ0: 列の一番下 → `targetY + cardHeight + GAP` に配置して終了
- ✅ ステップ1a: 同列直下のカード候補
- ✅ ステップ1b: 左右の列でy範囲が重なるカード候補
- ✅ ステップ2: 別列候補の除外（`c.y < victimY` と `chain.movedIds.has(c.id)`）
- ✅ ステップ3: スコア最低の候補に再帰呼び出し / 候補なしなら下に配置
- 元コードのコメントにあった「高さによる除外」は元コードの実装にもないため、設計通り省略されている ✅

### React側のシナリオ判定（LiveCanvas.tsx）
- ✅ シナリオA: `columnCount !== prevColumnCount || grid.size === 0` → `buildInitialLayout`
- ✅ シナリオB: `newNotes.length > 0` → `insertCard` ループ
- ✅ シナリオC: それ以外 → `reflow`
- DESIGN.md セクション4の判定ロジックと一致

---

## 動作維持の確認

### 元コードとの詳細比較

| 項目 | 結果 | 備考 |
|------|------|------|
| placeCard 再帰ロジック全条件分岐 | ✅ 同一 | `movedInChain` + optional `chainOrder` → `chain` オブジェクトに統合。`if (chainOrder)` ガードが不要になったが、常に書き込むため動作は同一 |
| buildInitialLayout ソート順・列選択 | ✅ 同一 | `notesAsc = [...sortedNotes].reverse()` → `topScore` による列選択 → 列内スコア降順ソート → y積み上げ |
| insertCard bestCol = 0 | ✅ 維持 | `const bestCol = 0;` がハードコード |
| reflow 列割り当て維持・y再計算 | ✅ 同一 | `prevGrid.get(n.id)` で列を参照、`activeNotes` を filter して積み上げ |
| z-index 計算 | ✅ 同一 | `colNotes.length - colNotes.indexOf(note)` |
| GAP=12, DOMINO_DELAY=0.5 | ✅ 維持 | |
| gridToColumns / columnsToGrid ヘルパー | ✅ | 元コードの `insertIntoLayout` 内のインライン columns 構築と同一ロジック |

### ⚠️ 動作差異: シナリオCでの delayMap リセット

**元コード:**
```ts
let newDelayMap: Map<string, number> = layoutState.delayMap;  // 前回値を保持
// ...
} else {
  // シナリオC: newDelayMap は更新されない → 前回の delayMap が維持される
}
```

**新コード:**
```ts
// シナリオ判定の後、全シナリオ共通で:
const delayMap = new Map<string, number>();
for (const [id, order] of result.chain.chainOrder) {
  delayMap.set(id, order * DOMINO_DELAY);
}
// reflow の chainOrder は空 → delayMap は常に空になる
```

**影響:** シナリオC（高さ変更/カード削除）が発生したとき、元コードではシナリオB（挿入）で設定されたドミノアニメーション遅延が維持されるが、新コードでは遅延がクリアされる。

**実影響度:** 低。高さ変更は通常 ResizeObserver 経由で挿入アニメーション完了後に発火するため、遅延値が残っていても新たなアニメーション開始には使われないケースが多い。ただし、挿入直後に高さ変更が連続で発生した場合、元コードではドミノアニメーションが自然に繋がるが、新コードではカードが一斉に移動する可能性がある。

**提案:** 意図的な改善であれば問題ないが、元コードとの完全一致を目指すなら、シナリオCの場合に `layoutState.delayMap` を引き継ぐ処理を追加する。

---

## コード品質

### 型安全性
- ✅ `any` の使用: ゼロ
- ✅ 型アサーション (`as`): ゼロ
- ✅ `ReadonlyMap` / `ReadonlySet` / `readonly` 配列を適切に使用し、不変性を型レベルで保証
- ✅ `placeCard` の内部では mutable な `Map`/`Set` を使い、公開API の戻り値では Readonly に。責任分界が明確

### 命名の一貫性
- ✅ `Placement` / `Grid` / `ColumnSlots` が layoutEngine.ts と LiveCanvas.tsx で統一して使用
- ✅ `layout` → `grid` へのリネームが LiveCanvas.tsx 内で一貫
- ✅ `CardPlacement` → `Placement`, `insertIntoLayout` → `insertCard` のリネームが設計通り

### JSDoc / コメント
- ✅ placeCard の押し出しルール（ステップ0-3）がJSDocに明記
- ✅ 各公開APIに使用場面が記載
- ✅ reflow の前提条件（ソート順、削除カード、未知カード）がJSDocに明記
- ✅ insertCard の clone 責任がコメントで明記

### 不要なコード
- ✅ 不要なコードなし。元コードの配置ロジックが完全に LiveCanvas.tsx から除去されている

### import の整理
- ✅ layoutEngine.ts: `DisplaceChain` を import していない（`chain` パラメータはインライン型）— 適切
- ✅ LiveCanvas.tsx: `Grid`, `Placement` のみ import。不要な import なし
- 軽微: `layoutEngine.ts` が `DisplaceCandidate` を import リストから除外している（内部で再定義）— 正しい判断

---

## 設計レビュー指摘の反映状況

- [x] **ReadonlyMap ↔ mutable Map の変換責任の明記** — `insertCard` に `// prevGrid を clone してから内部関数に渡す` コメントあり。`placeCard` JSDoc に `呼び出し側が clone 責任` 記載。`buildInitialLayout` は prevGrid を使わないため clone 不要の旨も記載
- [x] **reflow のソート順前提条件の明記** — `reflow` JSDoc の前提条件セクションに `activeNotes はスコア降順でソート済みであること（列内の積み上げ順序に影響する）` を明記
- [x] **reflow の削除カード扱いの明記** — `prevGrid に存在し activeNotes に含まれないカードは結果の Grid から除外される` を明記
- [x] **reflow の prevGrid にないカードの扱いの明記** — `prevGrid に存在しないカードは無視される（insertCard で対応すべきケース）` を明記
- [x] **DisplaceCandidate のエクスポート範囲** — `layoutTypes.ts` からは除外し、`layoutEngine.ts` 内のローカル `interface`（非エクスポート）として定義。`// 内部型（エクスポートしない）` コメント付き
- [x] **複数ノート同時挿入時の chainOrder コメント** — LiveCanvas.tsx のシナリオBに `// 複数同時挿入時の chainOrder は最後の挿入の値が優先される` と `// （実運用では WebSocket で1件ずつ到着するため稀なケース）` を明記

全6件反映済み ✅

---

## 指摘事項

### [軽微] シナリオCでの delayMap リセットが元コードと異なる
- **問題:** 上記「動作差異」セクション参照。reflow 時に元コードでは前回の delayMap を維持するが、新コードでは空にリセットされる
- **提案:** 以下のいずれか:
  1. シナリオCの場合のみ `layoutState.delayMap` を引き継ぐ（元コード準拠）
  2. 意図的な改善として README/コメントに記載する（「reflow 時はドミノ遅延をリセットし、全カードが同時に移動する」）

```ts
// 案1: 元コード準拠にする場合
if (result.chain.chainOrder.size > 0) {
  const delayMap = new Map<string, number>();
  for (const [id, order] of result.chain.chainOrder) {
    delayMap.set(id, order * DOMINO_DELAY);
  }
  // use delayMap
} else {
  // シナリオA or C: delayMap を維持 or リセット
  // シナリオA（初期配置）ではリセット、Cでは維持
}
```

ただし実影響度は低いため、修正は任意。
