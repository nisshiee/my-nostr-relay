import { describe, expect, it, vi } from 'vitest';
import {
  createPushPaths, drawPushPaths, pushEffectOpacity,
  PUSH_EFFECT_DURATION_MS, PUSH_EFFECT_FADE_IN_MS, PUSH_EFFECT_MAX_EDGES,
  PUSH_EFFECT_MAX_TRACES, PUSH_EFFECT_STYLE,
  type PushEffectBox, type PushEffectContext, type PushEffectTrace,
} from '../pushEffect';

const box = (x: number, y: number, height = 120): PushEffectBox => ({ x, y, width: 360, height });
const trace = (sourceId: string, pairs: readonly [string, string][]): PushEffectTrace => ({
  sourceId, edges: pairs.map(([fromId, toId]) => ({ fromId, toId })),
});

function fakeContext() {
  const initial = {
    strokeStyle: 'red', globalAlpha: 0.5, lineWidth: 7,
    lineCap: 'butt' as CanvasLineCap, lineJoin: 'miter' as CanvasLineJoin,
    shadowBlur: 8, shadowColor: 'purple', filter: 'blur(3px)',
  };
  const strokeStates: typeof initial[] = [];
  const writes: [PropertyKey, unknown][] = [];
  const currentState = () => Object.fromEntries(Object.keys(initial).map(key => [key, target[key as keyof typeof initial]]));
  let saved: Record<string, unknown> = {};
  const target = {
    ...initial,
    save: vi.fn(() => { saved = currentState(); }),
    restore: vi.fn(() => { Object.assign(target, saved); }),
    beginPath: vi.fn(), moveTo: vi.fn(), bezierCurveTo: vi.fn(),
    stroke: vi.fn(() => { strokeStates.push(currentState() as typeof initial); }),
  };
  const ctx = new Proxy(target, {
    set(object, property, value) {
      writes.push([property, value]);
      return Reflect.set(object, property, value);
    },
  });
  return { ctx, initial, strokeStates, writes };
}

describe('因果線の視認性', () => {
  it('nativeとSVG共通の濃色・線幅を固定し、blurなしの短い効果を維持する', () => {
    expect(PUSH_EFFECT_STYLE).toEqual({color:'#0284c7', mainWidth:2, mainAlpha:0.6, haloWidth:4.5, haloAlpha:0.14});
    expect(PUSH_EFFECT_DURATION_MS).toBe(1400);
  });
});

