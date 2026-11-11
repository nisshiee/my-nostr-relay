import { describe, expect, it } from 'vitest';
import type { SceneBox, SceneInsertionTrace } from '../scene';
import {
  createDominoTransforms, dominoEffectAmount, dominoIdentity,
  DOMINO_EFFECT_DURATION_MS, DOMINO_EFFECT_MAX_CARDS, DOMINO_EFFECT_MAX_DELAY_MS,
  DOMINO_EFFECT_MAX_EDGES, DOMINO_EFFECT_MAX_TRACES, DOMINO_EFFECT_PULSE_MS, DOMINO_EFFECT_STEP_MS,
  DOMINO_PERSPECTIVE_DISTANCE_RATIO, DOMINO_PERSPECTIVE_MAX_ANGLE_DEG,
  type DominoMatrix, type DominoPivotEdge,
} from '../dominoEffect';

const box = (x: number, y: number): SceneBox => ({ x, y, width: 320, height: 180 });
const boxes = new Map([
  ['root', box(16, 16)], ['a', box(16, 208)], ['b', box(16, 400)],
  ['right', box(352, 208)], ['left', box(-320, 208)], ['unrelated', box(688, 16)],
]);
const trace = (sourceId: string, pairs: readonly (readonly [string, string])[]): SceneInsertionTrace => ({
  sourceId, edges: pairs.map(([fromId, toId]) => ({ fromId, toId })),
});
const chain = [trace('root', [['a', 'b'], ['root', 'a']])];
const point = (matrix: DominoMatrix, x: number, y: number) => ({
  x: matrix.a * x + matrix.c * y + matrix.e,
  y: matrix.b * x + matrix.d * y + matrix.f,
});
const visual = (id: string, age: number) => createDominoTransforms(chain, boxes, age).get(id) ?? dominoIdentity(boxes.get(id)!);

