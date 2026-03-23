/**
 * store/pure/layoutEngine.ts
 *
 * レイアウトエンジンの純粋関数群。
 * lib/layoutEngine.ts からの移植（そのまま）。
 */

import type { Card } from "../../lib/types";
import type {
  Grid,
  ColumnSlots,
  LayoutResult,
  Placement,
} from "../../lib/layoutTypes";
import { DEFAULT_CARD_HEIGHT } from "../../lib/constants";
import { GAP } from "../../lib/constants";

// ── 内部型（エクスポートしない） ──

/** 押し出し候補。placeCard 内部のステップ1〜3で使用。 */
interface DisplaceCandidate {
  id: string;
  col: number;
  y: number;
  score: number;
}

// ── ヘルパー ──

/**
 * 隣列の場合は上優先ロジックを適用する。
 *
 * bestが隣の列（best.col !== targetCol）にある場合:
 * 1. filtered の中から best と同じ列にある候補を抽出
 * 2. その中で victimのスコア以下のものを「変更候補」とする
 * 3. 変更候補がある場合 → 変更候補の中でyが最小のものを新たなbestとする
 * 4. 変更候補がない場合 → 変更なし（元のbestのまま）
 */
function applyTopPreferenceForAdjacentColumns(
  best: DisplaceCandidate,
  filtered: DisplaceCandidate[],
  targetCol: number,
  victimScore: number,
): DisplaceCandidate {
  if (best.col === targetCol) {
    return best;
  }

  const sameColCandidates = filtered.filter((c) => c.col === best.col);
  const changeCandidates = sameColCandidates.filter((c) => c.score <= victimScore);

  if (changeCandidates.length === 0) {
    return best;
  }

  return changeCandidates.reduce((a, b) => (a.y <= b.y ? a : b));
}

/** Grid → ColumnSlots に変換 */
export function gridToColumns(grid: Grid, columnCount: number): ColumnSlots {
  const columns: ColumnSlots = Array.from({ length: columnCount }, () => []);
  for (const [id, placement] of grid) {
    if (placement.col < columnCount) {
      columns[placement.col].push({ id, y: placement.y });
    }
  }
  return columns;
}

/** ColumnSlots → Grid に書き戻す */
export function columnsToGrid(columns: ColumnSlots): Grid {
  const grid = new Map<string, Placement>();
  for (let col = 0; col < columns.length; col++) {
    for (const slot of columns[col]) {
      grid.set(slot.id, { col, y: slot.y });
    }
  }
  return grid;
}

/**
 * 押し出し先の最適候補を探す。
 * ステップ1〜3を共通化した内部ヘルパー。
 * @returns 最適な候補、または null（候補なし）
 */
function findDisplaceTarget(
  columns: ColumnSlots,
  victimId: string,
  victimCol: number,
  victimY: number,
  victimHeight: number,
  victimScore: number,
  heightMap: ReadonlyMap<string, number>,
  scoreMap: ReadonlyMap<string, number>,
  columnCount: number,
  chain: { movedIds: Set<string> },
): DisplaceCandidate | null {
  const candidates: DisplaceCandidate[] = [];

  // ステップ1a: 同じ列の、victimの直下のカード
  const belowInCol = columns[victimCol]
    .filter((c) => c.id !== victimId && c.y > victimY)
    .sort((a, b) => a.y - b.y);
  if (belowInCol.length > 0) {
    const below = belowInCol[0];
    candidates.push({
      id: below.id,
      col: victimCol,
      y: below.y,
      score: scoreMap.get(below.id) ?? 0,
    });
  }

  // ステップ1b: 左右の列で、victimとy座標が1pxでも重なるカード
  const victimBottom = victimY + victimHeight;
  for (const adjCol of [victimCol - 1, victimCol + 1]) {
    if (adjCol < 0 || adjCol >= columnCount) continue;
    for (const card of columns[adjCol]) {
      const cardH = heightMap.get(card.id) ?? DEFAULT_CARD_HEIGHT;
      const cardBottom = card.y + cardH;
      if (victimY < cardBottom && victimBottom > card.y) {
        candidates.push({
          id: card.id,
          col: adjCol,
          y: card.y,
          score: scoreMap.get(card.id) ?? 0,
        });
      }
    }
  }

  // ステップ2: 別列の候補から除外
  const filtered = candidates.filter((c) => {
    if (c.col === victimCol) return true;
    if (c.y < victimY) return false;
    if (chain.movedIds.has(c.id)) return false;
    return true;
  });

  // ステップ3: 最低スコアの候補を選択
  if (filtered.length === 0) return null;

  let best = filtered.reduce((a, b) => (a.score <= b.score ? a : b));
  best = applyTopPreferenceForAdjacentColumns(
    best,
    filtered,
    victimCol,
    victimScore,
  );

  return best;
}