describe('V2の押出因果パス', () => {
  it('分岐と独立した根を実際の親子辺だけで描き、順序から接続を補わない', () => {
    const boxes = new Map([
      ['a', box(16, 0)], ['b', box(16, 132)], ['c', box(392, 132)],
      ['d', box(768, 0)], ['e', box(768, 132)],
    ]);
    const paths = createPushPaths([
      trace('a', [['a', 'b'], ['a', 'c']]), trace('d', [['d', 'e']]),
    ], boxes);
    expect(paths.map(path => [path.sourceId, path.fromId, path.toId])).toEqual([
      ['d', 'd', 'e'], ['a', 'a', 'b'], ['a', 'a', 'c'],
    ]);
    expect(paths.every(path => !path.d.includes('L'))).toBe(true);
    expect(paths.every(path => path.d.match(/M /g)?.length === 1)).toBe(true);
  });

  it('同じ列は左の余白を通り、小さいカードも上側24px以内へ接続する', () => {
    const [path] = createPushPaths([trace('a', [['a', 'b']])], new Map([
      ['a', box(16, 10, 30)], ['b', box(16, 170)],
    ]));
    expect([path.startX, path.startY, path.endX, path.endY]).toEqual([10, 25, 10, 194]);
    expect(path.control1X).toBeLessThan(10);
    expect(path.control2X).toBeLessThan(10);
    expect(path.control1X).toBeGreaterThanOrEqual(2);
    expect(path.control2X).toBeGreaterThanOrEqual(2);
    expect(path.control1Y).toBeGreaterThan(path.startY);
    expect(path.control2Y).toBeLessThan(path.endY);
  });

  it('右方向も左方向も相手を向くカード側面へつなぐ', () => {
    const boxes = new Map([['a', box(16, 20)], ['b', box(392, 160)]]);
    const [right] = createPushPaths([trace('a', [['a', 'b']])], boxes);
    const [left] = createPushPaths([trace('b', [['b', 'a']])], boxes);
    expect([right.startX, right.startY, right.endX, right.endY]).toEqual([382, 44, 386, 184]);
    expect(right.control1X).toBeGreaterThan(right.startX);
    expect(right.control2X).toBeLessThan(right.endX);
    expect([left.startX, left.startY, left.endX, left.endY]).toEqual([386, 184, 382, 44]);
    expect(left.control1X).toBeLessThan(left.startX);
    expect(left.control2X).toBeGreaterThan(left.endX);
  });

  it('横移動の開始や左右反転でアンカーを跳ばさず、半幅離れたら側面へ接続する', () => {
    const traces = [trace('a', [['a', 'b']])];
    const pathAt = (offset: number) => createPushPaths(traces, new Map([
      ['a', box(16, 0)], ['b', box(16 + offset, 132)],
    ]))[0];
    const middle = pathAt(0);
    for (const offset of [-1.01, -0.99, -0.001, 0.001, 0.99, 1.01]) {
      const path = pathAt(offset);
      for (const key of ['startX', 'endX', 'control1X', 'control2X'] as const) {
        expect(Math.abs(path[key] - middle[key])).toBeLessThan(1.1);
      }
    }
    const approaching = pathAt(90);
    expect(approaching.startX).toBeGreaterThan(middle.startX);
    expect(approaching.startX).toBeLessThan(382);
    expect(pathAt(180).startX).toBe(382);
    expect(pathAt(-180).endX).toBe(202);
  });

  it('毎フレームの表示座標を使い、SVGもnativeも同じ曲線を表す', () => {
    const traces = [trace('a', [['a', 'b']])];
    const boxes = new Map([['a', box(16, 0)], ['b', box(16, 132)]]);
    const [before] = createPushPaths(traces, boxes);
    boxes.set('b', box(392, 240));
    const [after] = createPushPaths(traces, boxes);
    expect(before.endX).toBe(10);
    expect(before.endY).toBe(156);
    expect(after.endX).toBe(386);
    expect(after.endY).toBe(264);
    expect(after.d).toBe(`M ${after.startX} ${after.startY} C ${after.control1X} ${after.control1Y} ${after.control2X} ${after.control2Y} ${after.endX} ${after.endY}`);
    expect(createPushPaths(traces, boxes)).toEqual([after]);
  });

  it('欠落・削除・無効座標・自己辺を落とし、元のデータを変更しない', () => {
    const valid = Object.freeze(box(16, 0));
    const boxes = new Map([
      ['a', valid], ['b', Object.freeze(box(16, 132))],
      ['invalid', box(NaN, 0)], ['negative', { ...box(16, 0), height: -1 }],
    ]);
    const edges = Object.freeze([
      Object.freeze({ fromId: 'a', toId: 'b' }),
      Object.freeze({ fromId: 'a', toId: 'missing' }),
      Object.freeze({ fromId: 'missing', toId: 'a' }),
      Object.freeze({ fromId: 'a', toId: 'invalid' }),
      Object.freeze({ fromId: 'negative', toId: 'a' }),
      Object.freeze({ fromId: 'a', toId: 'a' }),
    ]);
    const traces = Object.freeze([Object.freeze({ sourceId: 'a', edges })]);
    expect(createPushPaths(traces, boxes)).toHaveLength(1);
    boxes.delete('b');
    expect(createPushPaths(traces, boxes)).toEqual([]);
    expect(boxes.get('a')).toBe(valid);
    expect(traces[0].edges).toBe(edges);
  });

  it('最新4つの根を優先し、200枚以上でも調査する辺を96本までに抑える', () => {
    const boxes = new Map<string, PushEffectBox>();
    const traces = Array.from({ length: 7 }, (_, index) => {
      boxes.set(`root-${index}`, box(index * 376, 0));
      boxes.set(`leaf-${index}`, box(index * 376, 132));
      return trace(`root-${index}`, [[`root-${index}`, `leaf-${index}`]]);
    });
    const latest = createPushPaths(traces, boxes);
    expect(latest).toHaveLength(PUSH_EFFECT_MAX_TRACES);
    expect(latest.map(path => path.sourceId)).toEqual(['root-6', 'root-5', 'root-4', 'root-3']);

    const pairs: [string, string][] = Array.from({ length: 220 }, (_, index) => {
      boxes.set(`child-${index}`, box(16, index * 132));
      return ['root-6', `child-${index}`];
    });
    const lookup = vi.spyOn(boxes, 'get');
    const capped = createPushPaths([...traces, trace('root-6', pairs)], boxes);
    expect(capped).toHaveLength(PUSH_EFFECT_MAX_EDGES);
    expect(capped[0].toId).toBe('child-0');
    expect(capped.at(-1)?.toId).toBe('child-95');
    expect(lookup).toHaveBeenCalledTimes(PUSH_EFFECT_MAX_EDGES * 2);
  });

  it('無効な辺が大量にあっても調査数の上限を超えない', () => {
    const boxes = new Map([['a', box(16, 0)], ['b', box(16, 132)]]);
    const pairs: [string, string][] = Array.from({ length: PUSH_EFFECT_MAX_EDGES }, () => ['a', 'missing']);
    expect(createPushPaths([trace('a', [...pairs, ['a', 'b']])], boxes)).toEqual([]);
  });

  it('画面外の曲線を除外するが、両端が画面外でも横切る曲線は残す', () => {
    const traces = [trace('a', [['a', 'b']])];
    const viewport = { x: 0, y: 0, width: 400, height: 300 };
    expect(createPushPaths(traces, new Map([['a', box(16, 400)], ['b', box(16, 600)]]), viewport)).toEqual([]);
    expect(createPushPaths(traces, new Map([['a', box(16, -200)], ['b', box(16, 500)]]), viewport)).toHaveLength(1);
    expect(createPushPaths(traces, new Map([['a', box(-500, 0)], ['b', box(600, 0)]]), viewport)).toHaveLength(1);
    expect(createPushPaths(traces, new Map([['a', box(900, 0)], ['b', box(900, 100)]]), viewport)).toEqual([]);
  });

  it('線幅が画面端にかかる曲線を除外しない', () => {
    const traces = [trace('a', [['a', 'b']])];
    const boxes = new Map([['a', box(5, 0)], ['b', box(5, 100)]]);
    expect(createPushPaths(traces, boxes, { x: 0, y: 0, width: 400, height: 300 })).toHaveLength(1);
  });
});