describe('V2の因果的なカード傾斜', () => {
  it('辺の配列順ではなく根からの深さに100msずつ遅延する', () => {
    const first = createDominoTransforms(chain, boxes, 50);
    expect([...first.keys()]).toEqual(['root']);
    expect(first.get('root')!.depth).toBe(0);
    const second = createDominoTransforms(chain, boxes, 150);
    expect(second.get('a')!.depth).toBe(1);
    expect(second.get('a')!.delayMs).toBe(DOMINO_EFFECT_STEP_MS);
    expect(second.has('b')).toBe(false);
    const third = createDominoTransforms(chain, boxes, 250);
    expect(third.get('b')!.depth).toBe(2);
    expect(third.get('b')!.delayMs).toBe(200);
    expect(third.has('unrelated')).toBe(false);
    expect(visual('root', 50).d).toBeCloseTo(visual('a', 150).d, 12);
    expect(visual('a', 150).d).toBeCloseTo(visual('b', 250).d, 12);
  });

  it('同じ親の分岐は同時に始まり、循環・重複・切れた辺を連鎖に足さない', () => {
    const result = createDominoTransforms([trace('root', [
      ['a', 'b'], ['a', 'right'], ['root', 'a'], ['root', 'a'],
      ['b', 'root'], ['a', 'a'], ['unrelated', 'left'],
    ])], boxes, 250);
    expect(result.get('b')!.depth).toBe(2);
    expect(result.get('right')!.depth).toBe(2);
    expect(result.get('b')!.amount).toBe(result.get('right')!.amount);
    expect(result.get('root')!.depth).toBe(0);
    expect(result.has('unrelated')).toBe(false);
    expect(result.has('left')).toBe(false);
  });

  it('下辺中央を動かさず、縦に押されたカードを短縮して倒す', () => {
    const matrix = visual('a', 296);
    const current = boxes.get('a')!;
    const pivot = point(matrix, current.width / 2, current.height);
    expect(pivot.x).toBeCloseTo(current.x + current.width / 2, 10);
    expect(pivot.y).toBeCloseTo(current.y + current.height, 10);
    expect(matrix.d).toBeLessThan(0.55);
    expect(point(matrix, current.width / 2, 0).y).toBeGreaterThan(current.y + 70);
    expect(matrix.a).toBe(1);
    expect(matrix.b).toBe(0);
    expect(matrix.c).toBe(0);
  });

  it('実際の横向きの辺で右/左へ傾き、下辺の支点は維持する', () => {
    const right = createDominoTransforms([trace('a', [['a', 'right']])], boxes, 296).get('right')!;
    const left = createDominoTransforms([trace('a', [['a', 'left']])], boxes, 296).get('left')!;
    expect(right.b).toBeGreaterThan(0);
    expect(right.c).toBeLessThan(0);
    expect(left.b).toBeLessThan(0);
    expect(left.c).toBeGreaterThan(0);
    for (const [id, matrix] of [['right', right], ['left', left]] as const) {
      const current = boxes.get(id)!;
      const top = point(matrix, current.width / 2, 0);
      expect(Math.sign(top.x - (current.x + current.width / 2))).toBe(id === 'right' ? 1 : -1);
      const pivot = point(matrix, current.width / 2, current.height);
      expect(pivot.x).toBeCloseTo(current.x + current.width / 2, 10);
      expect(pivot.y).toBeCloseTo(current.y + current.height, 10);
    }
  });

  it('表示カードが交差しても目標Boxから傾く方向を保ち、現在Boxを支点にする', () => {
    const moving = new Map(boxes);
    moving.set('right', box(-700, 208));
    const result = createDominoTransforms([trace('a', [['a', 'right']])], moving, 296, { directionBoxes: boxes });
    const matrix = result.get('right')!;
    expect(matrix.b).toBeGreaterThan(0);
    expect(point(matrix, 160, 180).x).toBeCloseTo(-540, 10);
    expect(point(matrix, 160, 180).y).toBeCloseTo(388, 10);
  });

  it('hold/focusされたカードは変形せず、後続の因果深さは変えない', () => {
    const result = createDominoTransforms(chain, boxes, 250, { heldIds: new Set(['root', 'a']) });
    expect(result.has('root')).toBe(false);
    expect(result.has('a')).toBe(false);
    expect(result.get('b')!.depth).toBe(2);
    expect(result.get('b')!.delayMs).toBe(200);
  });

  it('reduced-motionと開始前・終了後・無効な時刻は全て通常のBoxになる', () => {
    expect(createDominoTransforms(chain, boxes, 250, { reducedMotion: true }).size).toBe(0);
    for (const age of [-100, 0, DOMINO_EFFECT_DURATION_MS, 1e9, NaN, Infinity, -Infinity]) {
      expect(createDominoTransforms(chain, boxes, age).size).toBe(0);
    }
    expect(visual('a', 100)).toEqual(dominoIdentity(boxes.get('a')!));
    expect(visual('a', 100 + DOMINO_EFFECT_PULSE_MS)).toEqual(dominoIdentity(boxes.get('a')!));
    expect(dominoIdentity(boxes.get('a')!)).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 16, f: 208 });
  });

  it('一回だけ滑らかに倒れて起き、有限な正の行列式で文字を裏返さない', () => {
    expect(dominoEffectAmount(196)).toBe(1);
    expect(dominoEffectAmount(50)).toBeLessThan(dominoEffectAmount(150));
    expect(dominoEffectAmount(250)).toBeGreaterThan(dominoEffectAmount(550));
    expect(dominoEffectAmount(0.001)).toBeLessThan(1e-8);
    expect(dominoEffectAmount(699.999)).toBeLessThan(1e-8);
    for (const value of [-1, 0, 700, NaN, Infinity]) expect(dominoEffectAmount(value)).toBe(0);
    for (let age = 1; age < DOMINO_EFFECT_DURATION_MS; age += 7) {
      const result = createDominoTransforms([trace('root', [['root', 'a'], ['a', 'right'], ['right', 'left']])], boxes, age);
      for (const matrix of result.values()) {
        expect([matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].every(Number.isFinite)).toBe(true);
        expect(matrix.a * matrix.d - matrix.b * matrix.c).toBeGreaterThan(0.45);
        expect(matrix.amount).toBeGreaterThan(0);
        expect(matrix.amount).toBeLessThanOrEqual(1);
      }
    }
  });

  it('burstの根を結ばず、重なるカードは新しい根の一回分だけを使う', () => {
    const independent = createDominoTransforms([
      trace('root', [['root', 'a']]), trace('right', [['right', 'b']]),
    ], boxes, 150);
    expect(independent.get('root')!.depth).toBe(0);
    expect(independent.get('right')!.depth).toBe(0);
    expect(independent.get('a')!.sourceId).toBe('root');
    expect(independent.get('b')!.sourceId).toBe('right');
    expect(independent.get('a')!.amount).toBe(independent.get('b')!.amount);
    const newer = trace('right', [['right', 'a'], ['a', 'b']]);
    const overlapping = createDominoTransforms([...chain, newer], boxes, 250);
    expect(overlapping.get('a')).toEqual(createDominoTransforms([newer], boxes, 250).get('a'));
    expect(overlapping.get('b')!.sourceId).toBe('right');
  });

  it('新しい根の待機時間を古い根の活動中パルスで上書きしない', () => {
    const result = createDominoTransforms([
      trace('root', [['root', 'b']]), trace('right', [['right', 'a'], ['a', 'b']]),
    ], boxes, 150);
    expect(result.has('b')).toBe(false);
    expect(result.get('a')!.sourceId).toBe('right');
  });

  it('200枚でも辺数・参加カード数・遅延・寿命を制限する', () => {
    const many = new Map(Array.from({ length: 200 }, (_, index) => [`card${index}`, box(16, index * 192)]));
    const pairs = Array.from({ length: 199 }, (_, index): [string, string] => [`card${index}`, `card${index + 1}`]);
    const traces = [trace('card0', pairs)];
    const result = createDominoTransforms(traces, many, 650);
    expect(result.size).toBe(DOMINO_EFFECT_MAX_EDGES + 1);
    expect(result.size).toBeLessThanOrEqual(DOMINO_EFFECT_MAX_CARDS);
    expect(Math.max(...[...result.values()].map(value => value.delayMs))).toBe(DOMINO_EFFECT_MAX_DELAY_MS);
    expect(result.get('card96')!.depth).toBe(96);
    expect(result.has('card97')).toBe(false);
    expect(DOMINO_EFFECT_DURATION_MS).toBeLessThanOrEqual(1600);
    expect(createDominoTransforms(traces, many, DOMINO_EFFECT_DURATION_MS).size).toBe(0);
  });

  it('多数のburstは新しい4根だけを処理し、それぞれの深さをゼロから始める', () => {
    const many = new Map<string, SceneBox>();
    const traces = Array.from({ length: 9 }, (_, index) => {
      many.set(`root${index}`, box(index * 336, 0));
      many.set(`child${index}`, box(index * 336, 192));
      return trace(`root${index}`, [[`root${index}`, `child${index}`]]);
    });
    const result = createDominoTransforms(traces, many, 150);
    expect(result.size).toBe(DOMINO_EFFECT_MAX_TRACES * 2);
    expect(result.has('root4')).toBe(false);
    expect(result.get('root5')!.depth).toBe(0);
    expect(result.get('root8')!.depth).toBe(0);
  });

  it('未到達・削除済み・不正なBoxと辺だけの根には効果を作らない', () => {
    const invalid = new Map(boxes);
    invalid.set('a', { ...boxes.get('a')!, width: NaN });
    expect(createDominoTransforms(chain, invalid, 250).size).toBe(0);
    expect(createDominoTransforms([trace('missing', [['a', 'b']])], boxes, 250).size).toBe(0);
    expect(createDominoTransforms([trace('root', [])], boxes, 250).size).toBe(0);
    for (const bad of [0, -1, Infinity]) {
      invalid.set('a', { ...boxes.get('a')!, height: bad });
      expect(createDominoTransforms(chain, invalid, 250).size).toBe(0);
    }
    const overlapped = new Map([['root', box(16, 16)], ['a', box(16, 16)]]);
    const result = createDominoTransforms([trace('root', [['root', 'a']])], overlapped, 250);
    expect(result.size).toBe(2);
    expect(result.get('a')!.d).toBeGreaterThan(0);
  });

  it('Box・trace・hold入力を変更せず、表示座標を平行移動しても傾きは同じ', () => {
    const snapshot = JSON.stringify([...boxes]);
    const traceSnapshot = JSON.stringify(chain);
    const held = new Set(['unrelated']);
    const original = createDominoTransforms(chain, boxes, 250, { heldIds: held });
    const translated = new Map([...boxes].map(([id, current]) => [id, { ...current, x: current.x + 900, y: current.y - 800 }]));
    const moved = createDominoTransforms(chain, translated, 250, { heldIds: held });
    for (const [id, matrix] of original) {
      const next = moved.get(id)!;
      expect(next.a).toBe(matrix.a);
      expect(next.b).toBe(matrix.b);
      expect(next.c).toBe(matrix.c);
      expect(next.d).toBe(matrix.d);
      expect(next.e).toBeCloseTo(matrix.e + 900, 10);
      expect(next.f).toBeCloseTo(matrix.f - 800, 10);
      expect(next.perspective).toEqual(matrix.perspective);
    }
    expect(JSON.stringify([...boxes])).toBe(snapshot);
    expect(JSON.stringify(chain)).toBe(traceSnapshot);
    expect([...held]).toEqual(['unrelated']);
  });
});