// ── コア: 配置 + 押し出し ──

/**
 * カード1枚を指定位置に配置し、押し出されるカードをドミノ式に処理する。
 *
 * grid, columns, chain を in-place で更新する（呼び出し側が clone 責任）。
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
  holdSet: ReadonlySet<string>,
): void {
  const cardHeight = heightMap.get(cardId) ?? DEFAULT_CARD_HEIGHT;

  const colCards = columns[targetCol];
  const victimEntry = colCards.find(
    (c) => c.id !== cardId && !chain.movedIds.has(c.id) && c.y === targetY,
  );

  // ── victim が holdSet に含まれる場合: cardId をリダイレクト ──
  if (victimEntry && holdSet.has(victimEntry.id)) {
    const victimId = victimEntry.id;
    const victimY = victimEntry.y;
    const victimHeight = heightMap.get(victimId) ?? DEFAULT_CARD_HEIGHT;

    const sameColOthers = columns[targetCol].filter((c) => c.id !== victimId);
    const isBottomOfColumn = sameColOthers.every((c) => c.y <= victimY);

    if (isBottomOfColumn) {
      const newY = victimY + victimHeight + GAP;
      placeCard(grid, columns, cardId, targetCol, newY, heightMap, scoreMap, columnCount, chain, holdSet);
      return;
    }

    const victimScore = scoreMap.get(victimId) ?? 0;
    const target = findDisplaceTarget(columns, victimId, targetCol, victimY, victimHeight, victimScore, heightMap, scoreMap, columnCount, chain);

    if (!target) {
      const newY = victimY + victimHeight + GAP;
      placeCard(grid, columns, cardId, targetCol, newY, heightMap, scoreMap, columnCount, chain, holdSet);
      return;
    }

    placeCard(grid, columns, cardId, target.col, target.y, heightMap, scoreMap, columnCount, chain, holdSet);
    return;
  }

  // ── 通常フロー: cardId を配置 ──

  for (let c = 0; c < columnCount; c++) {
    columns[c] = columns[c].filter((card) => card.id !== cardId);
  }
  columns[targetCol].push({ id: cardId, y: targetY });
  grid.set(cardId, { col: targetCol, y: targetY });
  chain.movedIds.add(cardId);
  chain.chainOrder.set(cardId, chain.chainOrder.size);

  if (!victimEntry) return;

  const victim = columns[targetCol].find(
    (c) => c.id !== cardId && c.y === targetY && !chain.movedIds.has(c.id),
  );
  if (!victim) return;

  const victimId = victim.id;
  const victimY = victim.y;
  const victimHeight = heightMap.get(victimId) ?? DEFAULT_CARD_HEIGHT;

  const sameColOthers = columns[targetCol].filter((c) => c.id !== victimId);
  const isBottomOfColumn = sameColOthers.every((c) => c.y <= victimY);

  if (isBottomOfColumn) {
    const newY = targetY + cardHeight + GAP;
    columns[targetCol] = columns[targetCol].filter((c) => c.id !== victimId);
    columns[targetCol].push({ id: victimId, y: newY });
    grid.set(victimId, { col: targetCol, y: newY });
    chain.movedIds.add(victimId);
    chain.chainOrder.set(victimId, chain.chainOrder.size);
    return;
  }

  const victimScore = scoreMap.get(victimId) ?? 0;
  const target = findDisplaceTarget(columns, victimId, targetCol, victimY, victimHeight, victimScore, heightMap, scoreMap, columnCount, chain);

  if (!target) {
    const newY = targetY + cardHeight + GAP;
    columns[targetCol] = columns[targetCol].filter((c) => c.id !== victimId);
    columns[targetCol].push({ id: victimId, y: newY });
    grid.set(victimId, { col: targetCol, y: newY });
    chain.movedIds.add(victimId);
    chain.chainOrder.set(victimId, chain.chainOrder.size);
    return;
  }

  placeCard(grid, columns, victimId, target.col, target.y, heightMap, scoreMap, columnCount, chain, holdSet);
}

// ── 公開API ──

/**
 * 初期配置（フルリビルド）。
 *
 * スコア昇順で「先頭スコアが最低の列」に振り分け、
 * 各列内をスコア降順にソートして上から積み上げる。
 */
