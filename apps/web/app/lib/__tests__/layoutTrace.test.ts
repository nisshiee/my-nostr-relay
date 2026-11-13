import { describe, expect, it } from 'vitest';
import { buildInitialLayout, insertCard, type DisplacementEdge } from '../layoutEngine';
import type { Grid } from '../layoutTypes';
import type { Card } from '../types';

const note = (slotId: string, score = 0, pubkey = slotId): Card => ({
  type: 'note', slotId, score, pubkey, eventId: slotId, created_at: 0, content: '', tags: [],
});

/** 診断出力の有無で配置・連鎖・入力が一切変わらないことも毎回検証する。 */
function traced(
  grid: Grid, incoming: Card, cards: readonly Card[], columns: number,
  heights = new Map<string, number>(), held = new Set<string>(),
) {
  const snapshot = structuredClone({ grid, heights, held });
  const edges: DisplacementEdge[] = [];
  const result = insertCard(grid, incoming, cards, columns, heights, held, edges);
  const withoutTrace = insertCard(grid, incoming, cards, columns, heights, held);
  expect(result).toEqual(withoutTrace);
  expect(grid).toEqual(snapshot.grid);
  expect(heights).toEqual(snapshot.heights);
  expect(held).toEqual(snapshot.held);
  for (const edge of edges) {
    expect(edge.fromId).not.toBe(edge.toId);
    expect(held.has(edge.fromId)).toBe(false);
    expect(held.has(edge.toId)).toBe(false);
    expect(result.chain.movedIds.has(edge.fromId)).toBe(true);
    expect(result.chain.movedIds.has(edge.toId)).toBe(true);
  }
  expect(new Set(edges.map(edge => edge.toId)).size).toBe(edges.length);
  return { result, edges };
}

