import type { SceneBox } from './scene';

export type SceneMotionPhase = 'waiting' | 'moving' | 'settled' | 'held';
export interface SceneMotionCard {
  box: SceneBox;
  target: SceneBox;
  velocity: { x: number; y: number };
  delayMs: number;
  phase: SceneMotionPhase;
}
export interface SceneMotionState {
  cards: ReadonlyMap<string, SceneMotionCard>;
  active: boolean;
  initialized: boolean;
}
export interface SceneMotionOptions {
  heldIds?: ReadonlySet<string>;
  reducedMotion?: boolean;
}
export interface SceneRetargetOptions extends SceneMotionOptions {
  chainOrder?: ReadonlyMap<string, number>;
  snap?: boolean;
}

// V1と同じ100msの連鎖。200枚でも末尾の開始を長時間待たせない。
export const SCENE_DOMINO_DELAY_MS = 100;
export const SCENE_MAX_DELAY_MS = 600;
export const SCENE_MAX_FRAME_MS = 64;
const STIFFNESS = 300;
const DAMPING = 30;
const POSITION_EPSILON = 0.1;
const VELOCITY_EPSILON = 0.2;

export function createSceneMotion(): SceneMotionState {
  return { cards: new Map(), active: false, initialized: false };
}

function running(card: SceneMotionCard): boolean {
  return card.phase === 'waiting' || card.phase === 'moving';
}

function settled(box: SceneBox, target: SceneBox, velocity: SceneMotionCard['velocity']): boolean {
  return Math.abs(box.x - target.x) <= POSITION_EPSILON && Math.abs(box.y - target.y) <= POSITION_EPSILON &&
    Math.abs(velocity.x) <= VELOCITY_EPSILON && Math.abs(velocity.y) <= VELOCITY_EPSILON;
}

function delayFor(id: string, order?: ReadonlyMap<string, number>): number {
  const step = order?.get(id) ?? 0;
  return Number.isFinite(step) ? Math.min(SCENE_MAX_DELAY_MS, Math.max(0, step * SCENE_DOMINO_DELAY_MS)) : 0;
}

/**
 * レイアウト変更時だけ呼ぶ。表示位置・速度・進行中の遅延を引き継ぎ、
 * 到着の連打や高さ計測によって動きを先頭から再開しない。
 */
export function retargetSceneMotion(
  state: SceneMotionState,
  targets: ReadonlyMap<string, SceneBox>,
  options: SceneRetargetOptions = {},
): SceneMotionState {
  const cards = new Map<string, SceneMotionCard>();
  const snap = options.snap || options.reducedMotion || !state.initialized;
  for (const [id, next] of targets) {
    const target = { ...next };
    const old = state.cards.get(id);
    const held = options.heldIds?.has(id) ?? old?.phase === 'held';
    if (held) {
      cards.set(id, {
        box: old ? { ...old.box, height: target.height } : { ...target }, target,
        velocity: { x: 0, y: 0 }, delayMs: 0, phase: 'held',
      });
      continue;
    }
    if (snap) {
      cards.set(id, { box: { ...target }, target, velocity: { x: 0, y: 0 }, delayMs: 0, phase: 'settled' });
      continue;
    }
    const box = old ? { ...old.box, width: target.width, height: target.height } : {
      ...target, y: target.y - Math.min(480, target.height + 32),
    };
    const velocity = old ? { ...old.velocity } : { x: 0, y: 0 };
    if (settled(box, target, velocity)) {
      cards.set(id, { box: { ...target }, target, velocity: { x: 0, y: 0 }, delayMs: 0, phase: 'settled' });
      continue;
    }
    const delayMs = old && running(old) ? old.delayMs : old?.phase === 'held' ? 0 : delayFor(id, options.chainOrder);
    cards.set(id, { box, target, velocity, delayMs, phase: delayMs > 0 ? 'waiting' : 'moving' });
  }
  return { cards, active: [...cards.values()].some(running), initialized: state.initialized || cards.size > 0 };
}

/** V1のstiffness=300、damping=30を時間差で厳密積分する減衰ばね。 */
function spring(position: number, velocity: number, target: number, seconds: number): [number, number] {
  const decay = DAMPING / 2;
  const frequency = Math.sqrt(STIFFNESS - decay * decay);
  const offset = position - target;
  const exponential = Math.exp(-decay * seconds);
  const sine = Math.sin(frequency * seconds);
  const cosine = Math.cos(frequency * seconds);
  return [
    target + exponential * (offset * cosine + (velocity + decay * offset) / frequency * sine),
    exponential * (velocity * cosine - (decay * velocity + STIFFNESS * offset) / frequency * sine),
  ];
}

/** rAFごとの差分msで進める。休止タブの巨大dtは制限し、カメラ座標は受け取らない。 */
export function advanceSceneMotion(
  state: SceneMotionState,
  elapsedMs: number,
  options: SceneMotionOptions = {},
): SceneMotionState {
  const frameMs = Number.isFinite(elapsedMs) ? Math.max(0, Math.min(SCENE_MAX_FRAME_MS, elapsedMs)) : 0;
  const cards = new Map<string, SceneMotionCard>();
  for (const [id, old] of state.cards) {
    const held = options.heldIds?.has(id) ?? old.phase === 'held';
    if (held) {
      cards.set(id, old.phase === 'held' ? old : { ...old, velocity: { x: 0, y: 0 }, delayMs: 0, phase: 'held' });
      continue;
    }
    if (options.reducedMotion) {
      cards.set(id, { ...old, box: { ...old.target }, velocity: { x: 0, y: 0 }, delayMs: 0, phase: 'settled' });
      continue;
    }
    if (old.phase === 'settled') { cards.set(id, old); continue; }
    const delayMs = Math.max(0, old.delayMs - frameMs);
    const activeMs = Math.max(0, frameMs - old.delayMs);
    if (delayMs > 0) {
      cards.set(id, { ...old, delayMs, phase: 'waiting' });
      continue;
    }
    const [x, vx] = spring(old.box.x, old.velocity.x, old.target.x, activeMs / 1000);
    const [y, vy] = spring(old.box.y, old.velocity.y, old.target.y, activeMs / 1000);
    const box = { ...old.target, x, y };
    const velocity = { x: vx, y: vy };
    if (settled(box, old.target, velocity)) {
      cards.set(id, { ...old, box: { ...old.target }, velocity: { x: 0, y: 0 }, delayMs: 0, phase: 'settled' });
    } else cards.set(id, { ...old, box, velocity, delayMs: 0, phase: 'moving' });
  }
  return { ...state, cards, active: [...cards.values()].some(running) };
}

/** DOMとnative描画が共有する実表示Box。呼び出し元からstateを変更できない。 */
export function sceneMotionBoxes(state: SceneMotionState): Map<string, SceneBox> {
  return new Map([...state.cards].map(([id, card]) => [id, { ...card.box }]));
}