export function buildInitialLayout(
  sortedNotes: readonly Card[],
  columnCount: number,
  heightMap: ReadonlyMap<string, number>,
): LayoutResult {
  const grid = new Map<string, Placement>();

  const colNotes: string[][] = Array.from({ length: columnCount }, () => []);

  const notesAsc = [...sortedNotes].reverse();
  const topScore = new Array<number>(columnCount).fill(-Infinity);

  for (const note of notesAsc) {
    let bestCol = 0;
    for (let c = 1; c < columnCount; c++) {
      if (topScore[c] < topScore[bestCol]) {
        bestCol = c;
      }
    }
    colNotes[bestCol].push(note.slotId);
    topScore[bestCol] = note.score;
  }

  const scoreMap = new Map(sortedNotes.map((n) => [n.slotId, n.score]));
  for (let col = 0; col < columnCount; col++) {
    colNotes[col].sort((a, b) => (scoreMap.get(b) ?? 0) - (scoreMap.get(a) ?? 0));
    let y = 0;
    for (const id of colNotes[col]) {
      grid.set(id, { col, y });
      y += (heightMap.get(id) ?? DEFAULT_CARD_HEIGHT) + GAP;
    }
  }

  return {
    grid,
    chain: { movedIds: new Set(), chainOrder: new Map() },
  };
}

/**
 * 新規カード挿入。
 *
 * 新しいカードを「常に列0（一番左）の y=0」に配置し、
 * 押し出し連鎖を実行する。
 */
export function insertCard(
  prevGrid: Grid,
  note: Card,
  allNotes: readonly Card[],
  columnCount: number,
  heightMap: ReadonlyMap<string, number>,
  holdSet: ReadonlySet<string>,
): LayoutResult {
  const grid = new Map(prevGrid);
  const columns = gridToColumns(grid, columnCount);
  const scoreMap = new Map(allNotes.map((n) => [n.slotId, n.score]));

  const bestCol = 0;

  const chain = { movedIds: new Set<string>(), chainOrder: new Map<string, number>() };
  placeCard(grid, columns, note.slotId, bestCol, 0, heightMap, scoreMap, columnCount, chain, holdSet);

  return { grid, chain };
}

/**
 * y座標の再計算（列割り当て維持）。
 *
 * 各カードの列割り当てはそのまま、高さ変更やカード削除に応じて
 * y座標だけを再計算する。
 */
export function reflow(
  prevGrid: Grid,
  activeNotes: readonly Card[],
  columnCount: number,
  heightMap: ReadonlyMap<string, number>,
): LayoutResult {
  const grid = new Map<string, Placement>();
  for (let col = 0; col < columnCount; col++) {
    const colCards = activeNotes
      .filter((n) => {
        const p = prevGrid.get(n.slotId);
        return p !== undefined && p.col === col;
      })
      .sort((a, b) => {
        const pa = prevGrid.get(a.slotId)!;
        const pb = prevGrid.get(b.slotId)!;
        return pa.y - pb.y;
      });
    let y = 0;
    for (const note of colCards) {
      grid.set(note.slotId, { col, y });
      y += (heightMap.get(note.slotId) ?? DEFAULT_CARD_HEIGHT) + GAP;
    }
  }

  return {
    grid,
    chain: { movedIds: new Set(), chainOrder: new Map() },
  };
}
