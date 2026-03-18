import type { Card } from "./types";
import type {
  Grid,
  ColumnSlots,
  LayoutResult,
  Placement,
} from "./layoutTypes";
import { DEFAULT_CARD_HEIGHT } from "./constants";
import { GAP } from "./constants";

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
  // bestが同じ列にある場合は変更しない
  if (best.col === targetCol) {
    return best;
  }

  // bestと同じ列にある候補を抽出
  const sameColCandidates = filtered.filter((c) => c.col === best.col);

  // victimのスコア以下の変更候補を取得
  const changeCandidates = sameColCandidates.filter((c) => c.score <= victimScore);

  // 変更候補がない場合は元のbestのまま
  if (changeCandidates.length === 0) {
    return best;
  }

  // yが最小のものを選択
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

// ── コア: 配置 + 押し出し ──

/**
 * カード1枚を指定位置に配置し、押し出されるカードをドミノ式に処理する。
 *
 * 現在の LiveCanvas.tsx 内の placeCard と完全に同じロジック。
 * grid, columns, chain を in-place で更新する（呼び出し側が clone 責任）。
 *
 * 押し出しルール:
 * 0. 押し出されるカードが列の一番下 → その列の最後尾に配置して終了
 * 1. 押し出し先候補のリストアップ:
 *    - 同じ列の、元位置の直下のカード
 *    - 左右の列で、元位置とy座標が1pxでも重なるカード（複数可）
 * 2. 別列の候補から除外:
 *    - topのy座標が押し出されるカードの元位置のtopより小さい（上にある）もの
 *    - 既にこの連鎖で押し出されたもの
 * 3. 残った候補のうちスコアが最も低いものの位置に移動 → 連鎖
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

  // この位置にいるカードを探す（配置前に確認）
  const colCards = columns[targetCol];
  const victimEntry = colCards.find(
    (c) => c.id !== cardId && !chain.movedIds.has(c.id) && c.y === targetY,
  );

  // ── victim が holdSet に含まれる場合: cardId をリダイレクト ──
  if (victimEntry && holdSet.has(victimEntry.id)) {
    const victimId = victimEntry.id;
    const victimY = victimEntry.y;
    const victimHeight = heightMap.get(victimId) ?? DEFAULT_CARD_HEIGHT;

    // ステップ0: victim が列の一番下のカードか？
    const sameColOthers = columns[targetCol].filter((c) => c.id !== victimId);
    const isBottomOfColumn = sameColOthers.every((c) => c.y <= victimY);

    if (isBottomOfColumn) {
      // ホールドカードは動かない。cardId をその下に配置
      const newY = victimY + victimHeight + GAP;
      placeCard(grid, columns, cardId, targetCol, newY, heightMap, scoreMap, columnCount, chain, holdSet);
      return;
    }

    // ステップ1: 押し出し先候補のリストアップ（victim 基準で計算）
    const candidates: DisplaceCandidate[] = [];

    // 1a. 同じ列の、victim の直下のカード
    const belowInCol = columns[targetCol]
      .filter((c) => c.id !== victimId && c.y > victimY)
      .sort((a, b) => a.y - b.y);
    if (belowInCol.length > 0) {
      const below = belowInCol[0];
      candidates.push({
        id: below.id,
        col: targetCol,
        y: below.y,
        score: scoreMap.get(below.id) ?? 0,
      });
    }

    // 1b. 左右の列で、victim とy座標が1pxでも重なるカード
    const victimBottom = victimY + victimHeight;
    for (const adjCol of [targetCol - 1, targetCol + 1]) {
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
      if (c.col === targetCol) return true;
      if (c.y < victimY) return false;
      if (chain.movedIds.has(c.id)) return false;
      return true;
    });

    // ステップ3: 最低スコアの候補位置に cardId をリダイレクト
    if (filtered.length === 0) {
      // 候補がない → victim の下に cardId を配置
      const newY = victimY + victimHeight + GAP;
      placeCard(grid, columns, cardId, targetCol, newY, heightMap, scoreMap, columnCount, chain, holdSet);
      return;
    }

    let best = filtered.reduce((a, b) => (a.score <= b.score ? a : b));
    // 隣列の場合は上優先ロジックを適用
    best = applyTopPreferenceForAdjacentColumns(
      best,
      filtered,
      targetCol,
      scoreMap.get(victimId) ?? 0,
    );
    // cardId を best の位置にリダイレクト（連鎖は続く）
    placeCard(grid, columns, cardId, best.col, best.y, heightMap, scoreMap, columnCount, chain, holdSet);
    return;
  }

  // ── 通常フロー: cardId を配置 ──

  // 自分を配置（元の列から削除して新位置に）
  for (let c = 0; c < columnCount; c++) {
    columns[c] = columns[c].filter((card) => card.id !== cardId);
  }
  columns[targetCol].push({ id: cardId, y: targetY });
  grid.set(cardId, { col: targetCol, y: targetY });
  chain.movedIds.add(cardId);
  chain.chainOrder.set(cardId, chain.chainOrder.size);

  // 押し出す相手がいない → 終了
  if (!victimEntry) return;

  // columns が変更された後なので victim を探し直す
  const victim = columns[targetCol].find(
    (c) => c.id !== cardId && c.y === targetY && !chain.movedIds.has(c.id),
  );
  if (!victim) return;

  const victimId = victim.id;
  const victimY = victim.y;
  const victimHeight = heightMap.get(victimId) ?? DEFAULT_CARD_HEIGHT;

  // --- ステップ0: 列の一番下のカードなら最後尾に配置して終了 ---
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

  // --- ステップ1: 押し出し先候補のリストアップ ---
  const candidates: DisplaceCandidate[] = [];

  // 1a. 同じ列の、元位置の直下のカード
  const belowInCol = columns[targetCol]
    .filter((c) => c.id !== victimId && c.y > victimY)
    .sort((a, b) => a.y - b.y);
  if (belowInCol.length > 0) {
    const below = belowInCol[0];
    candidates.push({
      id: below.id,
      col: targetCol,
      y: below.y,
      score: scoreMap.get(below.id) ?? 0,
    });
  }

  // 1b. 左右の列で、元位置とy座標が1pxでも重なるカード
  const victimBottom = victimY + victimHeight;
  for (const adjCol of [targetCol - 1, targetCol + 1]) {
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

  // --- ステップ2: 別列の候補から除外 ---
  const filtered = candidates.filter((c) => {
    // 同じ列の候補は除外対象外（常に残る）
    if (c.col === targetCol) return true;

    // topのy座標が押し出されるカードの元位置のtopより小さい（上にある）もの
    if (c.y < victimY) return false;

    // 既にこの連鎖で押し出されたもの
    if (chain.movedIds.has(c.id)) return false;

    return true;
  });

  // --- ステップ3: 最もスコアが低いものを押し出し先とする ---
  if (filtered.length === 0) {
    // 候補がない → 下に配置して終了
    const newY = targetY + cardHeight + GAP;
    columns[targetCol] = columns[targetCol].filter((c) => c.id !== victimId);
    columns[targetCol].push({ id: victimId, y: newY });
    grid.set(victimId, { col: targetCol, y: newY });
    chain.movedIds.add(victimId);
    chain.chainOrder.set(victimId, chain.chainOrder.size);
    return;
  }

  let best = filtered.reduce((a, b) => (a.score <= b.score ? a : b));
  // 隣列の場合は上優先ロジックを適用
  best = applyTopPreferenceForAdjacentColumns(
    best,
    filtered,
    targetCol,
    scoreMap.get(victimId) ?? 0,
  );

  // 押し出されるカードを best の位置に配置 → best が次に押し出される
  placeCard(grid, columns, victimId, best.col, best.y, heightMap, scoreMap, columnCount, chain, holdSet);
}

// ── 公開API ──

/**
 * 初期配置（フルリビルド）。
 *
 * スコア昇順で「先頭スコアが最低の列」に振り分け、
 * 各列内をスコア降順にソートして上から積み上げる。
 *
 * prevGrid を使用しないため clone は不要。
 *
 * 使用場面:
 *   - 初回レンダリング時（grid.size === 0）
 *   - columnCount が変更されたとき
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
 *
 * 内部で prevGrid を clone（new Map）してから placeCard に渡すため、
 * 呼び出し側の prevGrid は変更されない。
 *
 * 使用場面:
 *   - WebSocket で新規ノートが到着したとき
 */
