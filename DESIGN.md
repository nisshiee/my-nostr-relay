# DESIGN.md — 配置エンジン リファクタリング設計

## 1. ドメインモデル（型定義）

すべての型は `apps/web/app/lib/layoutTypes.ts` に定義する。

```ts
// ── 既存（変更なし） ──
// CanvasNote, NostrProfile は apps/web/app/lib/types.ts のまま

// ── 新規 ──

/** カード1枚の配置座標 */
export interface Placement {
  col: number;
  y: number;
}

/**
 * グリッド全体の配置状態。
 * カードID → Placement の不変マップ。
 * エンジンの入力にも出力にもなる中心的な型。
 */
export type Grid = ReadonlyMap<string, Placement>;

/**
 * 列ごとのカードスロット。
 * エンジン内部の作業用構造。Grid との相互変換ヘルパーで生成する。
 * columns[colIndex] = そのカラムに属するカードの配列（y昇順）。
 */
export type ColumnSlots = { id: string; y: number }[][];

/**
 * 押し出し連鎖（DisplaceChain）の結果。
 * placeCard 1回の呼び出しで発生した全移動を記録する。
 */
export interface DisplaceChain {
  /** 連鎖で移動したカードID（挿入されたカード自身を含む）の順序付きリスト */
  movedIds: ReadonlySet<string>;
  /**
   * 各カードの連鎖順序。
   * key=カードID, value=0始まりの連鎖ステップ番号。
   * React側でこれを DOMINO_DELAY 倍してアニメーション遅延に変換する。
   */
  chainOrder: ReadonlyMap<string, number>;
}

/**
 * 配置エンジンの出力。
 * すべてのエンジン関数がこの型を返す。
 */
export interface LayoutResult {
  grid: Grid;
  /** 連鎖情報。初期配置・高さ変更時は空（chainOrder.size === 0） */
  chain: DisplaceChain;
}

/**
 * 押し出し候補。placeCard 内部のステップ1〜3で使用。
 */
export interface DisplaceCandidate {
  id: string;
  col: number;
  y: number;
  score: number;
}
```

### 各型の役割

| 型 | 役割 |
|---|---|
| `Placement` | 現在の `CardPlacement` と同一。1枚のカードの列番号とy座標 |
| `Grid` | `Map<string, CardPlacement>` を `ReadonlyMap` に昇格。エンジンの入出力の共通通貨 |
| `ColumnSlots` | `{ id, y }[][]` — `placeCard` が操作する作業用構造。Grid から生成し、結果を Grid に書き戻す |
| `DisplaceChain` | 現在バラバラに管理されている `movedInChain`(Set) と `chainOrder`(Map) を1つに統合 |
| `LayoutResult` | エンジンの全関数の戻り値。Grid と連鎖情報のペア |
| `DisplaceCandidate` | 現在 `placeCard` 内でインラインに定義されている `Candidate` インターフェースを昇格 |

---

## 2. モジュール構成

```
apps/web/app/
├── lib/
│   ├── types.ts              # CanvasNote, NostrProfile（変更なし）
│   ├── constants.ts           # RELAY_URL, COLUMN_WIDTH 等（変更なし）
│   ├── scoring.ts             # calcFreshnessScore, sortByScore（変更なし）
│   ├── layoutTypes.ts         # ★新規: 上記ドメインモデルの型定義
│   ├── layoutEngine.ts        # ★新規: 配置エンジン（純粋関数）
│   └── layoutConstants.ts     # ★新規: GAP, DOMINO_DELAY
├── components/
│   ├── LiveCanvas.tsx          # 薄いReactコンポーネント
│   └── NoteCard.tsx            # 変更なし
```

### `layoutConstants.ts`

```ts
/** カード間のギャップ（px）— mb-3 相当 */
export const GAP = 12;

/** ドミノアニメーションの1ステップあたりの遅延（秒） */
export const DOMINO_DELAY = 0.5;
```

### ファイル分割の方針