describe('V2の未採用の透視投影データ', () => {
  const target = box(16, 16);
  const directions = [
    { source: box(16, -300), edge: 'bottom', axis: 'x', sign: 1, hinge: [2, 3] },
    { source: box(16, 300), edge: 'top', axis: 'x', sign: -1, hinge: [0, 1] },
    { source: box(-400, 16), edge: 'right', axis: 'y', sign: -1, hinge: [1, 2] },
    { source: box(400, 16), edge: 'left', axis: 'y', sign: 1, hinge: [0, 3] },
  ] as const;
  const corners = [
    { x: 0, y: 0 }, { x: target.width, y: 0 },
    { x: target.width, y: target.height }, { x: 0, y: target.height },
  ];
  const perspective = (source: SceneBox, age = 296, current = target) => createDominoTransforms(
    [trace('source', [['source', 'target']])], new Map([['source', source], ['target', current]]), age,
  ).get('target')!.perspective;

  it.each(directions)('$edgeの辺を支点にし、反対辺が奥へ倒れる実際の台形を作る', ({ source, edge, axis, sign, hinge }) => {
    const projection = perspective(source);
    expect(projection.edge).toBe(edge);
    expect(projection.axis).toBe(axis);
    expect(projection.angleDeg).toBe(sign * DOMINO_PERSPECTIVE_MAX_ANGLE_DEG);
    expect(projection.cssTransform).toBe(
      `perspective(${projection.perspectivePx}px) rotate${axis.toUpperCase()}(${projection.angleDeg}deg)`,
    );
    expect(projection.transformOrigin).toBe(`${projection.pivotX}px ${projection.pivotY}px`);
    for (const [index, point] of projection.corners.entries()) {
      expect([point.x, point.y, point.z, point.w].every(Number.isFinite)).toBe(true);
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(target.width);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(target.height);
      if ((hinge as readonly number[]).includes(index)) {
        expect(point).toEqual({ ...corners[index], z: 0, w: 1 });
      } else {
        expect(point.z).toBeLessThan(0);
        expect(point.w).toBeGreaterThan(1);
      }
    }
    const far = projection.corners.filter((_, index) => !(hinge as readonly number[]).includes(index));
    const farLength = Math.hypot(far[1].x - far[0].x, far[1].y - far[0].y);
    const hingeLength = axis === 'x' ? target.width : target.height;
    expect(farLength).toBeLessThan(hingeLength * 0.7);
    expect(farLength).toBeCloseTo(hingeLength / far[0].w, 10);
  });

  it('全時刻・全方向の投影を元の矩形内に保ち、正のwで遠近除算する', () => {
    for (const { source } of directions) {
      for (let age = 101; age < 800; age += 7) {
        const projection = perspective(source, age);
        expect(Math.abs(projection.angleDeg)).toBeLessThanOrEqual(DOMINO_PERSPECTIVE_MAX_ANGLE_DEG);
        for (const point of projection.corners) {
          expect(point.x).toBeGreaterThanOrEqual(0);
          expect(point.x).toBeLessThanOrEqual(target.width);
          expect(point.y).toBeGreaterThanOrEqual(0);
          expect(point.y).toBeLessThanOrEqual(target.height);
          expect(point.z).toBeLessThanOrEqual(0);
          expect(point.w).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it('透視除算がCSSのperspective後rotate行列の適用順序と一致する', () => {
    for (const { source } of directions) {
      const projection = perspective(source);
      const radians = projection.angleDeg * Math.PI / 180;
      for (const [index, original] of corners.entries()) {
        const x = original.x - projection.pivotX;
        const y = original.y - projection.pivotY;
        const rotatedX = projection.axis === 'y' ? x * Math.cos(radians) : x;
        const rotatedY = projection.axis === 'x' ? y * Math.cos(radians) : y;
        const rotatedZ = projection.axis === 'x' ? y * Math.sin(radians) : -x * Math.sin(radians);
        const w = 1 - rotatedZ / projection.perspectivePx;
        expect(projection.corners[index].x).toBeCloseTo(projection.pivotX + rotatedX / w, 12);
        expect(projection.corners[index].y).toBeCloseTo(projection.pivotY + rotatedY / w, 12);
        expect(projection.corners[index].w).toBe(w);
      }
    }
  });

  it('幅・高さに合わせて透視距離が変わり、相似のカードは相似の台形になる', () => {
    for (const { source, axis } of directions) {
      const original = perspective(source);
      const doubled = perspective({ ...source, x: source.x * 2, y: source.y * 2, width: 640, height: 360 }, 296,
        { x: target.x * 2, y: target.y * 2, width: 640, height: 360 });
      expect(original.perspectivePx).toBe((axis === 'x' ? target.height : target.width) * DOMINO_PERSPECTIVE_DISTANCE_RATIO);
      expect(doubled.perspectivePx).toBe(original.perspectivePx * 2);
      for (const [index, point] of original.corners.entries()) {
        expect(doubled.corners[index].x).toBeCloseTo(point.x * 2, 10);
        expect(doubled.corners[index].y).toBeCloseTo(point.y * 2, 10);
        expect(doubled.corners[index].w).toBe(point.w);
      }
    }
  });

  it('有限だが極端な寸法でも透視距離・CSS・投影点に無限大を作らない', () => {
    for (const { source, axis } of directions) {
      for (const dimension of [Number.MAX_VALUE, Number.MIN_VALUE]) {
        const current = {
          x: 0, y: 0,
          width: axis === 'y' ? dimension : target.width,
          height: axis === 'x' ? dimension : target.height,
        };
        const result = createDominoTransforms(
          [trace('source', [['source', 'target']])], new Map([['source', source], ['target', current]]), 296,
          { directionBoxes: new Map([['source', source], ['target', target]]) },
        );
        const projection = result.get('target')!.perspective;
        expect(Number.isFinite(projection.perspectivePx)).toBe(true);
        expect(projection.perspectivePx).toBeGreaterThan(0);
        expect(projection.cssTransform).not.toMatch(/Infinity|NaN/);
        expect(projection.transformOrigin).not.toMatch(/Infinity|NaN/);
        for (const point of projection.corners) {
          expect([point.x, point.y, point.z, point.w].every(Number.isFinite)).toBe(true);
          expect(point.w).toBeGreaterThanOrEqual(1);
          expect(point.x).toBeGreaterThanOrEqual(0);
          expect(point.x).toBeLessThanOrEqual(current.width);
          expect(point.y).toBeGreaterThanOrEqual(0);
          expect(point.y).toBeLessThanOrEqual(current.height);
        }
      }
    }
  });

  it('斜めの押出は支配的な方向の辺へ倒し、移動中の座標には引きずられない', () => {
    const cases: readonly [SceneBox, DominoPivotEdge][] = [
      [box(-400, -100), 'right'], [box(400, 100), 'left'],
      [box(-40, -400), 'bottom'], [box(40, 400), 'top'],
    ];
    for (const [source, edge] of cases) expect(perspective(source).edge).toBe(edge);
    const current = new Map([['source', box(-400, 16)], ['target', box(-900, 16)]]);
    const directionBoxes = new Map([['source', box(-400, 16)], ['target', target]]);
    const result = createDominoTransforms([trace('source', [['source', 'target']])], current, 296, { directionBoxes });
    expect(result.get('target')!.perspective.edge).toBe('right');
  });

  it('パルスの端では台形と影が連続的に消え、同じ終了時刻でデータもなくなる', () => {
    for (const age of [100.001, 799.999]) {
      const projection = perspective(directions[0].source, age);
      expect(Math.abs(projection.angleDeg)).toBeLessThan(1e-6);
      expect(projection.shade.faceOpacity).toBeLessThan(1e-8);
      expect(projection.shade.footprintOpacity).toBeLessThan(1e-8);
      for (const [index, point] of projection.corners.entries()) {
        expect(point.x).toBeCloseTo(corners[index].x, 6);
        expect(point.y).toBeCloseTo(corners[index].y, 6);
        expect(point.w).toBeCloseTo(1, 8);
      }
    }
    expect(createDominoTransforms(chain, boxes, DOMINO_EFFECT_DURATION_MS).size).toBe(0);
  });

  it('面と接地影は別レイヤー用で、エッジの影は全方向でinsetだけになる', () => {
    for (const { source, edge } of directions) {
      const { shade } = perspective(source);
      expect(shade.faceGradient).toContain(`linear-gradient(to ${edge},`);
      expect(shade.footprintGradient).toContain(`linear-gradient(to ${edge},`);
      expect(shade.faceOpacity).toBeGreaterThan(0);
      expect(shade.faceOpacity).toBeLessThanOrEqual(0.3);
      expect(shade.footprintOpacity).toBeGreaterThan(0);
      expect(shade.footprintOpacity).toBeLessThanOrEqual(0.22);
      expect(shade.edgeShadow.match(/inset/g)).toHaveLength(2);
      expect(shade.edgeShadow).not.toMatch(/drop-shadow|filter|padding/);
      expect(shade.edgeShadow).not.toContain('NaN');
    }
  });
});
