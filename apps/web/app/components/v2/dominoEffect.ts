import type { SceneBox, SceneInsertionTrace } from './scene';

export interface DominoMatrix {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export interface DominoTransform extends DominoMatrix {
  readonly sourceId: string;
  readonly depth: number;
  readonly delayMs: number;
  readonly amount: number;
  /** 非drawableの内側の面へ適用する透視投影。外側の配置座標とは分離する。 */
  readonly perspective: DominoPerspective;
}

export type DominoPivotEdge = 'top' | 'right' | 'bottom' | 'left';

export interface DominoProjectedPoint {
  readonly x: number;
  readonly y: number;
  /** 遠近除算前の奥行き。負の値は画面の奥側。 */
  readonly z: number;
  readonly w: number;
}

export interface DominoShade {
  /** 面の内側の装飾専用レイヤーへ適用し、入力イベントは受け取らせない。 */
  readonly faceGradient: string;
  readonly faceOpacity: number;
  /** 変形しない外側の矩形内に敷く影。面の裏に置き、paddingや外側の描画領域を増やさない。 */
  readonly footprintGradient: string;
  readonly footprintOpacity: number;
  /** 変形する面の内側へ置くinsetだけの明暗。外側へ影をはみ出させない。 */
  readonly edgeShadow: string;
}

export interface DominoPerspective {
  readonly cssTransform: string;
  readonly transformOrigin: string;
  readonly axis: 'x' | 'y';
  readonly edge: DominoPivotEdge;
  readonly angleDeg: number;
  readonly perspectivePx: number;
  readonly pivotX: number;
  readonly pivotY: number;
  /** カード内座標で左上・右上・右下・左下の順。 */
  readonly corners: readonly [DominoProjectedPoint, DominoProjectedPoint, DominoProjectedPoint, DominoProjectedPoint];
  readonly shade: DominoShade;
}

export interface DominoEffectOptions {
  readonly heldIds?: ReadonlySet<string>;
  readonly reducedMotion?: boolean;
  /** 目標座標を渡すと、移動中に親子が交差しても傾く向きが反転しない。 */
  readonly directionBoxes?: ReadonlyMap<string, SceneBox>;
}

export const DOMINO_EFFECT_STEP_MS = 100;
export const DOMINO_EFFECT_MAX_DELAY_MS = 600;
export const DOMINO_EFFECT_PULSE_MS = 700;
export const DOMINO_EFFECT_DURATION_MS = DOMINO_EFFECT_MAX_DELAY_MS + DOMINO_EFFECT_PULSE_MS;
export const DOMINO_EFFECT_MAX_TRACES = 4;
export const DOMINO_EFFECT_MAX_EDGES = 96;
export const DOMINO_EFFECT_MAX_CARDS = DOMINO_EFFECT_MAX_EDGES + DOMINO_EFFECT_MAX_TRACES;
export const DOMINO_PERSPECTIVE_MAX_ANGLE_DEG = 52;
export const DOMINO_PERSPECTIVE_DISTANCE_RATIO = 1.5;

interface Direction { x: number; y: number }
interface DominoStep {
  sourceId: string;
  depth: number;
  direction: Direction;
}

function validBox(box: SceneBox | undefined): box is SceneBox {
  return box !== undefined && Number.isFinite(box.x) && Number.isFinite(box.y) &&
    Number.isFinite(box.width) && Number.isFinite(box.height) && box.width > 0 && box.height > 0 &&
    Number.isFinite(box.x + box.width) && Number.isFinite(box.y + box.height);
}

/** カードのローカル座標からワールド座標への、変形なしの平行移動。 */
export function dominoIdentity(box: SceneBox): DominoMatrix {
  return { a: 1, b: 0, c: 0, d: 1, e: box.x, f: box.y };
}

function directionBetween(from: SceneBox, to: SceneBox): Direction {
  const dx = (to.x + to.width / 2) - (from.x + from.width / 2);
  const dy = (to.y + to.height / 2) - (from.y + from.height / 2);
  const distance = Math.hypot(dx, dy);
  // 重なる中心や極端な入力でも、有限な下方向へ倒す。
  return distance > 0 && Number.isFinite(distance) ? { x: dx / distance, y: dy / distance } : { x: 0, y: 1 };
}

function smoothstep(value: number): number {
  return value * value * (3 - 2 * value);
}

/** 速く倒れ、ゆっくり起き上がる一回限りのパルス。裏返りや負の反動を作らない。 */
export function dominoEffectAmount(ageMs: number): number {
  if (!Number.isFinite(ageMs) || ageMs <= 0 || ageMs >= DOMINO_EFFECT_PULSE_MS) return 0;
  const progress = ageMs / DOMINO_EFFECT_PULSE_MS;
  const impact = 0.28;
  return progress <= impact ? smoothstep(progress / impact) : 1 - smoothstep((progress - impact) / (1 - impact));
}

function matrixFor(box: SceneBox, direction: Direction, amount: number): DominoMatrix | null {
  // 下辺中央を支点に、縦の短縮・横のせん断・画面内の回転だけで立体感を出す。
  // 旧アフィン版との比較用の計算。現在の表示では内側のperspectiveを使用する。
  const tilt = amount * (0.73 + 0.23 * Math.abs(direction.y));
  const compression = Math.cos(tilt) - direction.y * Math.sin(tilt) * 0.1;
  const shear = -direction.x * Math.sin(tilt) * 0.2;
  const rotation = direction.x * amount * 0.18;
  const sine = Math.sin(rotation);
  const cosine = Math.cos(rotation);
  const a = cosine;
  const b = sine;
  const c = (cosine * shear - sine * compression) || 0;
  const d = sine * shear + cosine * compression;
  const pivotX = box.width / 2;
  const pivotY = box.height;
  const e = box.x + pivotX * (1 - a) - pivotY * c;
  const f = box.y - pivotX * b + pivotY * (1 - d);
  return [a, b, c, d, e, f].every(Number.isFinite) ? { a, b, c, d, e, f } : null;
}

function perspectiveFor(box: SceneBox, direction: Direction, amount: number): DominoPerspective {
  // 支点は押される方向の辺。反対の辺を奥へ倒すことで、投影は元の矩形内に収まる。
  const horizontal = Math.abs(direction.x) > Math.abs(direction.y);
  const axis = horizontal ? 'y' : 'x';
  const edge: DominoPivotEdge = horizontal ? direction.x > 0 ? 'right' : 'left' : direction.y < 0 ? 'top' : 'bottom';
  const pivotX = edge === 'left' ? 0 : edge === 'right' ? box.width : box.width / 2;
  const pivotY = edge === 'top' ? 0 : edge === 'bottom' ? box.height : box.height / 2;
  const sign = edge === 'top' || edge === 'right' ? -1 : 1;
  const angleDeg = sign * DOMINO_PERSPECTIVE_MAX_ANGLE_DEG * amount;
  const radians = angleDeg * Math.PI / 180;
  const sine = Math.sin(radians);
  const cosine = Math.cos(radians);
  // 回転する軸に直交する辺の長さを基準にし、カード寸法による見え方の差を抑える。
  const dimension = horizontal ? box.width : box.height;
  const distance = Math.max(1, dimension) * DOMINO_PERSPECTIVE_DISTANCE_RATIO;
  // 最大値を割ってから掛ける方式も丸め誤差でoverflowするため、積を検査する。
  const perspectivePx = Number.isFinite(distance) ? distance : Number.MAX_VALUE;
  const project = (x: number, y: number): DominoProjectedPoint => {
    const localX = x - pivotX;
    const localY = y - pivotY;
    const z = horizontal ? -sine * localX : sine * localY;
    const w = 1 - z / perspectivePx;
    return {
      x: pivotX + (horizontal ? cosine * localX : localX) / w,
      y: pivotY + (horizontal ? localY : cosine * localY) / w,
      z: z || 0,
      w,
    };
  };
  const dark = (0.26 * amount).toFixed(6);
  const light = (0.2 * amount).toFixed(6);
  const edgeOffsets = {
    top: ['0 2px', '0 -1px'], right: ['-2px 0', '1px 0'],
    bottom: ['0 -2px', '0 1px'], left: ['2px 0', '-1px 0'],
  }[edge];
  return {
    cssTransform: `perspective(${perspectivePx}px) rotate${horizontal ? 'Y' : 'X'}(${angleDeg}deg)`,
    transformOrigin: `${pivotX}px ${pivotY}px`,
    axis, edge, angleDeg, perspectivePx, pivotX, pivotY,
    corners: [project(0, 0), project(box.width, 0), project(box.width, box.height), project(0, box.height)],
    shade: {
      faceGradient: `linear-gradient(to ${edge}, rgba(15,23,42,0.48), rgba(15,23,42,0.06))`,
      faceOpacity: amount * 0.3,
      footprintGradient: `linear-gradient(to ${edge}, rgba(15,23,42,0.08), rgba(15,23,42,0.7))`,
      footprintOpacity: amount * 0.22,
      edgeShadow: `inset ${edgeOffsets[0]} 0 rgba(15,23,42,${dark}), inset ${edgeOffsets[1]} 0 rgba(255,255,255,${light})`,
    },
  };
}

/**
 * 実際の押出辺を根からたどり、カードごとの因果的な傾きを返す。
 * 各matrixはローカル(0,0)からワールド座標への変換。MapにないカードはdominoIdentity。
 * 表示Boxやばねを変更せず、hold/focus・reduced-motion・寿命外は常に変形なしになる。
 * 新しい根を優先し、同じカードへのburstを加算しない。根の間に辺を補わない。
 */
export function createDominoTransforms(
  traces: readonly SceneInsertionTrace[],
  boxes: ReadonlyMap<string, SceneBox>,
  ageMs: number,
  options: DominoEffectOptions = {},
): ReadonlyMap<string, DominoTransform> {
  const transforms = new Map<string, DominoTransform>();
  if (options.reducedMotion || !Number.isFinite(ageMs) || ageMs <= 0 || ageMs >= DOMINO_EFFECT_DURATION_MS) return transforms;

  const steps = new Map<string, DominoStep>();
  const firstTrace = Math.max(0, traces.length - DOMINO_EFFECT_MAX_TRACES);
  let inspected = 0;
  const directionBox = (id: string): SceneBox | undefined => {
    const target = options.directionBoxes?.get(id);
    return validBox(target) ? target : boxes.get(id);
  };

  for (let index = traces.length - 1; index >= firstTrace && inspected < DOMINO_EFFECT_MAX_EDGES; index--) {
    const trace = traces[index];
    const children = new Map<string, string[]>();
    for (const edge of trace.edges) {
      if (inspected >= DOMINO_EFFECT_MAX_EDGES) break;
      inspected++;
      if (edge.fromId === edge.toId || !validBox(boxes.get(edge.fromId)) || !validBox(boxes.get(edge.toId))) continue;
      const ids = children.get(edge.fromId);
      if (ids) ids.push(edge.toId);
      else children.set(edge.fromId, [edge.toId]);
    }
    const source = directionBox(trace.sourceId);
    const firstChildId = children.get(trace.sourceId)?.[0];
    const firstChild = firstChildId === undefined ? undefined : directionBox(firstChildId);
    if (!validBox(source) || !validBox(firstChild)) continue;

    // 幅優先で深さを決めるので、辺の配列順・分岐・循環で連鎖順を壊さない。
    const queue = [{ id: trace.sourceId, depth: 0, direction: directionBetween(source, firstChild) }];
    const visited = new Set([trace.sourceId]);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const node = queue[cursor];
      if (!steps.has(node.id)) steps.set(node.id, { sourceId: trace.sourceId, depth: node.depth, direction: node.direction });
      for (const childId of children.get(node.id) ?? []) {
        if (visited.has(childId)) continue;
        const from = directionBox(node.id);
        const to = directionBox(childId);
        if (!validBox(from) || !validBox(to)) continue;
        visited.add(childId);
        queue.push({ id: childId, depth: node.depth + 1, direction: directionBetween(from, to) });
      }
    }
  }

  for (const [id, step] of steps) {
    if (options.heldIds?.has(id)) continue;
    const box = boxes.get(id);
    if (!validBox(box)) continue;
    const delayMs = Math.min(DOMINO_EFFECT_MAX_DELAY_MS, step.depth * DOMINO_EFFECT_STEP_MS);
    const amount = dominoEffectAmount(ageMs - delayMs);
    if (amount === 0) continue;
    const matrix = matrixFor(box, step.direction, amount);
    if (matrix) transforms.set(id, {
      ...matrix, sourceId: step.sourceId, depth: step.depth, delayMs, amount,
      perspective: perspectiveFor(box, step.direction, amount),
    });
  }
  return transforms;
}