describe('V2の押出エフェクトの寿命と描画', () => {
  it('80msで薄く現れて1400msで消え、時刻やフレーム回数に依存しない', () => {
    expect(PUSH_EFFECT_DURATION_MS).toBe(1400);
    expect(PUSH_EFFECT_FADE_IN_MS).toBe(80);
    expect(pushEffectOpacity(0)).toBe(0);
    expect(pushEffectOpacity(40)).toBe(0.5);
    expect(pushEffectOpacity(80)).toBe(1);
    expect(pushEffectOpacity(740)).toBe(0.5);
    expect(pushEffectOpacity(1400)).toBe(0);
    for (const age of [-1, 1401, 60000, NaN, Infinity]) expect(pushEffectOpacity(age)).toBe(0);
  });

  it('独立した曲線を2回だけstrokeし、ぼかし・影・文字を追加せず描画状態を戻す', () => {
    const paths = createPushPaths([trace('a', [['a', 'b'], ['a', 'c']])], new Map([
      ['a', box(16, 0)], ['b', box(16, 132)], ['c', box(392, 132)],
    ]));
    const { ctx, initial, strokeStates, writes } = fakeContext();
    drawPushPaths(ctx, paths, 0.8);
    expect(ctx.save).toHaveBeenCalledOnce();
    expect(ctx.restore).toHaveBeenCalledOnce();
    expect(ctx.beginPath).toHaveBeenCalledOnce();
    expect(ctx.moveTo.mock.calls).toEqual(paths.map(path => [path.startX, path.startY]));
    expect(ctx.bezierCurveTo.mock.calls).toEqual(paths.map(path => [path.control1X, path.control1Y, path.control2X, path.control2Y, path.endX, path.endY]));
    expect(ctx.stroke).toHaveBeenCalledTimes(2);
    expect(strokeStates.map(state => state.lineWidth)).toEqual([PUSH_EFFECT_STYLE.haloWidth, PUSH_EFFECT_STYLE.mainWidth]);
    expect(strokeStates[0].globalAlpha).toBeCloseTo(0.5 * 0.8 * PUSH_EFFECT_STYLE.haloAlpha);
    expect(strokeStates[1].globalAlpha).toBeCloseTo(0.5 * 0.8 * PUSH_EFFECT_STYLE.mainAlpha);
    for (const state of strokeStates) {
      expect(state).toMatchObject({ strokeStyle: PUSH_EFFECT_STYLE.color, lineCap: 'round', lineJoin: 'round', shadowBlur: 0, shadowColor: 'transparent', filter: 'none' });
    }
    expect(writes.filter(([property]) => property === 'filter')).toEqual([['filter', 'none']]);
    expect(writes.filter(([property]) => property === 'shadowBlur')).toEqual([['shadowBlur', 0]]);
    expect(ctx).toMatchObject(initial);
  });

  it('非表示なら描かず、描画に失敗してもsaveした状態を復元する', () => {
    const paths = createPushPaths([trace('a', [['a', 'b']])], new Map([['a', box(16, 0)], ['b', box(16, 132)]]));
    const { ctx, initial } = fakeContext();
    for (const opacity of [0, -1, NaN, Infinity]) drawPushPaths(ctx, paths, opacity);
    drawPushPaths(ctx, [], 1);
    expect(ctx.save).not.toHaveBeenCalled();
    ctx.stroke.mockImplementation(() => { throw new Error('描画失敗'); });
    expect(() => drawPushPaths(ctx as PushEffectContext, paths, 1)).toThrow('描画失敗');
    expect(ctx.restore).toHaveBeenCalledOnce();
    expect(ctx).toMatchObject(initial);
  });
});