export function insertCard(
  prevGrid: Grid,
  note: Card,
  allNotes: readonly Card[],
  columnCount: number,
  heightMap: ReadonlyMap<string, number>,
  holdSet: ReadonlySet<string>,
): LayoutResult {
  // prevGrid を clone してから内部関数に渡す
  const grid = new Map(prevGrid);

  const columns = gridToColumns(grid, columnCount);

  // スコアマップ
  const scoreMap = new Map(allNotes.map((n) => [n.slotId, n.score]));

  // リアルタイム到着は常に一番左の列
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
 *
 * 内部で prevGrid を参照するのみで、変更はしない（新しい Grid を構築する）。
 *
 * 前提条件:
 *   - prevGrid に存在し activeNotes に含まれないカードは結果の Grid から除外される
 *   - prevGrid に存在しないカードは無視される（insertCard で対応すべきケース）
 *
 * 列内の順序は前回のy座標順を維持する（スコア順でソートしない）。
 * スコアの役割は初回配置（buildInitialLayout）、新規挿入（insertCard）の
 * 位置決めとフェードアウト判定に限定される。
 *
 * 使用場面:
 *   - heightMap が変更されたとき
 *   - カードが削除（フェードアウト完了）されたとき
 */
export function reflow(
  prevGrid: Grid,
  activeNotes: readonly Card[],
  columnCount: number,
  heightMap: ReadonlyMap<string, number>,
): LayoutResult {
  const grid = new Map<string, Placement>();
  for (let col = 0; col < columnCount; col++) {
    // 前回のy座標順を維持して積み上げ直す
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
