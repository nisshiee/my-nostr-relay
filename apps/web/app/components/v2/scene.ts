import { DEFAULT_CARD_HEIGHT, COLUMN_GAP } from '../../lib/constants';
import { buildInitialLayout, insertCard, reflow } from '../../lib/layoutEngine';
import type { Grid, Placement } from '../../lib/layoutTypes';
import type { Card } from '../../lib/types';

/** V2の配置とモーションはカメラから独立したCSS pxのワールド座標で扱う。 */
export interface SceneBox { x: number; y: number; width: number; height: number }
export interface Camera { x: 0; y: number; zoom: 1 }
export interface SceneLayoutItem { id: string; card?: Card }
export interface SceneLayoutResult {
  boxes: Map<string, SceneBox>;
  chainOrder: Map<string, number>;
  columnCount: number;
}
export interface SceneLayoutState extends SceneLayoutResult {
  /** V1エンジンの論理座標。holdの表示座標をここへ書き戻さない。 */
  grid: Grid;
  engineBoxes: Map<string, SceneBox>;
  frozenBoxes: Map<string, SceneBox>;
  previousIds: ReadonlySet<string>;
  inputs: {
    items: readonly SceneLayoutItem[];
    heights: ReadonlyMap<string, number>;
    heldIds: ReadonlySet<string>;
    width: number;
  } | null;
}

const MARGIN = 16;
const EMPTY_IDS: ReadonlySet<string> = new Set();

function validHeights(heights: ReadonlyMap<string, number>): Map<string, number> {
  return new Map([...heights].filter(([, height]) => Number.isFinite(height) && height >= 0));
}

/** 論理gridと実表示holdを分離したまま、描画用のBoxへ変換する。 */
function projectBoxes(
  grid: Grid, width: number, heights: ReadonlyMap<string, number>,
  heldIds: ReadonlySet<string>, previousFrozen: ReadonlyMap<string, SceneBox>,
  currentBoxes: ReadonlyMap<string, SceneBox>,
): Pick<SceneLayoutState, 'boxes' | 'engineBoxes' | 'frozenBoxes'> {
  const engineBoxes = new Map<string, SceneBox>();
  for (const [id, placement] of grid) {
    engineBoxes.set(id, {
      x: MARGIN + placement.col * (width + COLUMN_GAP), y: MARGIN + placement.y,
      width, height: heights.get(id) ?? DEFAULT_CARD_HEIGHT,
    });
  }
  // V2既存仕様: focus/holdは実座標を固定し、列数変更でも表示の固定を保つ。
  // 論理gridは通常どおりreflowするため、表示上の一時的な重なりは許容する。
  const frozenBoxes = new Map<string, SceneBox>();
  for (const id of heldIds) {
    const target = engineBoxes.get(id);
    if (!target) continue;
    const anchor = previousFrozen.get(id) ?? currentBoxes.get(id) ?? target;
    frozenBoxes.set(id, { ...anchor, height: target.height });
  }
  const boxes = new Map([...engineBoxes].map(([id, target]) => [id, { ...(frozenBoxes.get(id) ?? target) }]));
  return { boxes, engineBoxes, frozenBoxes };
}

function dimensions(viewport: number): { width: number; columnCount: number } {
  const viewportWidth = Number.isFinite(viewport) ? Math.max(1, viewport) : 400;
  const width = Math.max(160, Math.min(360, viewportWidth - MARGIN * 2));
  return { width, columnCount: Math.max(1, Math.floor((viewportWidth - MARGIN) / (width + COLUMN_GAP))) };
}

/** lab等のメタデータなしカードも同じエンジンを通す。無関係なカードに引力を作らない。 */
function cardsFor(items: readonly SceneLayoutItem[]): Card[] {
  return items.map((item, index) => item.card
    ? { ...item.card, slotId: item.id }
    : {
      type: 'note', slotId: item.id, eventId: `scene:${item.id}`, pubkey: `scene:${item.id}`,
      created_at: 0, score: items.length - index, content: '', tags: [],
    });
}

export function createSceneLayout(): SceneLayoutState {
  return {
    boxes: new Map(), engineBoxes: new Map(), grid: new Map(), frozenBoxes: new Map(),
    chainOrder: new Map(), previousIds: new Set(), columnCount: 0, inputs: null,
  };
}

/**
 * V1と同じ初期配置・引力による逐次挿入・通常reflow・遅延保持を使う。
 * V2では新着を全て挿入した後に一度だけ空隙を詰め、その最終位置へ直接動かす。
 * 引力はV1のCardメタデータをそのまま使い、縦gap12と未測定高さ120も引き継ぐ。
 * V2の余白と横幅だけを表示変換し、hold中は実表示座標を別Mapで固定する。
 */
