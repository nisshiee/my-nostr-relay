import { describe, expect, it } from 'vitest';
import { detectCanvasMode, layoutScene, planSceneLayout, type SceneBox } from '../scene';
describe('V2 scene', () => {
  it('能力がない環境ではDOMにする', () => {
    expect(detectCanvasMode({} as HTMLCanvasElement, null)).toBe('dom');
    expect(detectCanvasMode({requestPaint() {}} as unknown as HTMLCanvasElement, {} as CanvasRenderingContext2D)).toBe('dom');
  });
  it('API世代を分ける', () => {
    const ctx = {drawElementImage() {}} as unknown as CanvasRenderingContext2D;
    expect(detectCanvasMode({requestPaint() {}} as unknown as HTMLCanvasElement, ctx)).toBe('legacy');
    expect(detectCanvasMode({requestPaint() {}, content: ''} as unknown as HTMLCanvasElement, ctx)).toBe('modern');
  });

  it('既存の順序を守り、削除を反映する', () => {
    const first = layoutScene(['a','b','c'], new Map(), 400, new Map());
    const next = layoutScene(['new','c','a'], new Map(), 400, first);
    expect(next.has('b')).toBe(false);
    expect(next.get('a')!.y).toBeLessThan(next.get('c')!.y);
    expect(next.get('new')!.y).toBe(16);
    expect(next.get('new')!.y).toBeLessThan(next.get('a')!.y);
  });
  it('操作中のカードと新着を重ねない', () => {
    const first = layoutScene(['a','b'], new Map(), 400, new Map());
    const next = layoutScene(['new','a','b'], new Map(), 400, first, new Set(['a']));
    expect(next.get('a')).toEqual(first.get('a'));
    expect(next.get('new')!.y).toBe(first.get('b')!.y);
    expect(next.get('b')!.y).toBeGreaterThan(next.get('new')!.y);
  });

  it('挿入した列だけが上から順に連鎖し、他の列は動かない', () => {
    const first = layoutScene(['a', 'b', 'c', 'd'], new Map(), 800, new Map());
    const next = planSceneLayout(['new', 'a', 'b', 'c', 'd'], new Map(), 800, first);
    expect(next.boxes.get('new')).toMatchObject({ x: 16, y: 16 });
    expect(next.boxes.get('b')).toEqual(first.get('b'));
    expect(next.boxes.get('d')).toEqual(first.get('d'));
    expect([...next.chainOrder]).toEqual([['new', 0], ['a', 1], ['c', 2]]);
  });

  it('スコア順が変わっても既存の列と列内順序は変えない', () => {
    const first = layoutScene(['a', 'b', 'c', 'd'], new Map(), 800, new Map());
    const next = planSceneLayout(['d', 'c', 'b', 'a'], new Map(), 800, first);
    for (const [id, box] of first) expect(next.boxes.get(id)).toEqual(box);
    expect(next.chainOrder.size).toBe(0);
  });

  it('短い列を選んで新着を挿入する', () => {
    const heights = new Map([['a', 500], ['b', 100]]);
    const first = layoutScene(['a', 'b'], heights, 800, new Map());
    const next = planSceneLayout(['new', 'a', 'b'], heights, 800, first);
    expect(next.boxes.get('new')!.x).toBe(first.get('b')!.x);
    expect(next.boxes.get('new')!.y).toBe(16);
    expect(next.boxes.get('a')).toEqual(first.get('a'));
    expect(next.chainOrder.has('a')).toBe(false);
  });

  it('同時に届く新着は入力順で上に積み、既存カードの順序を保つ', () => {
    const first = layoutScene(['a', 'b'], new Map(), 400, new Map());
    const next = planSceneLayout(['new1', 'new2', 'b', 'a'], new Map(), 400, first);
    const order = [...next.boxes].sort((a, b) => a[1].y - b[1].y).map(([id]) => id);
    expect(order).toEqual(['new1', 'new2', 'a', 'b']);
    expect([...next.chainOrder]).toEqual([['new1', 0], ['new2', 1], ['a', 2], ['b', 3]]);
  });

  it('高さ変更は既存列を保持して再配置し、新着の連鎖を作らない', () => {
    const first = layoutScene(['a', 'b', 'c', 'd'], new Map(), 800, new Map());
    const next = planSceneLayout(['a', 'b', 'c', 'd'], new Map([['a', 400]]), 800, first);
    expect(next.boxes.get('c')!.x).toBe(first.get('c')!.x);
    expect(next.boxes.get('c')!.y).toBe(432);
    expect(next.boxes.get('d')).toEqual(first.get('d'));
    expect(next.chainOrder.size).toBe(0);
  });

  it('holdは目標座標ではなく実際の表示座標と幅を固定する', () => {
    const first = layoutScene(['a', 'b'], new Map(), 400, new Map());
    const actual = new Map(first);
    actual.set('a', { ...first.get('a')!, x: 21, y: 67, width: 340 });
    const next = planSceneLayout(['new', 'a', 'b'], new Map([['a', 230]]), 800, first, new Set(['a']), actual);
    expect(next.boxes.get('a')).toEqual({ x: 21, y: 67, width: 340, height: 230 });
    for (const [id, box] of next.boxes) {
      if (id === 'a') continue;
      const held = next.boxes.get('a')!;
      expect(box.x + box.width <= held.x || held.x + held.width <= box.x || box.y + box.height + 16 <= held.y || held.y + held.height + 16 <= box.y).toBe(true);
    }
  });

  it('列数が変わった場合は入力順で列を配り直す', () => {
    const first = planSceneLayout(['a', 'b', 'c', 'd'], new Map(), 800, new Map());
    const next = planSceneLayout(['d', 'c', 'b', 'a'], new Map(), 1200, first.boxes, new Set(), first.boxes, first.columnCount);
    expect(next.columnCount).toBe(3);
    expect(next.boxes.get('d')).toMatchObject({ x: 16, y: 16 });
    expect(next.boxes.get('c')).toMatchObject({ x: 392, y: 16 });
    expect(next.boxes.get('b')).toMatchObject({ x: 768, y: 16 });
    expect(next.chainOrder.size).toBe(0);
  });

  it('入力MapとBoxを変更せず、削除したスロットを残さない', () => {
    const original = Object.freeze({ x: 16, y: 16, width: 360, height: 180 });
    const previous = new Map<string, SceneBox>([['a', original], ['deleted', { ...original, y: 212 }]]);
    const next = planSceneLayout(['new', 'a'], new Map([['a', 220]]), 400, previous);
    expect(previous.get('a')).toBe(original);
    expect(original.height).toBe(180);
    expect(previous.has('deleted')).toBe(true);
    expect(next.boxes.has('deleted')).toBe(false);
  });

  it('可変高さ・連続挿入・削除・holdでも最終配置に重なりを残さない', () => {
    let ids = Array.from({ length: 30 }, (_, index) => `old-${index}`);
    const heights = new Map(ids.map((id, index) => [id, 80 + index * 37 % 360]));
    let previous = layoutScene(ids, heights, 1200, new Map());
    for (let iteration = 0; iteration < 40; iteration++) {
      ids = [`incoming-${iteration}`, ...ids.filter((_, index) => index !== 18)];
      heights.set(ids[0], 75 + iteration * 71 % 470);
      heights.set(ids[10], 100 + iteration * 31 % 250);
      const held = new Set([ids[4], ids[12]]);
      // 高さを変更しない既存カードをholdすることで、hold同士の入力重複を作らない。
      const next = planSceneLayout(ids, heights, 1200, previous, held);
      const boxes = [...next.boxes.values()];
      for (let left = 0; left < boxes.length; left++) {
        const a = boxes[left];
        expect(a.x).toBeGreaterThanOrEqual(0);
        expect(a.y).toBeGreaterThanOrEqual(0);
        for (let right = left + 1; right < boxes.length; right++) {
          const b = boxes[right];
          expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height + 16 <= b.y || b.y + b.height + 16 <= a.y).toBe(true);
        }
      }
      for (const id of held) expect(next.boxes.get(id)).toEqual(previous.get(id));
      expect(next.boxes.size).toBe(ids.length);
      previous = next.boxes;
    }
  });
  it('holdしたカードが成長しても後続は重ならない', () => {
    const first = layoutScene(['a','b'], new Map(), 400, new Map());
    const next = layoutScene(['a','b'], new Map([['a',500]]), 400, first, new Set(['a']));
    expect(next.get('a')!.y).toBe(first.get('a')!.y);
    expect(next.get('b')!.y).toBeGreaterThanOrEqual(next.get('a')!.y + 500 + 16);
  });

});
