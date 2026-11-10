import { describe, expect, it, vi } from 'vitest';
import {
  createPushPaths, createPushParticles, drawPushPaths, pushEffectOpacity,
  PUSH_EFFECT_DURATION_MS, PUSH_EFFECT_FADE_IN_MS, PUSH_EFFECT_MAX_EDGES,
  PUSH_EFFECT_MAX_TRACES, PUSH_EFFECT_MAX_PARTICLES, PUSH_EFFECT_STYLE,
  type PushEffectBox, type PushEffectContext, type PushEffectTrace,
} from '../pushEffect';

const box = (x: number, y: number, height = 120): PushEffectBox => ({ x, y, width: 360, height });
const trace = (sourceId: string, pairs: readonly [string, string][]): PushEffectTrace => ({
  sourceId, edges: pairs.map(([fromId, toId]) => ({ fromId, toId })),
});

function fakeContext() {
  const initial = {
    strokeStyle: 'red', fillStyle: 'blue', globalAlpha: 0.5, lineWidth: 7,
    lineCap: 'butt' as CanvasLineCap, lineJoin: 'miter' as CanvasLineJoin,
    shadowBlur: 8, shadowColor: 'purple', filter: 'blur(3px)',
  };
  const strokeStates: typeof initial[] = [];
  const fillStates: typeof initial[] = [];
  const writes: [PropertyKey, unknown][] = [];
  const currentState = () => Object.fromEntries(Object.keys(initial).map(key => [key, target[key as keyof typeof initial]]));
  let saved: Record<string, unknown> = {};
  const target = {
    ...initial,
    save: vi.fn(() => { saved = currentState(); }),
    restore: vi.fn(() => { Object.assign(target, saved); }),
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(), arc: vi.fn(), bezierCurveTo: vi.fn(),
    stroke: vi.fn(() => { strokeStates.push(currentState() as typeof initial); }),
    fill: vi.fn(() => { fillStates.push(currentState() as typeof initial); }),
  };
  const ctx = new Proxy(target, {
    set(object, property, value) {
      writes.push([property, value]);
      return Reflect.set(object, property, value);
    },
  });
  return { ctx, initial, strokeStates, fillStates, writes };
}