export function updateSceneLayout(
  state: SceneLayoutState,
  items: readonly SceneLayoutItem[],
  heights: ReadonlyMap<string, number>,
  viewport: number,
  heldIds: ReadonlySet<string> = EMPTY_IDS,
  currentBoxes: ReadonlyMap<string, SceneBox> = state.boxes,
): SceneLayoutState {
  const uniqueItems = [...new Map(items.map(item => [item.id, item])).values()];
  const cards = cardsFor(uniqueItems);
  const previousIds = new Set(cards.map(card => card.slotId));
  const { width, columnCount } = dimensions(viewport);
  const heightMap = validHeights(heights);
  const rebuild = columnCount !== state.columnCount || state.grid.size === 0;
  const inputs = state.inputs;
  const sameInputs = inputs !== null && columnCount === state.columnCount &&
    uniqueItems.length === inputs.items.length && uniqueItems.every((item, index) =>
      item.id === inputs.items[index].id && item.card === inputs.items[index].card) &&
    heightMap.size === inputs.heights.size && [...heightMap].every(([id, height]) => inputs.heights.get(id) === height) &&
    heldIds.size === inputs.heldIds.size && [...heldIds].every(id => inputs.heldIds.has(id));
  // 再描画やrenderer切替だけで配置や連鎖を作り直さない。
  if (sameInputs && inputs.width === width) return state;
  let grid: Grid;
  let nextChain: ReadonlyMap<string, number>;
  let inserted = false;

  if (sameInputs) {
    // 同じ列数で横幅だけ変わった場合は描画変換のみを更新する。
    grid = state.grid;
    nextChain = state.chainOrder;
  } else if (rebuild) {
    const result = buildInitialLayout(cards, columnCount, heightMap);
    grid = result.grid;
    nextChain = result.chain.chainOrder;
  } else {
    const incoming = cards.filter(card => !state.previousIds.has(card.slotId) && !state.grid.has(card.slotId));
    if (incoming.length) {
      inserted = true;
      grid = state.grid;
      const mergedChain = new Map<string, number>();
      for (const card of incoming) {
        const result = insertCard(grid, card, cards, columnCount, heightMap, heldIds);
        grid = result.grid;
        for (const [id, order] of result.chain.chainOrder) mergedChain.set(id, order);
      }
      nextChain = mergedChain;
    } else {
      const result = reflow(state.grid, cards, columnCount, heightMap);
      grid = result.grid;
      nextChain = result.chain.chainOrder;
    }
  }

  // V1と同じく挿入処理後に削除を反映する。高さ変更だけでは直前の連鎖を消さない。
  const cleanGrid = new Map<string, Placement>();
  for (const [id, placement] of grid) if (previousIds.has(id)) cleanGrid.set(id, { ...placement });
  // 引力が選んだ列・列内順序・連鎖は保持し、途中の押し出し先を表示目標にはしない。
  const finalGrid = inserted ? reflow(cleanGrid, cards, columnCount, heightMap).grid : cleanGrid;
  const chainOrder = new Map(nextChain.size ? nextChain : rebuild ? [] : state.chainOrder);
  return {
    ...projectBoxes(finalGrid, width, heightMap, heldIds, state.frozenBoxes, currentBoxes),
    grid: finalGrid, previousIds, chainOrder, columnCount,
    inputs: { items: uniqueItems.map(item => ({ ...item })), heights: heightMap, heldIds: new Set(heldIds), width },
  };
}

/**
 * Boxのみを保持する既存の純粋関数呼び出し向けの互換入口。
 * 実キャンバスは表示freezeと論理gridを分けるupdateSceneLayoutのstateを保持する。
 */
export function planSceneLayout(
  ids: readonly string[], heights: ReadonlyMap<string, number>, viewport: number,
  previous: ReadonlyMap<string, SceneBox>, heldIds: ReadonlySet<string> = EMPTY_IDS,
  frozenCurrentBoxes: ReadonlyMap<string, SceneBox> = previous, previousColumnCount?: number,
): SceneLayoutState {
  const { columnCount } = dimensions(viewport);
  const grid = new Map<string, Placement>();
  for (const [id, box] of previous) {
    grid.set(id, { col: Math.max(0, Math.round((box.x - MARGIN) / (box.width + COLUMN_GAP))), y: Math.max(0, box.y - MARGIN) });
  }
  const state: SceneLayoutState = {
    ...createSceneLayout(), grid, boxes: new Map(previous), engineBoxes: new Map(previous),
    columnCount: previousColumnCount ?? columnCount, previousIds: new Set(previous.keys()),
  };
  return updateSceneLayout(state, ids.map(id => ({ id })), heights, viewport, heldIds, frozenCurrentBoxes);
}

/** 配置だけを使う呼び出し元のための互換ラッパー。 */
export function layoutScene(
  ids: readonly string[], heights: ReadonlyMap<string, number>, viewport: number,
  previous: ReadonlyMap<string, SceneBox>, held: ReadonlySet<string> = EMPTY_IDS,
): Map<string, SceneBox> {
  return planSceneLayout(ids, heights, viewport, previous, held).boxes;
}
export type CanvasMode = 'modern' | 'legacy' | 'dom';
export interface DrawableContext extends CanvasRenderingContext2D {
  drawElementImage(element: Element, x: number, y: number, width: number, height: number): DOMMatrix | undefined;
}
export interface DrawableCanvas extends HTMLCanvasElement { requestPaint?: () => void }
export function detectCanvasMode(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D | null): CanvasMode {
  if (typeof (canvas as DrawableCanvas).requestPaint !== 'function' || typeof (context as DrawableContext | null)?.drawElementImage !== 'function') return 'dom';
  return 'content' in canvas ? 'modern' : 'legacy';
}