describe('配置を変えない任意の押し出し因果trace', () => {
  it('空き位置への挿入では架空の辺を作らない', () => {
    const incoming = note('new', 2);
    const { result, edges } = traced(new Map(), incoming, [incoming], 2);
    expect(result.grid.get('new')).toEqual({ col: 0, y: 0 });
    expect(edges).toEqual([]);
  });

  it('列末尾の相手を直接下げる終端の辺も記録する', () => {
    const cards = [note('new', 2), note('a', 1)];
    const { result, edges } = traced(new Map([['a', { col: 0, y: 0 }]]), cards[0], cards, 1);
    expect(edges).toEqual([{ fromId: 'new', toId: 'a' }]);
    expect(result.grid.get('a')).toEqual({ col: 0, y: 132 });
  });

  it('隣列へ曲がる実際の再帰順を記録する', () => {
    const cards = [note('new', 200), note('victim', 100), note('lower', 50), note('A', 30), note('B', 10)];
    const grid = new Map([
      ['victim', { col: 0, y: 0 }], ['lower', { col: 0, y: 132 }],
      ['A', { col: 1, y: 0 }], ['B', { col: 1, y: 132 }],
    ]);
    const { result, edges } = traced(grid, cards[0], cards, 2);
    expect(edges).toEqual([
      { fromId: 'new', toId: 'victim' }, { fromId: 'victim', toId: 'A' }, { fromId: 'A', toId: 'B' },
    ]);
    expect(result.grid.get('new')!.col).toBe(0);
    expect(result.grid.get('victim')!.col).toBe(1);
  });

  it('最初のholdを迂回した場合は迂回先の実際の相手だけを結ぶ', () => {
    const cards = [note('new', 200, 'shared'), note('lower', 100), note('held', 10, 'shared'), note('adj', 1)];
    const grid = new Map([
      ['held', { col: 0, y: 0 }], ['lower', { col: 0, y: 132 }], ['adj', { col: 1, y: 0 }],
    ]);
    const { result, edges } = traced(grid, cards[0], cards, 2, new Map(), new Set(['held']));
    expect(edges).toEqual([{ fromId: 'new', toId: 'adj' }]);
    expect(result.grid.get('new')!.col).toBe(1);
    expect(result.grid.get('held')).toEqual(grid.get('held'));
  });

  it('連鎖の途中でholdを迂回しても直前の親を保持し、holdを辺に含めない', () => {
    const cards = [note('new', 200), note('a', 100), note('lower', 100), note('held', 1), note('adj', 0)];
    const grid = new Map([
      ['a', { col: 0, y: 0 }], ['held', { col: 0, y: 132 }],
      ['lower', { col: 0, y: 264 }], ['adj', { col: 1, y: 132 }],
    ]);
    const { result, edges } = traced(grid, cards[0], cards, 2, new Map(), new Set(['held']));
    expect(edges).toEqual([{ fromId: 'new', toId: 'a' }, { fromId: 'a', toId: 'adj' }]);
    expect(result.grid.get('a')!.col).toBe(1);
    expect(result.grid.get('held')).toEqual(grid.get('held'));
  });

  it('hold同士の循環を末尾へ迂回する終端では辺を作らない', () => {
    const cards = [note('new', 20), note('lower-a', 10), note('lower-b', 10), note('a', 0), note('b', 0)];
    const grid = new Map([
      ['a', { col: 0, y: 0 }], ['b', { col: 1, y: 0 }],
      ['lower-a', { col: 0, y: 132 }], ['lower-b', { col: 1, y: 132 }],
    ]);
    const { result, edges } = traced(grid, cards[0], cards, 2, new Map(), new Set(['a', 'b']));
    expect(edges).toEqual([]);
    expect(result.grid.get('new')).toEqual({ col: 0, y: 264 });
  });

  it('最下段のholdの下へ置く場合もholdを押したと記録しない', () => {
    const cards = [note('new', 2), note('held', 1)];
    const { result, edges } = traced(new Map([['held', { col: 0, y: 0 }]]), cards[0], cards, 1, new Map(), new Set(['held']));
    expect(edges).toEqual([]);
    expect(result.grid.get('new')).toEqual({ col: 0, y: 132 });
  });

  it('高さ補正でだけ動いたカードを因果traceへ混ぜない', () => {
    const cards = [note('new', 200), note('a', 100), note('b', 50), note('c', 40), note('adj', 10)];
    const heights = new Map([['new', 300], ['a', 40], ['b', 60], ['c', 60], ['adj', 120]]);
    const grid = new Map([
      ['a', { col: 0, y: 0 }], ['b', { col: 0, y: 100 }],
      ['c', { col: 0, y: 200 }], ['adj', { col: 1, y: 0 }],
    ]);
    const { result, edges } = traced(grid, cards[0], cards, 2, heights);
    expect(edges).toEqual([{ fromId: 'new', toId: 'a' }, { fromId: 'a', toId: 'adj' }]);
    expect(result.grid.get('b')!.y).toBe(312);
    expect(result.grid.get('c')!.y).toBe(384);
    expect(result.chain.chainOrder.has('b')).toBe(true);
    expect(result.chain.chainOrder.has('c')).toBe(true);
    expect(edges.some(edge => edge.toId === 'b' || edge.toId === 'c')).toBe(false);
  });

  it('連続挿入のtraceは別々に保持し、後の挿入で前の辺を書き換えない', () => {
    const existing = [note('a', 0.9), note('b', 0.8), note('c', 0.7), note('d', 0.6)];
    const cards = [note('new1', 2, 'a'), note('new2', 1.5, 'a'), ...existing];
    const initial = buildInitialLayout(existing, 2, new Map()).grid;
    const first = traced(initial, cards[0], cards, 2);
    const firstSnapshot = structuredClone(first.edges);
    const second = traced(first.result.grid, cards[1], cards, 2);
    expect(first.edges).toEqual(firstSnapshot);
    expect(second.edges[0]).toEqual({ fromId: 'new2', toId: 'new1' });
    expect(first.edges[0]).toEqual({ fromId: 'new1', toId: 'a' });
    expect(second.edges).not.toBe(first.edges);
  });

  it.each([1, 2, 3])('%i列の可変高さ・引力・hold・連続挿入で診断有無の出力を一致させる', columns => {
    for (const holdMode of ['none', 'some', 'all']) {
      let cards: Card[] = Array.from({ length: 12 }, (_, index) => note(`old-${index}`, 12 - index, `author-${index % 3}`));
      const heights = new Map(cards.map((card, index) => [card.slotId, 20 + index * 73 % 300]));
      let grid = buildInitialLayout(cards, columns, heights).grid;
      const held = new Set(cards.filter((_, index) => holdMode === 'all' || holdMode === 'some' && index % 2 === 0).map(card => card.slotId));
      for (let index = 0; index < 8; index++) {
        const incoming = note(`new-${index}`, 20 + index, `author-${index % 3}`);
        cards = [incoming, ...cards];
        heights.set(incoming.slotId, 30 + index * 97 % 400);
        grid = traced(grid, incoming, cards, columns, heights, held).result.grid;
      }
    }
  });
});
