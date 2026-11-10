/** V2の配置とモーションはカメラから独立したCSS pxのワールド座標で扱う。 */
export interface SceneBox { x: number; y: number; width: number; height: number }
export interface Camera { x: 0; y: number; zoom: 1 }
export interface SceneLayoutResult {
  boxes: Map<string, SceneBox>;
  chainOrder: Map<string, number>;
  columnCount: number;
}

const MARGIN = 16;
const GAP = 16;
const DEFAULT_HEIGHT = 180;
const EMPTY_IDS: ReadonlySet<string> = new Set();

function heightFor(id: string, heights: ReadonlyMap<string, number>, previous?: SceneBox): number {
  const height = heights.get(id) ?? previous?.height ?? DEFAULT_HEIGHT;
  return Number.isFinite(height) ? Math.max(1, height) : DEFAULT_HEIGHT;
}

/** holdを障害物として下へ迂回する。yが増えるだけなので必ず終了する。 */
function belowHeld(box: SceneBox, held: readonly SceneBox[]): number {
  let y = box.y;
  for (const obstacle of held) {
    if (box.x < obstacle.x + obstacle.width && box.x + box.width > obstacle.x &&
        y < obstacle.y + obstacle.height + GAP && y + box.height + GAP > obstacle.y) {
      y = obstacle.y + obstacle.height + GAP;
    }
  }
  return y;
}

/**
 * 新着を列の先頭へ差し込み、同じ列の後続だけを押し下げる。
 * 既存のスコア更新では列と列内順序を変えず、列数変更時だけ入力順に配り直す。
 * previousは目標座標、frozenCurrentBoxesはholdを開始した時点の実表示座標。
 */
export function planSceneLayout(
  ids: readonly string[],
  heights: ReadonlyMap<string, number>,
  viewport: number,
  previous: ReadonlyMap<string, SceneBox>,
  heldIds: ReadonlySet<string> = EMPTY_IDS,
  frozenCurrentBoxes: ReadonlyMap<string, SceneBox> = previous,
  previousColumnCount?: number,
): SceneLayoutResult {
  const viewportWidth = Number.isFinite(viewport) ? Math.max(1, viewport) : 400;
  const width = Math.max(160, Math.min(360, viewportWidth - MARGIN * 2));
  const columnCount = Math.max(1, Math.floor((viewportWidth - MARGIN) / (width + GAP)));
  const boxes = new Map<string, SceneBox>();
  const chainOrder = new Map<string, number>();
  const uniqueIds = [...new Set(ids)];
  const present = new Set(uniqueIds);
  const oldEntries = [...previous].filter(([id]) => present.has(id));
  const resized = previousColumnCount !== undefined && previousColumnCount !== columnCount ||
    oldEntries.some(([id, box]) => !heldIds.has(id) &&
      (box.width !== width || box.x < MARGIN || box.x >= MARGIN + columnCount * (width + GAP)));
  const initial = previous.size === 0 || resized;
  const queues: string[][] = Array.from({ length: columnCount }, () => []);
  const incoming: string[][] = Array.from({ length: columnCount }, () => []);
  const weights = Array.from({ length: columnCount }, () => MARGIN);

  for (const id of uniqueIds) {
    if (!heldIds.has(id)) continue;
    const frozen = frozenCurrentBoxes.get(id) ?? previous.get(id);
    if (frozen) boxes.set(id, { ...frozen, height: heightFor(id, heights, frozen) });
  }
  const obstacles = [...boxes.values()].sort((a, b) => a.y - b.y);
  for (let col = 0; col < columnCount; col++) {
    const x = MARGIN + col * (width + GAP);
    for (const obstacle of obstacles) {
      if (x < obstacle.x + obstacle.width && x + width > obstacle.x) {
        weights[col] = Math.max(weights[col], obstacle.y + obstacle.height + GAP);
      }
    }
  }

  const shortestColumn = (id: string, insertAtTop: boolean): number => {
    const height = heightFor(id, heights, previous.get(id));
    let best = 0;
    let bestTop = Infinity;
    let bestWeight = Infinity;
    for (let col = 0; col < columnCount; col++) {
      const x = MARGIN + col * (width + GAP);
      const top = insertAtTop ? belowHeld({ x, y: MARGIN, width, height }, obstacles) : MARGIN;
      if (top < bestTop || top === bestTop && weights[col] < bestWeight) {
        best = col;
        bestTop = top;
        bestWeight = weights[col];
      }
    }
    return best;
  };

  if (initial) {
    for (const id of uniqueIds) {
      if (boxes.has(id)) continue;
      const col = shortestColumn(id, false);
      queues[col].push(id);
      weights[col] += heightFor(id, heights, previous.get(id)) + GAP;
    }
  } else {
    // 前回の目標yで並べる。アニメーション途中のyや現在のスコアは使わない。
    for (const [id, old] of oldEntries.sort((a, b) => a[1].y - b[1].y || a[1].x - b[1].x)) {
      if (boxes.has(id)) continue;
      const col = Math.max(0, Math.min(columnCount - 1, Math.round((old.x - MARGIN) / (width + GAP))));
      queues[col].push(id);
      weights[col] += heightFor(id, heights, old) + GAP;
    }
    for (const id of uniqueIds) {
      if (previous.has(id) || boxes.has(id)) continue;
      const col = shortestColumn(id, true);
      incoming[col].push(id);
      weights[col] += heightFor(id, heights) + GAP;
    }
  }

  for (let col = 0; col < columnCount; col++) {
    let y = MARGIN;
    let chain = 0;
    const hasInsertion = incoming[col].length > 0;
    for (const id of [...incoming[col], ...queues[col]]) {
      const old = previous.get(id);
      const box = { x: MARGIN + col * (width + GAP), y, width, height: heightFor(id, heights, old) };
      box.y = belowHeld(box, obstacles);
      boxes.set(id, box);
      y = box.y + box.height + GAP;
      // 無関係な列・動かないカードには待機時間を付けない。
      if (hasInsertion && (!old || box.y > old.y || box.x !== old.x)) chainOrder.set(id, chain++);
    }
  }
  return { boxes, chainOrder, columnCount };
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