- **`layoutTypes.ts`**: 型定義のみ。実装なし。`layoutEngine.ts` と `LiveCanvas.tsx` の両方が import する
- **`layoutEngine.ts`**: React を一切 import しない。`layoutTypes.ts` と `constants.ts` と `layoutConstants.ts` のみに依存。すべて純粋関数
- **`LiveCanvas.tsx`**: `layoutEngine.ts` の関数を呼ぶだけ。配置ロジックは一切持たない

---

## 3. 配置エンジンの関数インターフェース

### `layoutEngine.ts` のエクスポート

```ts
import type { CanvasNote } from "./types";
import type {
  Grid,
  ColumnSlots,
  LayoutResult,
  DisplaceChain,
  DisplaceCandidate,
  Placement,
} from "./layoutTypes";
import { DEFAULT_CARD_HEIGHT } from "./constants";
import { GAP } from "./layoutConstants";

// ── ヘルパー（エクスポートするがエンジン内部向け） ──

/** Grid → ColumnSlots に変換 */
export function gridToColumns(grid: Grid, columnCount: number): ColumnSlots;

/** ColumnSlots → Grid に書き戻す */
export function columnsToGrid(columns: ColumnSlots): Grid;

// ── コア: 配置 + 押し出し ──

/**
 * カード1枚を指定位置に配置し、押し出し連鎖を再帰的に処理する。
 *
 * 現在の placeCard と完全に同じロジック。
 * 違い: columns を外から受け取り mutate して返す（呼び出し側が clone 責任）。
 * movedInChain / chainOrder は DisplaceChain に統合。
 *
 * 引数:
 *   grid       - 現在の Grid（mutable な Map として渡す。関数内で更新される）
 *   columns    - 現在の ColumnSlots（mutable。関数内で更新される）
 *   cardId     - 配置するカードID
 *   targetCol  - 配置先の列
 *   targetY    - 配置先のy座標
 *   heightMap  - カードID → 高さ(px)
 *   scoreMap   - カードID → フレッシュネススコア
 *   columnCount - 列数
 *   chain      - 連鎖の追跡状態（mutable。関数内で更新される）
 *
 * 戻り値: void（grid, columns, chain を in-place で更新）
 */
export function placeCard(
  grid: Map<string, Placement>,
  columns: ColumnSlots,
  cardId: string,
  targetCol: number,
  targetY: number,
  heightMap: ReadonlyMap<string, number>,
  scoreMap: ReadonlyMap<string, number>,
  columnCount: number,
  chain: { movedIds: Set<string>; chainOrder: Map<string, number> },
): void;

// ── 公開API: 3つのレイアウトシナリオ ──

/**
 * 初期配置（フルリビルド）。
 *
 * スコア昇順で「先頭スコアが最低の列」に振り分け、
 * 各列内をスコア降順にソートして上から積み上げる。
 *
 * 使用場面:
 *   - 初回レンダリング時（layout.size === 0）
 *   - columnCount が変更されたとき
 */
export function buildInitialLayout(
  sortedNotes: readonly CanvasNote[],
  columnCount: number,
  heightMap: ReadonlyMap<string, number>,
): LayoutResult;

/**
 * 新規カード挿入。
 *
 * 新しいカードを「常に列0（一番左）の y=0」に配置し、
 * 押し出し連鎖を実行する。
 *
 * 使用場面:
 *   - WebSocket で新規ノートが到着したとき
 */
export function insertCard(
  prevGrid: Grid,
  note: CanvasNote,
  allNotes: readonly CanvasNote[],
  columnCount: number,
  heightMap: ReadonlyMap<string, number>,
): LayoutResult;

/**
 * y座標の再計算（列割り当て維持）。
 *
 * 各カードの列割り当てはそのまま、高さ変更やカード削除に応じて
 * y座標だけを再計算する。
 *
 * 使用場面:
 *   - heightMap が変更されたとき
 *   - カードが削除（フェードアウト完了）されたとき
 */
export function reflow(
  prevGrid: Grid,
  activeNotes: readonly CanvasNote[],
  columnCount: number,
  heightMap: ReadonlyMap<string, number>,
): LayoutResult;
```

### `placeCard` の内部ロジック（ステップ0〜3の対応）

現在のコードの再帰ステップをそのまま維持する:

```
placeCard(grid, columns, cardId, targetCol, targetY, heightMap, scoreMap, columnCount, chain)
│
├─ 自分を配置: grid.set(cardId, {col: targetCol, y: targetY})
│  columns から旧位置を除去、新位置に push
│  chain.movedIds.add(cardId), chain.chainOrder.set(cardId, chain.chainOrder.size)
│
├─ victim を探す: targetCol の targetY にいる、まだ移動していないカード
│  └─ いなければ → return
│
├─ ステップ0: victim が列の一番下？
│  └─ YES → victim を targetY + cardHeight + GAP に配置して return
│
├─ ステップ1: 押し出し先候補のリストアップ
│  ├─ 1a. 同じ列の直下のカード（victimY より下で最も近いもの）
│  └─ 1b. 左右の列で victim と y 範囲が重なるカード
│
├─ ステップ2: 別列候補のフィルタリング
│  ├─ victim より上にある（c.y < victimY）→ 除外
│  └─ chain.movedIds に含まれる → 除外
│
├─ ステップ3: 残った候補のうちスコア最低の best を選択
│  ├─ 候補なし → victim を下に配置して return
│  └─ 候補あり → placeCard(…, victimId, best.col, best.y, …) を再帰呼び出し
```

> **注意**: 現在のコードではステップ2で「押し出されるカードより高さが大きいもの」の除外条件がコメントに記載されているが、実装には含まれていない。設計はコメントではなく**実装に忠実**にする（高さによる除外は行わない）。

---

## 4. React側のインターフェース

### `LiveCanvas.tsx` の責務

1. **ウィンドウ幅 → columnCount** の計算（`useState` + `resize` イベント）
2. **nowEpoch の定期更新** → `scoredNotes` の `useMemo` 計算
3. **heightMap の管理**（`NoteCard` からの `onHeightChange` コールバック）
4. **レイアウトシナリオの判定** → エンジン関数の呼び出し
5. **LayoutResult → motion.div の変換**（描画のみ）

### 状態管理の方針

```ts
// LiveCanvas 内の state
const [layoutState, setLayoutState] = useState<{
  grid: Grid;                         // ← layout → grid にリネーム
  delayMap: Map<string, number>;      // chainOrder × DOMINO_DELAY
  prevNoteIds: Set<string>;
  prevColumnCount: number;
  prevHeightMap: Map<string, number>;
}>({ ... });
```

### シナリオ判定ロジック（render中の同期更新、現在と同じパターン）

```ts
if (currentNoteIds !== layoutState.prevNoteIds ||
    columnCount !== layoutState.prevColumnCount ||
    heightMap !== layoutState.prevHeightMap) {

  let result: LayoutResult;

  if (columnCount !== layoutState.prevColumnCount || layoutState.grid.size === 0) {
    // ── シナリオA: 初期配置 / カラム数変更 ──
    result = buildInitialLayout(scoredNotes, columnCount, heightMap);
    // delayMap は空（アニメーション遅延なし）

  } else {
    const newNotes = scoredNotes.filter(n => !layoutState.prevNoteIds.has(n.id));

    if (newNotes.length > 0) {
      // ── シナリオB: 新規カード挿入 ──
      let grid = layoutState.grid;
      let mergedChainOrder = new Map<string, number>();
      for (const note of newNotes) {
        result = insertCard(grid, note, scoredNotes, columnCount, heightMap);
        grid = result.grid;
        for (const [id, order] of result.chain.chainOrder) {
          mergedChainOrder.set(id, order);
        }
      }
      result = { grid, chain: { movedIds: new Set(), chainOrder: mergedChainOrder } };

    } else {
      // ── シナリオC: 高さ変更 / カード削除 ──
      result = reflow(layoutState.grid, scoredNotes, columnCount, heightMap);
    }
  }

  // delayMap 変換: chainOrder × DOMINO_DELAY
  const delayMap = new Map<string, number>();
  for (const [id, order] of result.chain.chainOrder) {
    delayMap.set(id, order * DOMINO_DELAY);
  }

  // grid から削除済みカードを除去
  const cleanGrid = new Map<string, Placement>();
  for (const [id, p] of result.grid) {
    if (currentNoteIds.has(id)) cleanGrid.set(id, p);
  }

  setLayoutState({
    grid: cleanGrid,
    delayMap,
    prevNoteIds: currentNoteIds,
    prevColumnCount: columnCount,
    prevHeightMap: heightMap,
  });
}
```

