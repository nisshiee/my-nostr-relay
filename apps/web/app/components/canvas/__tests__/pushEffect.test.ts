import { describe, expect, it, vi } from 'vitest';
import {
  createPushPaths, createPushParticles, pushEffectOpacity,
  PUSH_EFFECT_DURATION_MS, PUSH_EFFECT_FADE_IN_MS, PUSH_EFFECT_MAX_EDGES,
  PUSH_EFFECT_MAX_TRACES, PUSH_EFFECT_MAX_PARTICLES, PUSH_EFFECT_MAX_HALOS, PUSH_EFFECT_STYLE,
  type PushEffectBox, type PushEffectTrace,
} from '../pushEffect';

const box = (x: number, y: number, height = 120): PushEffectBox => ({ x, y, width: 360, height });
const trace = (sourceId: string, pairs: readonly [string, string][]): PushEffectTrace => ({
  sourceId, edges: pairs.map(([fromId, toId]) => ({ fromId, toId })),
});

describe('魔法の杖の視認性', () => {
  it('金と白の砂だけを使い、連続線のスタイルを持たない', () => {
    expect(PUSH_EFFECT_STYLE).toEqual({
      dustColor: '#a86d00', warmDustColor: '#cf8d09', brightDustColor: '#e7b329',
      whiteColor: '#fff4b7', starColor: '#b87900', haloColor: '#e9ac20',
    });
    expect(PUSH_EFFECT_DURATION_MS).toBe(2200);
  });
});

describe('押出因果パス', () => {
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

  it('軌道が画面外でも砂の広がりが画面端にかかるなら除外しない', () => {
    const traces = [trace('a', [['a', 'b']])];
    const boxes = new Map([['a', box(-230, 0)], ['b', box(-230, 0)]]);
    expect(createPushPaths(traces, boxes, { x: 0, y: 0, width: 400, height: 300 })).toHaveLength(1);
  });
});

describe('押出エフェクトの寿命と描画', () => {
  it('80msで現れ1000msまで明るさを保ち2200msで消える', () => {
    expect(PUSH_EFFECT_DURATION_MS).toBe(2200);
    expect(PUSH_EFFECT_FADE_IN_MS).toBe(80);
    expect(pushEffectOpacity(0)).toBe(0);
    expect(pushEffectOpacity(40)).toBe(0.5);
    expect(pushEffectOpacity(80)).toBe(1);
    expect(pushEffectOpacity(900)).toBe(1);
    expect(pushEffectOpacity(1000)).toBe(1);
    expect(pushEffectOpacity(1600)).toBe(0.5);
    expect(pushEffectOpacity(2200)).toBe(0);
    for (const age of [-1, 2201, 60000, NaN, Infinity]) expect(pushEffectOpacity(age)).toBe(0);
  });


});

