import { describe, expect, it } from 'vitest';
import { planSceneLayout, type SceneBox } from '../scene';
import {
  advanceSceneMotion, createSceneMotion, retargetSceneMotion, sceneMotionBoxes,
  SCENE_MAX_DELAY_MS, SCENE_MAX_FRAME_MS, type SceneMotionState,
} from '../sceneMotion';

const box = (y: number, x = 16): SceneBox => ({ x, y, width: 360, height: 180 });
const initialTargets = new Map([['a', box(16)], ['b', box(212)], ['c', box(408)]]);

function initial(): SceneMotionState {
  return retargetSceneMotion(createSceneMotion(), initialTargets);
}

function inserted(): SceneMotionState {
  const layout = planSceneLayout(['new', 'a', 'b', 'c'], new Map(), 400, initialTargets);
  return retargetSceneMotion(initial(), layout.boxes, { chainOrder: layout.chainOrder });
}

function run(state: SceneMotionState, ms: number, frameMs = 16): SceneMotionState {
  for (let remaining = ms; remaining > 0; remaining -= frameMs) state = advanceSceneMotion(state, Math.min(frameMs, remaining));
  return state;
}

describe('V2の決定的なドミノモーション', () => {
  it('空の初期描画を経て初めて届くfeedは全件即時配置する', () => {
    const empty = retargetSceneMotion(createSceneMotion(), new Map());
    const state = retargetSceneMotion(empty, initialTargets);
    expect(state.initialized).toBe(true);
    expect(state.active).toBe(false);
    expect(sceneMotionBoxes(state)).toEqual(initialTargets);
    for (const card of state.cards.values()) expect(card.phase).toBe('settled');
  });

  it('新着は上から入り、直下から100msごとにドミノが動き始める', () => {
    let state = inserted();
    expect(state.cards.get('new')!.box.y).toBeLessThan(0);
    expect(state.cards.get('a')!.delayMs).toBe(100);
    expect(state.cards.get('b')!.delayMs).toBe(200);
    expect(state.cards.get('c')!.delayMs).toBe(300);
    state = run(state, 80);
    expect(state.cards.get('new')!.box.y).toBeGreaterThan(inserted().cards.get('new')!.box.y);
    expect(state.cards.get('a')!.box.y).toBe(16);
    expect(state.cards.get('a')!.phase).toBe('waiting');
    state = run(state, 40);
    expect(state.cards.get('a')!.box.y).toBeGreaterThan(16);
    expect(state.cards.get('b')!.box.y).toBe(212);
    state = run(state, 100);
    expect(state.cards.get('b')!.box.y).toBeGreaterThan(212);
    expect(state.cards.get('c')!.box.y).toBe(408);
  });

  it('高さ測定や同じ目標の更新で待機時間を最初からやり直さない', () => {
    const before = run(inserted(), 64);
    const targets = new Map([...before.cards].map(([id, card]) => [id, { ...card.target, height: 190 }]));
    const next = retargetSceneMotion(before, targets, { chainOrder: new Map([['a', 8], ['b', 8]]) });
    expect(next.cards.get('a')!.delayMs).toBe(36);
    expect(next.cards.get('b')!.delayMs).toBe(136);
    expect(next.cards.get('new')!.box.y).toBe(before.cards.get('new')!.box.y);
    expect(next.cards.get('new')!.velocity).toEqual(before.cards.get('new')!.velocity);
    expect(next.cards.get('new')!.box.height).toBe(190);
  });

  it('新着の連打でも現在座標と速度を引き継ぎ、進行中の連鎖は止めない', () => {
    const before = run(inserted(), 160);
    const targets = new Map([...before.cards].map(([id, card]) => [id, card.target]));
    const layout = planSceneLayout(['new2', 'new', 'a', 'b', 'c'], new Map(), 400, targets);
    const next = retargetSceneMotion(before, layout.boxes, { chainOrder: layout.chainOrder });
    expect(next.cards.get('a')!.box).toEqual(before.cards.get('a')!.box);
    expect(next.cards.get('a')!.velocity).toEqual(before.cards.get('a')!.velocity);
    expect(next.cards.get('a')!.delayMs).toBe(0);
    expect(next.cards.get('b')!.delayMs).toBe(before.cards.get('b')!.delayMs);
    expect(next.cards.get('a')!.target.y).toBeGreaterThan(before.cards.get('a')!.target.y);
    expect(advanceSceneMotion(next, 16).cards.get('a')!.box.y).toBeGreaterThan(next.cards.get('a')!.box.y);
  });

  it('同じslotの内容差替えは新規挿入として扱わない', () => {
    const before = initial();
    const after = retargetSceneMotion(before, new Map(initialTargets));
    expect(after.active).toBe(false);
    expect(after.cards.get('a')!.box).toEqual(before.cards.get('a')!.box);
    expect(after.cards.get('a')!.phase).toBe('settled');
  });

  it('holdはアニメーション途中の実表示座標と幅を固定する', () => {
    const before = run(inserted(), 180);
    const heldIds = new Set(['a']);
    const targets = new Map([...before.cards].map(([id, card]) => [id, { ...card.target, width: 280, height: 200 }]));
    const held = retargetSceneMotion(before, targets, { heldIds });
    expect(held.cards.get('a')!.box).toEqual({ ...before.cards.get('a')!.box, height: 200 });
    expect(held.cards.get('a')!.box.y).not.toBe(held.cards.get('a')!.target.y);
    expect(held.cards.get('a')!.velocity).toEqual({ x: 0, y: 0 });
    expect(run(held, 1000).cards.get('a')!.box).toEqual(held.cards.get('a')!.box);
    const released = retargetSceneMotion(held, targets, { heldIds: new Set() });
    expect(released.cards.get('a')!.box.y).toBe(held.cards.get('a')!.box.y);
    expect(released.cards.get('a')!.box.width).toBe(280);
    expect(released.cards.get('a')!.delayMs).toBe(0);
    expect(released.cards.get('a')!.phase).toBe('moving');
    expect(run(released, 2000).cards.get('a')!.box).toEqual(targets.get('a'));
  });

  it('tick直前のfocusでも現在座標を固定し、解除後に追従する', () => {
    const before = run(inserted(), 180);
    const held = advanceSceneMotion(before, 16, { heldIds: new Set(['a']) });
    expect(held.cards.get('a')!.box).toEqual(before.cards.get('a')!.box);
    expect(held.cards.get('a')!.phase).toBe('held');
    const released = advanceSceneMotion(held, 16, { heldIds: new Set() });
    expect(released.cards.get('a')!.box.y).toBeGreaterThan(held.cards.get('a')!.box.y);
  });

  it('reduced-motionでは遅延も新着の落下もせず目標へ即時配置する', () => {
    const before = inserted();
    const reduced = advanceSceneMotion(before, 16, { reducedMotion: true });
    expect(reduced.active).toBe(false);
    for (const card of reduced.cards.values()) {
      expect(card.box).toEqual(card.target);
      expect(card.delayMs).toBe(0);
      expect(card.phase).toBe('settled');
    }
    const targets = new Map([...initialTargets, ['new', box(604)]]);
    const retargeted = retargetSceneMotion(initial(), targets, { reducedMotion: true, chainOrder: new Map([['new', 3]]) });
    expect(retargeted.active).toBe(false);
    expect(retargeted.cards.get('new')!.box).toEqual(targets.get('new'));
  });

  it('reduced-motionへ変更してもhold座標を動かさない', () => {
    const before = run(inserted(), 180);
    const reduced = advanceSceneMotion(before, 16, { heldIds: new Set(['a']), reducedMotion: true });
    expect(reduced.cards.get('a')!.box).toEqual(before.cards.get('a')!.box);
    expect(reduced.cards.get('a')!.phase).toBe('held');
    expect(reduced.active).toBe(false);
  });

  it('200枚の連鎖でも遅延は600msまでで、全件が有限時間で収束する', () => {
    const ids = Array.from({ length: 199 }, (_, index) => String(index));
    const first = planSceneLayout(ids, new Map(), 400, new Map());
    const layout = planSceneLayout(['new', ...ids], new Map(), 400, first.boxes);
    const state = retargetSceneMotion(retargetSceneMotion(createSceneMotion(), first.boxes), layout.boxes, { chainOrder: layout.chainOrder });
    expect(state.cards.size).toBe(200);
    expect(Math.max(...[...state.cards.values()].map(card => card.delayMs))).toBe(SCENE_MAX_DELAY_MS);
    const finished = run(state, 3000);
    expect(finished.active).toBe(false);
    for (const card of finished.cards.values()) expect(card.box).toEqual(card.target);
  });

  it('ばねはelapsed-timeで計算し、フレーム分割に依存しない', () => {
    const start = inserted();
    const frequent = run(start, 240, 8);
    const lessFrequent = run(start, 240, 24);
    for (const [id, card] of frequent.cards) {
      expect(card.box.y).toBeCloseTo(lessFrequent.cards.get(id)!.box.y, 8);
      expect(card.velocity.y).toBeCloseTo(lessFrequent.cards.get(id)!.velocity.y, 8);
    }
  });

  it('休止タブから復帰した巨大dtを制限し、無効なdtで逆走しない', () => {
    const start = inserted();
    expect(advanceSceneMotion(start, 60000)).toEqual(advanceSceneMotion(start, SCENE_MAX_FRAME_MS));
    expect(advanceSceneMotion(start, -10)).toEqual(start);
    expect(advanceSceneMotion(start, NaN)).toEqual(start);
    expect(advanceSceneMotion(start, Infinity)).toEqual(start);
  });

  it('削除と再配置の入力を変更せず、削除されたモーションを残さない', () => {
    const before = run(inserted(), 160);
    const oldBox = { ...before.cards.get('a')!.box };
    const targets = new Map([['a', Object.freeze(box(16))]]);
    const next = retargetSceneMotion(before, targets);
    const extracted = sceneMotionBoxes(next);
    extracted.get('a')!.y = 999;
    expect(next.cards.size).toBe(1);
    expect(next.cards.get('a')!.box).toEqual(oldBox);
    expect(before.cards.size).toBe(4);
    expect(before.cards.get('a')!.box).toEqual(oldBox);
    expect(targets.get('a')!.y).toBe(16);
  });

  it('再描画のため同じtargetを渡してもモーションのワールド座標を変えない', () => {
    const state = run(inserted(), 160);
    const snapshot = sceneMotionBoxes(state);
    expect(sceneMotionBoxes(state)).toEqual(snapshot);
    const target = new Map([...state.cards].map(([id, card]) => [id, card.target]));
    expect(sceneMotionBoxes(retargetSceneMotion(state, target))).toEqual(snapshot);
  });
});
