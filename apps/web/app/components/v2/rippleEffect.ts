import type { SceneBox, SceneInsertionTrace } from './scene';

export interface RippleEffect {
  readonly sourceId: string; readonly depth: number; readonly delayMs: number;
  readonly progress: number; readonly amount: number;
  readonly directionX: number; readonly directionY: number;
}
export interface RippleEffectOptions {
  readonly heldIds?: ReadonlySet<string>; readonly reducedMotion?: boolean;
  readonly directionBoxes?: ReadonlyMap<string, SceneBox>;
}
export const RIPPLE_EFFECT_SWEEP_MS = 700;
export const RIPPLE_EFFECT_STEP_MS = 100;
export const RIPPLE_EFFECT_MAX_DELAY_MS = 600;
export const RIPPLE_EFFECT_DURATION_MS = 1300;
export const RIPPLE_EFFECT_MAX_TRACES = 4;
export const RIPPLE_EFFECT_MAX_EDGES = 96;
export const RIPPLE_EFFECT_MAX_DISPLACEMENT_PX = 6;
/** 波がカードを通る間は強度を保ち、開始・終了の各15%だけ滑らかに消す。 */
export function rippleEffectAmount(progress: number): number {
  if (!Number.isFinite(progress) || progress <= 0 || progress >= 1) return 0;
  const edge = Math.min(1, progress / .15, (1 - progress) / .15);
  return edge * edge * (3 - 2 * edge);
}
function valid(box: SceneBox | undefined): box is SceneBox {
  return !!box && [box.x, box.y, box.width, box.height, box.x + box.width, box.y + box.height].every(Number.isFinite) && box.width > 0 && box.height > 0;
}
function direction(from: SceneBox, to: SceneBox): [number, number] {
  const x = to.x + to.width / 2 - from.x - from.width / 2, y = to.y + to.height / 2 - from.y - from.height / 2;
  const length = Math.hypot(x, y);
  return length > 0 && Number.isFinite(length) ? [x / length, y / length] : [0, 1];
}
/** 実際の因果辺だけを幅優先で辿る。burstを混線させず、新しい根を優先する。 */
export function createRippleEffects(traces: readonly SceneInsertionTrace[], boxes: ReadonlyMap<string, SceneBox>, ageMs: number, options: RippleEffectOptions = {}): ReadonlyMap<string, RippleEffect> {
  const result = new Map<string, RippleEffect>();
  if (options.reducedMotion || !Number.isFinite(ageMs) || ageMs <= 0 || ageMs >= RIPPLE_EFFECT_DURATION_MS) return result;
  const claimed = new Set<string>();
  const boxFor = (id: string) => { const target = options.directionBoxes?.get(id); return valid(target) ? target : boxes.get(id); };
  let inspected = 0;
  for (let i = traces.length - 1; i >= Math.max(0, traces.length - RIPPLE_EFFECT_MAX_TRACES) && inspected < RIPPLE_EFFECT_MAX_EDGES; i--) {
    const trace = traces[i], children = new Map<string, string[]>();
    for (const edge of trace.edges) {
      if (inspected++ >= RIPPLE_EFFECT_MAX_EDGES) break;
      if (edge.fromId === edge.toId || !valid(boxes.get(edge.fromId)) || !valid(boxes.get(edge.toId))) continue;
      children.set(edge.fromId, [...children.get(edge.fromId) ?? [], edge.toId]);
    }
    const root = boxFor(trace.sourceId), first = boxFor(children.get(trace.sourceId)?.[0] ?? '');
    if (!valid(root) || !valid(first)) continue;
    const queue = [{ id: trace.sourceId, depth: 0, direction: direction(root, first) }], visited = new Set([trace.sourceId]);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const step = queue[cursor];
      if (!claimed.has(step.id)) {
        claimed.add(step.id);
        const delayMs = Math.min(RIPPLE_EFFECT_MAX_DELAY_MS, step.depth * RIPPLE_EFFECT_STEP_MS);
        const progress = (ageMs - delayMs) / RIPPLE_EFFECT_SWEEP_MS;
        if (!options.heldIds?.has(step.id) && progress > 0 && progress < 1) result.set(step.id, {
          sourceId: trace.sourceId, depth: step.depth, delayMs, progress,
          amount: rippleEffectAmount(progress), directionX: step.direction[0], directionY: step.direction[1],
        });
      }
      for (const id of children.get(step.id) ?? []) {
        if (visited.has(id)) continue;
        const from = boxFor(step.id), to = boxFor(id);
        if (!valid(from) || !valid(to)) continue;
        visited.add(id); queue.push({ id, depth: step.depth + 1, direction: direction(from, to) });
      }
    }
  }
  return result;
}