describe('決定的な魔法の星と光点', () => {
  const paths = createPushPaths([trace('a', [['a', 'b']])], new Map([['a', box(16, 0)], ['b', box(16, 300)]]));

  it('IDと経過時間から同じ砂を作り、乱数を使わず粒子を進ませる', () => {
    const random = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('乱数は禁止'); });
    try {
      const first = createPushParticles(paths, 500);
      expect(createPushParticles(paths, 500)).toEqual(first);
      expect(createPushParticles(paths, 600)).not.toEqual(first);
      expect(first.length).toBeGreaterThan(160);
      expect(first.filter(particle => particle.kind === 'dot').length).toBeGreaterThan(first.length * 0.9);
      expect(first.some(particle => particle.kind === 'star')).toBe(true);
      for (const particle of first) {
        expect(Number.isFinite(particle.x)).toBe(true);
        expect(Number.isFinite(particle.y)).toBe(true);
        expect(particle.alpha).toBeGreaterThanOrEqual(0);
        expect(particle.alpha).toBeLessThanOrEqual(1);
        expect(particle.radius).toBeGreaterThan(0);
        expect(Number.isFinite(particle.rotation)).toBe(true);
        expect(particle.haloAlpha).toBeGreaterThanOrEqual(0);
        expect(particle.haloAlpha).toBeLessThanOrEqual(particle.alpha);
        expect(Object.values(PUSH_EFFECT_STYLE)).toContain(particle.color);
      }
    } finally { random.mockRestore(); }
  });

  it('細い整列線にせず、左右へ不規則に広がる大小の砂と少数の鋭い星を作る', () => {
    const straight = { ...paths[0], control1X: paths[0].startX, control2X: paths[0].startX };
    const particles = createPushParticles([straight], 700);
    const offsets = particles.map(particle => particle.x - straight.startX);
    expect(Math.min(...offsets)).toBeLessThan(-20);
    expect(Math.max(...offsets)).toBeGreaterThan(20);
    expect(new Set(offsets.map(offset => Math.round(offset))).size).toBeGreaterThan(35);
    const dots = particles.filter(particle => particle.kind === 'dot');
    expect(dots.filter(particle => particle.radius < 2).length).toBeGreaterThan(dots.length * 0.8);
    expect(Math.min(...dots.map(particle => particle.radius))).toBeLessThan(1);
    expect(Math.max(...dots.map(particle => particle.radius))).toBeGreaterThan(2);
    const stars = particles.filter(particle => particle.kind === 'star');
    expect(stars.length).toBeLessThan(particles.length * 0.1);
    expect(stars.some(particle => particle.points.length === 8)).toBe(true);
    expect(stars.some(particle => particle.points.length === 16)).toBe(true);
    expect(stars.every(particle => particle.radius > 5)).toBe(true);
    expect(stars.every(particle => particle.color === PUSH_EFFECT_STYLE.starColor)).toBe(true);
    expect(stars.every(particle => particle.haloRadius === 0)).toBe(true);
  });

  it('白いカードでも濃い星の形と小さい明色の芯が残り、最初の1秒は強く見える', () => {
    for (const age of [100, 500, 1000]) {
      const particles = createPushParticles(paths, age);
      const alphas = particles.map(particle => particle.alpha).sort((left, right) => left - right);
      expect(alphas[Math.floor(alphas.length / 2)]).toBeGreaterThan(0.7);
      for (const particle of particles.filter(particle => particle.kind === 'star')) {
        expect(particle.coreRadius).toBeCloseTo(particle.radius * 0.36);
        expect(particle.coreColor).toBe(PUSH_EFFECT_STYLE.whiteColor);
        expect(particle.corePoints.length).toBe(particle.points.length);
        expect(particle.coreAlpha).toBe(particle.alpha);
        expect(particle.coreD).toBe(`${particle.corePoints.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')} Z`);
        for (let index = 0; index < particle.points.length; index++) {
          expect(particle.corePoints[index].x - particle.x).toBeCloseTo((particle.points[index].x - particle.x) * 0.36);
          expect(particle.corePoints[index].y - particle.y).toBeCloseTo((particle.points[index].y - particle.y) * 0.36);
        }
      }
    }
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
        expect([8, 16]).toContain(particle.points.length);
        expect(particle.d).toBe(`${particle.points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')} Z`);
      } else {
        expect(particle.points).toEqual([]);
        expect(particle.d).toBe(`M ${particle.x + particle.radius} ${particle.y} A ${particle.radius} ${particle.radius} 0 1 0 ${particle.x - particle.radius} ${particle.y} A ${particle.radius} ${particle.radius} 0 1 0 ${particle.x + particle.radius} ${particle.y} Z`);
      }
    }
  });

  it('大きい連鎖でも240粒と24個の光までに抑え、先頭と末尾を含む辺へ分散させる', () => {
    const many = Array.from({ length: 220 }, (_, index) => ({ ...paths[0], toId: `child-${index}` }));
    const particles = createPushParticles(many, 500);
    expect(particles).toHaveLength(PUSH_EFFECT_MAX_PARTICLES);
    expect(particles.filter(particle => particle.haloRadius > 0).length).toBeLessThanOrEqual(PUSH_EFFECT_MAX_HALOS);
    expect(new Set(particles.map(particle => particle.id)).size).toBe(PUSH_EFFECT_MAX_PARTICLES);
    expect(particles[0].id).toContain('child-0');
    expect(particles.at(-1)?.id).toContain('child-95');
  });

  it('両端も32分割の標本も画面外の長い辺で、画面を横切る部分に砂を集中する', () => {
    const crossing = createPushPaths([trace('a', [['a', 'b']])], new Map([
      ['a', box(16, -100060)], ['b', box(16, 99940)],
    ]));
    const viewport = { x: 0, y: 12345, width: 400, height: 120 };
    const inside = (particle: { x: number; y: number }) => particle.x >= viewport.x && particle.x <= viewport.x + viewport.width &&
      particle.y >= viewport.y && particle.y <= viewport.y + viewport.height;
    const wholePathParticles = createPushParticles(crossing, 500);
    const visibleParticles = createPushParticles(crossing, 500, viewport);
    expect(wholePathParticles.filter(inside).length).toBeLessThan(5);
    expect(visibleParticles.length).toBeGreaterThan(160);
    expect(visibleParticles.filter(inside).length).toBeGreaterThan(130);
    expect(createPushParticles(crossing, 500, viewport)).toEqual(visibleParticles);
  });

  it('見えない辺へ粒子を配分せず、画面近くの軌道から届く砂は残す', () => {
    const distant = createPushPaths([trace('far', [['far', 'far2']])], new Map([
      ['far', box(2000, 0)], ['far2', box(2000, 300)],
    ]));
    const viewport = { x: 0, y: 0, width: 400, height: 400 };
    expect(createPushParticles(distant, 500, viewport)).toEqual([]);
    const visible = createPushParticles([...distant, ...paths], 500, viewport);
    expect(visible.length).toBeGreaterThan(160);
    expect(visible.every(particle => !particle.id.includes('far'))).toBe(true);
    const adjacent = { ...paths[0], startX: 430, endX: 430, control1X: 430, control2X: 430 };
    const adjacentDust = createPushParticles([adjacent], 500, viewport);
    expect(adjacentDust.some(particle => particle.x < 400)).toBe(true);
    const outside = { ...viewport, y: 2000 };
    expect(createPushParticles(paths, 500, outside)).toEqual([]);
  });

  it('画面が長い辺の始点や終点に近くても、可視部分の砂を暗くしない', () => {
    const long = createPushPaths([trace('a', [['a', 'b']])], new Map([
      ['a', box(16, -60)], ['b', box(16, 99940)],
    ]));
    for (const y of [20, 99860]) {
      const viewport = { x: 0, y, width: 400, height: 120 };
      const particles = createPushParticles(long, 500, viewport);
      const inside = particles.filter(particle => particle.y >= y && particle.y <= y + viewport.height);
      expect(inside.length).toBeGreaterThan(130);
      const alphas = inside.map(particle => particle.alpha).sort((left, right) => left - right);
      expect(alphas[Math.floor(alphas.length / 2)]).toBeGreaterThan(0.7);
    }
  });

  it('有効な寿命外や空のパスでは粒子を作らない', () => {
    for (const age of [-1, 0, PUSH_EFFECT_DURATION_MS, 60000, NaN, Infinity]) expect(createPushParticles(paths, age)).toEqual([]);
    expect(createPushParticles([], 500)).toEqual([]);
  });
});