describe('魔法の杖の視認性', () => {
  it('nativeとSVG共通の太い紫と桃色の光・白金の芯を使う', () => {
    expect(PUSH_EFFECT_STYLE).toMatchObject({
      outerColor: '#7c3aed', outerWidth: 18,
      haloColor: '#f472b6', haloWidth: 10,
      color: '#f0abfc', mainWidth: 5,
      coreColor: '#fff7d6', coreWidth: 1.8,
      particleColor: '#fff8c5', particleOutlineColor: '#d946ef',
    });
    expect(PUSH_EFFECT_STYLE.mainAlpha).toBeGreaterThan(0.9);
    expect(PUSH_EFFECT_DURATION_MS).toBe(2200);
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

  it('カードの高さにかかわらず中央同士をS字でつなぐ', () => {
    const [path] = createPushPaths([trace('a', [['a', 'b']])], new Map([
      ['a', box(16, 10, 30)], ['b', box(16, 170)],
    ]));
    expect([path.startX, path.startY, path.endX, path.endY]).toEqual([196, 25, 196, 230]);
    expect(path.control1X).toBeLessThan(path.startX);
    expect(path.control2X).toBeGreaterThan(path.endX);
    expect(path.control1Y).toBeGreaterThan(path.startY);
    expect(path.control2Y).toBeLessThan(path.endY);
  });

  it('右方向も左方向も中央へつなぎ、水平な押出も曲線にする', () => {
    const boxes = new Map([['a', box(16, 20)], ['b', box(392, 20)]]);
    const [right] = createPushPaths([trace('a', [['a', 'b']])], boxes);
    const [left] = createPushPaths([trace('b', [['b', 'a']])], boxes);
    expect([right.startX, right.startY, right.endX, right.endY]).toEqual([196, 80, 572, 80]);
    expect(right.control1X).toBeGreaterThan(right.startX);
    expect(right.control2X).toBeLessThan(right.endX);
    expect(right.control1Y).toBeGreaterThan(right.startY);
    expect(right.control2Y).toBeLessThan(right.endY);
    expect([left.startX, left.startY, left.endX, left.endY]).toEqual([572, 80, 196, 80]);
    expect(left.control1X).toBeLessThan(left.startX);
    expect(left.control2X).toBeGreaterThan(left.endX);
    expect(left.control1Y).toBeLessThan(left.startY);
    expect(left.control2Y).toBeGreaterThan(left.endY);
  });

  it('横移動の開始や左右反転で中央のアンカーと制御点を跳ばさない', () => {
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
    expect(pathAt(90).startX).toBe(middle.startX);
    expect(pathAt(180).endX).toBe(376);
    expect(pathAt(-180).endX).toBe(16);
  });

  it('毎フレームの表示座標を使い、SVGもnativeも同じ曲線を表す', () => {
    const traces = [trace('a', [['a', 'b']])];
    const boxes = new Map([['a', box(16, 0)], ['b', box(16, 132)]]);
    const [before] = createPushPaths(traces, boxes);
    boxes.set('b', box(392, 240));
    const [after] = createPushPaths(traces, boxes);
    expect(before.endX).toBe(196);
    expect(before.endY).toBe(192);
    expect(after.endX).toBe(572);
    expect(after.endY).toBe(300);
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
    const boxes = new Map([['a', box(-186, 0)], ['b', box(-186, 0)]]);
    expect(createPushPaths(traces, boxes, { x: 0, y: 0, width: 400, height: 300 })).toHaveLength(1);
  });
});

describe('V2の押出エフェクトの寿命と描画', () => {
  it('80msで現れ900msまで明るさを保ち2200msで消える', () => {
    expect(PUSH_EFFECT_DURATION_MS).toBe(2200);
    expect(PUSH_EFFECT_FADE_IN_MS).toBe(80);
    expect(pushEffectOpacity(0)).toBe(0);
    expect(pushEffectOpacity(40)).toBe(0.5);
    expect(pushEffectOpacity(80)).toBe(1);
    expect(pushEffectOpacity(900)).toBe(1);
    expect(pushEffectOpacity(1550)).toBe(0.5);
    expect(pushEffectOpacity(2200)).toBe(0);
    for (const age of [-1, 2201, 60000, NaN, Infinity]) expect(pushEffectOpacity(age)).toBe(0);
  });

  it('独立した曲線の4層と星を描き、ぼかし・影・文字を追加せず描画状態を戻す', () => {
    const paths = createPushPaths([trace('a', [['a', 'b'], ['a', 'c']])], new Map([
      ['a', box(16, 0)], ['b', box(16, 132)], ['c', box(392, 132)],
    ]));
    const particles = createPushParticles(paths, 500);
    const { ctx, initial, strokeStates, fillStates, writes } = fakeContext();
    drawPushPaths(ctx, paths, 0.8, 500);
    expect(ctx.save).toHaveBeenCalledOnce();
    expect(ctx.restore).toHaveBeenCalledOnce();
    expect(ctx.beginPath).toHaveBeenCalledTimes(1 + particles.length);
    expect(ctx.moveTo.mock.calls.slice(0, paths.length)).toEqual(paths.map(path => [path.startX, path.startY]));
    expect(ctx.bezierCurveTo.mock.calls).toEqual(paths.map(path => [path.control1X, path.control1Y, path.control2X, path.control2Y, path.endX, path.endY]));
    expect(ctx.stroke).toHaveBeenCalledTimes(4 + particles.length);
    expect(strokeStates.slice(0, 4).map(state => state.lineWidth)).toEqual([
      PUSH_EFFECT_STYLE.outerWidth, PUSH_EFFECT_STYLE.haloWidth, PUSH_EFFECT_STYLE.mainWidth, PUSH_EFFECT_STYLE.coreWidth,
    ]);
    expect(strokeStates.slice(0, 4).map(state => state.strokeStyle)).toEqual([
      PUSH_EFFECT_STYLE.outerColor, PUSH_EFFECT_STYLE.haloColor, PUSH_EFFECT_STYLE.color, PUSH_EFFECT_STYLE.coreColor,
    ]);
    expect(strokeStates[0].globalAlpha).toBeCloseTo(0.5 * 0.8 * PUSH_EFFECT_STYLE.outerAlpha);
    expect(strokeStates[2].globalAlpha).toBeCloseTo(0.5 * 0.8 * PUSH_EFFECT_STYLE.mainAlpha);
    expect(ctx.fill).toHaveBeenCalledTimes(particles.length);
    expect(ctx.arc.mock.calls).toEqual(particles.filter(particle => particle.kind === 'dot').map(particle => [particle.x, particle.y, particle.radius, 0, Math.PI * 2]));
    expect(ctx.lineTo.mock.calls).toEqual(particles.flatMap(particle => particle.points.slice(1).map(point => [point.x, point.y])));
    for (let index = 0; index < particles.length; index++) {
      expect(fillStates[index].globalAlpha).toBeCloseTo(0.5 * 0.8 * particles[index].alpha);
      expect(fillStates[index].fillStyle).toBe(PUSH_EFFECT_STYLE.particleColor);
    }
    for (const state of strokeStates) {
      expect(state).toMatchObject({ lineCap: 'round', lineJoin: 'round', shadowBlur: 0, shadowColor: 'transparent', filter: 'none' });
    }
    expect(writes.filter(([property]) => property === 'filter')).toEqual([['filter', 'none']]);
    expect(writes.filter(([property]) => property === 'shadowBlur')).toEqual([['shadowBlur', 0]]);
    expect(ctx).toMatchObject(initial);
  });

  it('非表示なら描かず、描画に失敗してもsaveした状態を復元する', () => {
    const paths = createPushPaths([trace('a', [['a', 'b']])], new Map([['a', box(16, 0)], ['b', box(16, 132)]]));
    const { ctx, initial } = fakeContext();
    for (const opacity of [0, -1, NaN, Infinity]) drawPushPaths(ctx, paths, opacity, 500);
    for (const age of [0, -1, PUSH_EFFECT_DURATION_MS, NaN, Infinity]) drawPushPaths(ctx, paths, 1, age);
    drawPushPaths(ctx, [], 1, 500);
    expect(ctx.save).not.toHaveBeenCalled();
    ctx.stroke.mockImplementation(() => { throw new Error('描画失敗'); });
    expect(() => drawPushPaths(ctx as PushEffectContext, paths, 1, 500)).toThrow('描画失敗');
    expect(ctx.restore).toHaveBeenCalledOnce();
    expect(ctx).toMatchObject(initial);
  });
});

describe('決定的な魔法の星と光点', () => {
  const paths = createPushPaths([trace('a', [['a', 'b']])], new Map([['a', box(16, 0)], ['b', box(16, 300)]]));

  it('IDと経過時間から同じ星を作り、乱数を使わず曲線上を進ませる', () => {
    const random = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('乱数は禁止'); });
    try {
      const first = createPushParticles(paths, 500);
      expect(createPushParticles(paths, 500)).toEqual(first);
      expect(createPushParticles(paths, 600)).not.toEqual(first);
      expect(first.map(particle => particle.kind)).toEqual(['star', 'star', 'dot']);
      for (const particle of first) {
        const progress = (particle.y - paths[0].startY) / (paths[0].endY - paths[0].startY);
        const remaining = 1 - progress;
        const expectedX = remaining ** 3 * paths[0].startX + 3 * remaining ** 2 * progress * paths[0].control1X +
          3 * remaining * progress ** 2 * paths[0].control2X + progress ** 3 * paths[0].endX;
        expect(particle.x).toBeCloseTo(expectedX, 8);
        expect(progress).toBeGreaterThanOrEqual(0);
        expect(progress).toBeLessThan(1);
        expect(particle.alpha).toBeGreaterThanOrEqual(0);
        expect(particle.alpha).toBeLessThanOrEqual(1);
        expect(particle.radius).toBeGreaterThan(0);
        expect(Number.isFinite(particle.rotation)).toBe(true);
      }
    } finally { random.mockRestore(); }
  });

  it('粒子の位相は配列順や現在の表示位置では変わらない', () => {
    const others = createPushPaths([trace('x', [['x', 'y']])], new Map([['x', box(400, 0)], ['y', box(400, 300)]]));
    const first = createPushParticles(paths, 500);
    expect(createPushParticles([...others, ...paths], 500).filter(particle => particle.id === first[0].id)).toEqual([first[0]]);
    const translated = createPushPaths([trace('a', [['a', 'b']])], new Map([['a', box(116, 200)], ['b', box(116, 500)]]));
    const moved = createPushParticles(translated, 500);
    expect(moved[0].x).toBeCloseTo(first[0].x + 100);
    expect(moved[0].y).toBeCloseTo(first[0].y + 200);
    expect(moved[0].alpha).toBe(first[0].alpha);
    expect(moved[0].rotation).toBe(first[0].rotation);
  });

  it('SVGの星もnativeと同じ回転済み頂点を使う', () => {
    for (const particle of createPushParticles(paths, 700)) {
      if (particle.kind === 'star') {
        expect(particle.points).toHaveLength(8);
        expect(particle.d).toBe(`${particle.points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')} Z`);
      } else {
        expect(particle.points).toEqual([]);
        expect(particle.d).toBe(`M ${particle.x + particle.radius} ${particle.y} A ${particle.radius} ${particle.radius} 0 1 0 ${particle.x - particle.radius} ${particle.y} A ${particle.radius} ${particle.radius} 0 1 0 ${particle.x + particle.radius} ${particle.y} Z`);
      }
    }
  });

  it('大きい連鎖でも48個までに抑え、先頭と末尾を含む辺へ分散させる', () => {
    const many = Array.from({ length: 220 }, (_, index) => ({ ...paths[0], toId: `child-${index}` }));
    const particles = createPushParticles(many, 500);
    expect(particles).toHaveLength(PUSH_EFFECT_MAX_PARTICLES);
    expect(new Set(particles.map(particle => particle.id)).size).toBe(PUSH_EFFECT_MAX_PARTICLES);
    expect(particles[0].id).toContain('child-0');
    expect(particles.at(-1)?.id).toContain('child-95');
  });

  it('有効な寿命外や空のパスでは粒子を作らない', () => {
    for (const age of [-1, 0, PUSH_EFFECT_DURATION_MS, 60000, NaN, Infinity]) expect(createPushParticles(paths, age)).toEqual([]);
    expect(createPushParticles([], 500)).toEqual([]);
  });
});