### z-index の計算

現在のロジックをそのまま維持:
```ts
// 列内のスコア降順インデックス → 高スコアほど高い z-index
const zIndex = colNotes.length - colNotes.indexOf(note);
```

### アニメーション

`motion.div` の `transition.y.delay` に `delayMap.get(note.id) ?? 0` を適用。現在と同じ。

---

## 5. 既存動作の対応表

| 現在のコード（LiveCanvas.tsx内） | 新設計 |
|---|---|
| `interface CardPlacement { col, y }` | `layoutTypes.ts` の `Placement` |
| `Map<string, CardPlacement>` (layout) | `Grid`（`ReadonlyMap<string, Placement>`） |
| `columns: { id, y }[][]` | `ColumnSlots` 型。`gridToColumns()` で生成 |
| `movedInChain: Set<string>` | `DisplaceChain.movedIds` |
| `chainOrder: Map<string, number>` | `DisplaceChain.chainOrder` |
| `interface Candidate` (placeCard内) | `DisplaceCandidate` |
| `placeCard()` 関数（LiveCanvas.tsx内） | `layoutEngine.ts` の `placeCard()` — ロジック同一 |
| `buildInitialLayout()` 関数（LiveCanvas.tsx内） | `layoutEngine.ts` の `buildInitialLayout()` — 戻り値が `LayoutResult` に |
| `insertIntoLayout()` 関数（LiveCanvas.tsx内） | `layoutEngine.ts` の `insertCard()` — 戻り値が `LayoutResult` に |
| render内の「高さ変更/カード削除→y再計算」ブロック | `layoutEngine.ts` の `reflow()` として独立関数化 |
| `const GAP = 12` | `layoutConstants.ts` へ移動 |
| `const DOMINO_DELAY = 0.5` | `layoutConstants.ts` へ移動 |
| `calcColumnCount()` | `LiveCanvas.tsx` に残す（UIの関心事） |
| `computeColumnHeight()` | `LiveCanvas.tsx` に残す（描画用ヘルパー） |
| `statusIndicator()` | `LiveCanvas.tsx` に残す（純粋にUIの関心事） |
| `handleHeightChange` コールバック | `LiveCanvas.tsx` に残す（React state管理） |
| render中のシナリオ判定 if文 | `LiveCanvas.tsx` に残すが、分岐先がエンジン関数呼び出しのみに簡素化 |
| `motion.div` の `transition.y.delay` | `LiveCanvas.tsx` — `delayMap` から取得（現在と同じ） |
| z-index 計算 `colNotes.length - colNotes.indexOf(note)` | `LiveCanvas.tsx` に残す（描画の関心事） |

### 挙動の維持チェックリスト

- [x] 初期配置: スコア昇順で「先頭スコア最低の列」に振り分け → `buildInitialLayout`
- [x] 新規カード: 常に列0の y=0 に配置 → `insertCard` 内で `bestCol = 0` をハードコード
- [x] ステップ0: 列末尾のカードは下に押し出して終了 → `placeCard` 内
- [x] ステップ1a: 同列直下の候補 → `placeCard` 内
- [x] ステップ1b: 隣接列のy重なり候補 → `placeCard` 内
- [x] ステップ2: 上方カード・既移動カードの除外 → `placeCard` 内
- [x] ステップ3: スコア最低候補への再帰的押し出し → `placeCard` 内の再帰呼び出し
- [x] ドミノアニメーション遅延: `chainOrder × DOMINO_DELAY` → React側で `delayMap` に変換
- [x] z-index: スコア降順の列内インデックス → React側で計算
- [x] 高さ変更時: 列割り当て維持、y座標のみ再計算 → `reflow`
- [x] カード削除時: Grid からの除去 → React側のクリーンアップ + `reflow`
- [x] columnCount変更時: フルリビルド → `buildInitialLayout`
