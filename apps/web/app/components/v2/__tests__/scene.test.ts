import { describe, expect, it, vi } from 'vitest';
import * as layoutEngine from '../../../lib/layoutEngine';
import { buildInitialLayout, insertCard, reflow } from '../../../lib/layoutEngine';
import { DEFAULT_CARD_HEIGHT, GAP } from '../../../lib/constants';
import type { Grid, Placement } from '../../../lib/layoutTypes';
import type { Card, NoteCard } from '../../../lib/types';
import {
  createSceneLayout, detectCanvasMode, layoutScene, planSceneLayout, updateSceneLayout,
  type SceneLayoutState,
} from '../scene';
import { createSceneMotion, retargetSceneMotion } from '../sceneMotion';

const note = (slotId: string, score: number, pubkey = slotId): NoteCard => ({
  type: 'note', slotId, score, pubkey, eventId: `event-${slotId}`, content: '', tags: [], created_at: 0,
});

const items = (cards: readonly Card[]) => cards.map(card => ({ id: card.slotId, card }));
const viewport = (columns: number) => columns * 400;
const base = () => [note('a', 0.9), note('b', 0.8), note('c', 0.7), note('d', 0.6)];

describe('V2の新着と同時に隙間のない最終位置を計算する', () => {
  function gapFixture() {
    const cards = [note('a', 2), note('b', 1)];
    const heights = new Map([['a', 200], ['b', 120], ['new', 40]]);
    const first = updateSceneLayout(createSceneLayout(), items(cards), heights, 400);
    const nextCards = [note('new', 3), ...cards];
    const raw = insertCard(first.grid, nextCards[0], nextCards, 1, heights, new Set());
    const result = updateSceneLayout(first, items(nextCards), heights, 400);
    return { cards, nextCards, heights, first, raw, result };
  }

  it('一度下がってから上がる中間位置を返さず、到着時点で最終目標と元の連鎖を返す', () => {
    const { nextCards, heights, raw, result } = gapFixture();
    expect(raw.grid.get('a')).toEqual({ col: 0, y: 212 });
    expect(raw.grid.get('b')).toEqual({ col: 0, y: 424 });
    expect(result.grid).toEqual(reflow(raw.grid, nextCards, 1, heights).grid);
    expect(result.grid.get('a')).toEqual({ col: 0, y: 52 });
    expect(result.grid.get('b')).toEqual({ col: 0, y: 264 });
    expect(result.boxes.get('a')!.y).toBe(68);
    expect(result.boxes.get('b')!.y).toBe(280);
    expect(result.chainOrder).toEqual(raw.chain.chainOrder);
    expect(result.chainOrder.get('a')).toBe(1);
    expect(result.chainOrder.get('b')).toBe(2);
    expect(result).not.toHaveProperty('pendingCompaction');
  });

  it('全burstを逐次挿入して削除を反映した後にだけ一回reflowする', () => {
    const { first, heights, cards } = gapFixture();
    const nextCards = [note('new1', 4), note('new2', 3), cards[0]];
    const nextHeights = new Map(heights).set('new1', 40).set('new2', 60);
    const firstInsertion = insertCard(first.grid, nextCards[0], nextCards, 1, nextHeights, new Set());
    const secondInsertion = insertCard(firstInsertion.grid, nextCards[1], nextCards, 1, nextHeights, new Set());
    const mergedChain = new Map(firstInsertion.chain.chainOrder);
    for (const [id, order] of secondInsertion.chain.chainOrder) mergedChain.set(id, order);
    const cleaned = new Map([...secondInsertion.grid].filter(([id]) => id !== 'b'));
    const finalGrid = reflow(cleaned, nextCards, 1, nextHeights).grid;
    const insertSpy = vi.spyOn(layoutEngine, 'insertCard');
    const reflowSpy = vi.spyOn(layoutEngine, 'reflow');
    try {
      const result = updateSceneLayout(first, items(nextCards), nextHeights, 400);
      expect(insertSpy).toHaveBeenCalledTimes(2);
      expect(insertSpy.mock.calls[0][0].has('b')).toBe(true);
      expect(insertSpy.mock.calls[1][0]).toEqual(firstInsertion.grid);
      expect(reflowSpy).toHaveBeenCalledTimes(1);
      expect(reflowSpy.mock.calls[0][0].has('b')).toBe(false);
      expect(reflowSpy.mock.invocationCallOrder[0]).toBeGreaterThan(insertSpy.mock.invocationCallOrder[1]);
      expect(result.grid).toEqual(finalGrid);
      expect(result.chainOrder).toEqual(mergedChain);
    } finally {
      insertSpy.mockRestore();
      reflowSpy.mockRestore();
    }
  });

  it('隙間詰めだけで動く別列のカードにはドミノ待機を新設しない', () => {
    const cards = [note('a', 3), note('b', 2), note('untouched', 1)];
    const first = seeded(cards, new Map([
      ['a', { col: 0, y: 0 }], ['b', { col: 0, y: 132 }], ['untouched', { col: 1, y: 1000 }],
    ]), 2);
    const nextCards = [note('new', 4), ...cards];
    const result = updateSceneLayout(first, items(nextCards), new Map(), 800);
    expect(result.grid.get('untouched')).toEqual({ col: 1, y: 0 });
    expect(result.chainOrder.has('untouched')).toBe(false);
    const initialMotion = retargetSceneMotion(createSceneMotion(), first.boxes);
    const motion = retargetSceneMotion(initialMotion, result.boxes, { chainOrder: result.chainOrder });
    expect(motion.cards.get('untouched')!.delayMs).toBe(0);
    expect(motion.cards.get('untouched')!.phase).toBe('moving');
    expect(motion.cards.get('untouched')!.box.y).toBe(1016);
    expect(motion.cards.get('untouched')!.target.y).toBe(16);
  });

  it('引力が決めた列と列内順序は維持して余分な縦空隙だけ除く', () => {
    const cards = base();
    const heights = new Map([['a', 300], ['b', 70], ['c', 210], ['d', 80], ['new', 40]]);
    const first = updateSceneLayout(createSceneLayout(), items(cards), heights, 800);
    const nextCards = [note('new', 1, 'a'), ...cards];
    const raw = insertCard(first.grid, nextCards[0], nextCards, 2, heights, new Set());
    const result = updateSceneLayout(first, items(nextCards), heights, 800);
    expect(result.grid.get('new')!.col).toBe(1);
    expect(result.chainOrder).toEqual(raw.chain.chainOrder);
    for (const [id, placement] of raw.grid) expect(result.grid.get(id)!.col).toBe(placement.col);
    for (const col of [0, 1]) {
      const order = (grid: Grid) => [...grid].filter(([, p]) => p.col === col).sort((a, b) => a[1].y - b[1].y).map(([id]) => id);
      expect(order(result.grid)).toEqual(order(raw.grid));
      let nextY = 0;
      for (const id of order(result.grid)) {
        expect(result.grid.get(id)!.y).toBe(nextY);
        nextY += (heights.get(id) ?? DEFAULT_CARD_HEIGHT) + GAP;
      }
    }
  });

  it('再描画・renderer切替・同列数の幅変更で二度目の目標を作らない', () => {
    const { nextCards, heights, result } = gapFixture();
    expect(updateSceneLayout(result, items(nextCards), new Map(heights), 400)).toBe(result);
    const resized = updateSceneLayout(result, items(nextCards), heights, 340);
    expect(resized.grid).toEqual(result.grid);
    expect(resized.chainOrder).toEqual(result.chainOrder);
    expect(resized.boxes.get('a')!.width).toBe(308);
    expect(resized.boxes.get('a')!.y).toBe(68);
    expect(updateSceneLayout(resized, items(nextCards), heights, 340)).toBe(resized);
  });

  it('連打された次の新着は前回の最終gridから引力と連鎖を計算する', () => {
    const { nextCards, heights, result } = gapFixture();
    const burstCards = [note('burst', 4), ...nextCards];
    const burstHeights = new Map(heights).set('burst', 60);
    const raw = insertCard(result.grid, burstCards[0], burstCards, 1, burstHeights, new Set());
    const burst = updateSceneLayout(result, items(burstCards), burstHeights, 400);
    expect(burst.grid).toEqual(reflow(raw.grid, burstCards, 1, burstHeights).grid);
    expect(burst.chainOrder).toEqual(raw.chain.chainOrder);
    expect(updateSceneLayout(burst, items(burstCards), burstHeights, 400)).toBe(burst);
  });

  it('holdの実表示位置と幅は固定したまま論理gridを詰め、入力は変更しない', () => {
    const { first, cards, nextCards, heights } = gapFixture();
    const actual = new Map(first.boxes);
    actual.set('b', { ...actual.get('b')!, x: 21, y: 310, width: 340 });
    const held = new Set(['b']);
    const holding = updateSceneLayout(first, items(cards), heights, 400, held, actual);
    const snapshot = structuredClone({ grid: holding.grid, boxes: holding.boxes, frozen: holding.frozenBoxes });
    for (const placement of holding.grid.values()) Object.freeze(placement);
    for (const box of holding.boxes.values()) Object.freeze(box);
    const raw = insertCard(holding.grid, nextCards[0], nextCards, 1, heights, held);
    const result = updateSceneLayout(holding, items(nextCards), heights, 400, held, holding.boxes);
    expect(result.grid).toEqual(reflow(raw.grid, nextCards, 1, heights).grid);
    expect(result.chainOrder).toEqual(raw.chain.chainOrder);
    expect(result.boxes.get('b')).toEqual(actual.get('b'));
    expect(result.engineBoxes.get('b')!.y).not.toBe(310);
    expect(holding.grid).toEqual(snapshot.grid);
    expect(holding.boxes).toEqual(snapshot.boxes);
    expect(holding.frozenBoxes).toEqual(snapshot.frozen);
    const released = updateSceneLayout(result, items(nextCards), heights, 400);
    expect(released.boxes).toEqual(released.engineBoxes);
  });
});

type Oracle = { grid: Grid; ids: ReadonlySet<string>; columns: number; chain: ReadonlyMap<string, number> };
const emptyOracle = (): Oracle => ({ grid: new Map(), ids: new Set(), columns: 0, chain: new Map() });

/** V1公開APIで各段階を再現し、V2の挿入後一括reflowと連鎖保持を比較する。 */
function oracleStep(previous: Oracle, cards: readonly Card[], columns: number, heights = new Map<string, number>(), held = new Set<string>()): Oracle {
  const ids = new Set(cards.map(card => card.slotId));
  const rebuild = columns !== previous.columns || previous.grid.size === 0;
  let result;
  let inserted = false;
  if (rebuild) result = buildInitialLayout(cards, columns, heights);
  else {
    const incoming = cards.filter(card => !previous.ids.has(card.slotId) && !previous.grid.has(card.slotId));
    if (incoming.length) {
      inserted = true;
      let grid = previous.grid;
      const chainOrder = new Map<string, number>();
      for (const card of incoming) {
        const insertion = insertCard(grid, card, cards, columns, heights, held);
        grid = insertion.grid;
        for (const [id, order] of insertion.chain.chainOrder) chainOrder.set(id, order);
      }
      result = { grid, chain: { chainOrder } };
    } else result = reflow(previous.grid, cards, columns, heights);
  }
  const cleanGrid = new Map([...result.grid].filter(([id]) => ids.has(id)));
  return {
    grid: inserted ? reflow(cleanGrid, cards, columns, heights).grid : cleanGrid, ids, columns,
    chain: result.chain.chainOrder.size ? result.chain.chainOrder : rebuild ? new Map() : previous.chain,
  };
}

function expectOracle(actual: SceneLayoutState, expected: Oracle, heights = new Map<string, number>()) {
  expect(actual.grid).toEqual(expected.grid);
  expect(actual.previousIds).toEqual(expected.ids);
  expect(actual.columnCount).toBe(expected.columns);
  expect(actual.chainOrder).toEqual(expected.chain);
  for (const [id, placement] of expected.grid) {
    expect(actual.engineBoxes.get(id)).toEqual({
      x: 16 + placement.col * 376, y: 16 + placement.y, width: 360,
      height: heights.get(id) ?? DEFAULT_CARD_HEIGHT,
    });
  }
}

function seeded(cards: readonly Card[], grid: Map<string, Placement>, columns: number): SceneLayoutState {
  const state = updateSceneLayout(createSceneLayout(), items(cards), new Map(), viewport(columns));
  const boxes = new Map([...grid].map(([id, p]) => [id, { x: 16 + p.col * 376, y: 16 + p.y, width: 360, height: DEFAULT_CARD_HEIGHT }]));
  return { ...state, grid, boxes, engineBoxes: new Map(boxes) };
}

describe('V2 sceneのAPI検出と互換入口', () => {
  it('能力がなければDOMを選び、nativeのAPI世代を分ける', () => {
    expect(detectCanvasMode({} as HTMLCanvasElement, null)).toBe('dom');
    expect(detectCanvasMode({ requestPaint() {} } as unknown as HTMLCanvasElement, {} as CanvasRenderingContext2D)).toBe('dom');
    const ctx = { drawElementImage() {} } as unknown as CanvasRenderingContext2D;
    expect(detectCanvasMode({ requestPaint() {} } as unknown as HTMLCanvasElement, ctx)).toBe('legacy');
    expect(detectCanvasMode({ requestPaint() {}, content: '' } as unknown as HTMLCanvasElement, ctx)).toBe('modern');
  });

  it('メタデータなしのlabと互換入口もV1配置を通る', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const cards = ids.map((id, index) => note(id, ids.length - index, `scene:${id}`));
    const expected = buildInitialLayout(cards, 2, new Map());
    const result = planSceneLayout(ids, new Map(), 800, new Map());
    expect(result.grid).toEqual(expected.grid);
    expect(layoutScene(ids, new Map(), 800, new Map())).toEqual(result.boxes);
    const next = updateSceneLayout(result, ['new', ...ids].map(id => ({ id })), new Map(), 800);
    expect(next.grid.get('new')).toEqual({ col: 0, y: 0 });
  });
});

describe('V1の初期配置・引力とV2の挿入後一括reflowを合わせるadapter', () => {
  it.each([1, 2, 3])('%i列の初期配置は高さではなくV1のスコア配分に一致する', columns => {
    const cards = base();
    const heights = new Map([['a', 700], ['b', 40], ['c', 310], ['d', 91]]);
    const result = updateSceneLayout(createSceneLayout(), items(cards), heights, viewport(columns));
    expectOracle(result, oracleStep(emptyOracle(), cards, columns, heights), heights);
    if (columns === 2) {
      expect(result.grid.get('a')).toEqual({ col: 1, y: 0 });
      expect(result.grid.get('b')).toEqual({ col: 0, y: 0 });
      expect(result.grid.get('d')).toEqual({ col: 0, y: 40 + GAP });
    }
    expect(result.boxes).toEqual(result.engineBoxes);
  });

  it('同スコアの並びと左優先の同点処理もV1に一致する', () => {
    const cards = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => note(id, 1));
    const result = updateSceneLayout(createSceneLayout(), items(cards), new Map(), 1200);
    expectOracle(result, oracleStep(emptyOracle(), cards, 3));
    expect(result.grid.get('f')).toEqual({ col: 0, y: 0 });
    expect(result.grid.get('e')).toEqual({ col: 1, y: 0 });
    expect(result.grid.get('d')).toEqual({ col: 2, y: 0 });
  });

  it('同一pubkeyの新着は関連カードの列へ入り、無関係なら左列へ入る', () => {
    const cards = base();
    const first = updateSceneLayout(createSceneLayout(), items(cards), new Map(), 800);
    const initialOracle = oracleStep(emptyOracle(), cards, 2);
    for (const pubkey of ['a', 'unrelated']) {
      const nextCards = [note('new', 1, pubkey), ...cards];
      const result = updateSceneLayout(first, items(nextCards), new Map(), 800);
      expectOracle(result, oracleStep(initialOracle, nextCards, 2));
      expect(result.grid.get('new')).toEqual({ col: pubkey === 'a' ? 1 : 0, y: 0 });
      expect(result.chainOrder.size).toBeGreaterThan(1);
    }
  });

  it('押し出し先にもpubkeyの引力を適用し、下と隣列の候補をV1と同じように選ぶ', () => {
    const cards = [note('victim', 50, 'shared'), note('related', 30, 'shared'), note('below', 10), note('adj', 10)];
    const grid = new Map([
      ['victim', { col: 1, y: 0 }], ['below', { col: 1, y: 132 }],
      ['related', { col: 1, y: 264 }], ['adj', { col: 0, y: 0 }],
    ]);
    const first = seeded(cards, grid, 3);
    const nextCards = [note('new', 200, 'shared'), ...cards];
    const expected = oracleStep({ grid, ids: first.previousIds, columns: 3, chain: new Map() }, nextCards, 3);
    const result = updateSceneLayout(first, items(nextCards), new Map(), 1200);
    expectOracle(result, expected);
    expect(result.grid.get('new')).toEqual({ col: 1, y: 0 });
    expect(result.grid.get('victim')).toEqual({ col: 1, y: 132 });
    expect(result.grid.get('adj')).toEqual(grid.get('adj'));
  });

  it('compose/threadを含むCardのpubkeyを使い、引用タグやリポスト者を新しい引力条件にしない', () => {
    const cards = base();
    const first = updateSceneLayout(createSceneLayout(), items(cards), new Map(), 800);
    const compose: Card = { type: 'compose', slotId: 'compose', pubkey: 'a', score: 1, created_at: 0, quotedEvent: { eventId: 'event-b', pubkey: 'b' } };
    const thread: Card = { type: 'thread', slotId: 'thread', pubkey: 'a', score: 1, created_at: 0, notes: [], eventIds: new Set(['thread-event']) };
    const quote: Card = { ...note('quote', 1, 'unrelated'), tags: [['q', 'event-a']], repostInfo: { reposterPubkey: 'a', repostedAt: 10 } };
    for (const incoming of [compose, thread, quote]) {
      const nextCards = [incoming, ...cards];
      const result = updateSceneLayout(first, items(nextCards), new Map(), 800);
      expectOracle(result, oracleStep(oracleStep(emptyOracle(), cards, 2), nextCards, 2));
      expect(result.grid.get(incoming.slotId)!.col).toBe(incoming.pubkey === 'a' ? 1 : 0);
    }
  });

  it('同時到着はV1同様に入力順で一枚ずつ挿入し、最後の挿入が先頭になる', () => {
    const cards = [note('a', 3), note('b', 2)];
    const first = updateSceneLayout(createSceneLayout(), items(cards), new Map(), 400);
    const nextCards = [note('new1', 5), note('new2', 4), ...cards];
    const result = updateSceneLayout(first, items(nextCards), new Map(), 400);
    expectOracle(result, oracleStep(oracleStep(emptyOracle(), cards, 1), nextCards, 1));
    expect(result.grid.get('new2')!.y).toBe(0);
    expect(result.grid.get('new1')!.y).toBe(132);
    expect(result.chainOrder.get('new1')).toBe(1);
    expect(result.chainOrder.get('new2')).toBe(0);
  });

  it('高さ変更・削除・スコアのみの変更は列と旧y順を維持し直前の連鎖を保持する', () => {
    let cards = base();
    let expected = oracleStep(emptyOracle(), cards, 2);
    let state = updateSceneLayout(createSceneLayout(), items(cards), new Map(), 800);
    cards = [note('new', 1, 'a'), ...cards];
    expected = oracleStep(expected, cards, 2);
    state = updateSceneLayout(state, items(cards), new Map(), 800);
    const chain = new Map(state.chainOrder);
    const heights = new Map([['a', 350], ['new', 80]]);
    expected = oracleStep(expected, cards, 2, heights);
    state = updateSceneLayout(state, items(cards), heights, 800);
    expectOracle(state, expected, heights);
    cards = cards.filter(card => card.slotId !== 'b').reverse().map((card, index) => ({ ...card, score: 10 - index }));
    expected = oracleStep(expected, cards, 2, heights);
    state = updateSceneLayout(state, items(cards), heights, 800);
    expectOracle(state, expected, heights);
    expect(state.chainOrder).toEqual(chain);
    expect(state.grid.has('b')).toBe(false);
  });

  it('削除と挿入が同時ならV1同様に挿入を処理してから削除スロットを除く', () => {
    const cards = base();
    const first = updateSceneLayout(createSceneLayout(), items(cards), new Map(), 800);
    const nextCards = [note('new', 1, 'a'), ...cards.filter(card => card.slotId !== 'b')];
    const heights = new Map([['new', 300], ['c', 60]]);
    const result = updateSceneLayout(first, items(nextCards), heights, 800);
    expectOracle(result, oracleStep(oracleStep(emptyOracle(), cards, 2), nextCards, 2, heights), heights);
    expect(result.grid.has('b')).toBe(false);
  });

  it('列数変更時はスコア初期配置を再実行して連鎖をリセットする', () => {
    let cards = base();
    let state = updateSceneLayout(createSceneLayout(), items(cards), new Map(), 800);
    cards = [note('new', 1), ...cards];
    state = updateSceneLayout(state, items(cards), new Map(), 800);
    expect(state.chainOrder.size).toBeGreaterThan(0);
    const resized = updateSceneLayout(state, items(cards), new Map(), 1200);
    expectOracle(resized, oracleStep(emptyOracle(), cards, 3));
    expect(resized.chainOrder.size).toBe(0);
  });

  it('同じ列数で横幅だけ変えても論理配置と連鎖は変えない', () => {
    const cards = [note('a', 3), note('b', 2)];
    let state = updateSceneLayout(createSceneLayout(), items(cards), new Map(), 400);
    const nextCards = [note('new', 4), ...cards];
    state = updateSceneLayout(state, items(nextCards), new Map(), 400);
    const resized = updateSceneLayout(state, items(nextCards), new Map(), 340);
    expect(resized.grid).toEqual(state.grid);
    expect(resized.chainOrder).toEqual(state.chainOrder);
    expect(resized.boxes.get('a')!.width).toBe(308);
  });

  it('再描画やrenderer切替だけではinsert直後のgridをreflowせずstateを維持する', () => {
    const cards = base();
    const first = updateSceneLayout(createSceneLayout(), items(cards), new Map(), 800);
    const nextCards = [note('new', 1, 'a'), ...cards];
    const inserted = updateSceneLayout(first, items(nextCards), new Map(), 800);
    const unchanged = updateSceneLayout(inserted, items(nextCards), new Map(), 800, new Set(), new Map(inserted.boxes));
    expect(unchanged).toBe(inserted);
    expect(unchanged.grid).toBe(inserted.grid);
  });

  it('同じslotでdraftを投稿へ差し替えても新規挿入にはしない', () => {
    const draft: Card = { type: 'compose', slotId: 'stable', pubkey: 'owner', score: 10, created_at: 0 };
    const cards = [draft, ...base()];
    const first = updateSceneLayout(createSceneLayout(), items(cards), new Map(), 800);
    const published = [note('stable', 10, 'owner'), ...cards.slice(1)];
    const result = updateSceneLayout(first, items(published), new Map(), 800);
    expectOracle(result, oracleStep(oracleStep(emptyOracle(), cards, 2), published, 2));
    expect(result.grid).toEqual(first.grid);
    expect(result.chainOrder.size).toBe(0);
  });

  it('holdだけの変更はV1のreflowを通し、表示は実座標・幅を別管理する', () => {
    const cards = [note('a', 3), note('b', 2), note('c', 1)];
    let expected = oracleStep(emptyOracle(), cards, 1);
    const first = updateSceneLayout(createSceneLayout(), items(cards), new Map(), 400);
    const actual = new Map(first.boxes);
    actual.set('b', { ...actual.get('b')!, x: 21, y: 80, width: 340 });
    const held = new Set(['b']);
    expected = oracleStep(expected, cards, 1, new Map(), held);
    let state = updateSceneLayout(first, items(cards), new Map(), 400, held, actual);
    expectOracle(state, expected);
    expect(state.boxes.get('b')).toEqual(actual.get('b'));
    const heights = new Map([['a', 500]]);
    expected = oracleStep(expected, cards, 1, heights, held);
    state = updateSceneLayout(state, items(cards), heights, 400, held, state.boxes);
    expectOracle(state, expected, heights);
    expect(state.engineBoxes.get('b')!.y).toBe(528);
    expect(state.boxes.get('b')!.y).toBe(80);
    const nextCards = [note('new', 4), ...cards];
    expected = oracleStep(expected, nextCards, 1, heights, held);
    state = updateSceneLayout(state, items(nextCards), heights, 400, held, state.boxes);
    expectOracle(state, expected, heights);
    expect(state.boxes.get('b')!.y).toBe(80);
    const released = updateSceneLayout(state, items(nextCards), heights, 400);
    expectOracle(released, oracleStep(expected, nextCards, 1, heights), heights);
    expect(released.boxes).toEqual(released.engineBoxes);
    expect(released.frozenBoxes.size).toBe(0);
  });

  it('列数変更は論理配置を再構築し、V2既存の実表示holdを保持する', () => {
    const cards = base();
    let state = updateSceneLayout(createSceneLayout(), items(cards), new Map(), 800);
    const held = new Set(['a']);
    state = updateSceneLayout(state, items(cards), new Map(), 800, held);
    const frozen = state.boxes.get('a');
    const resized = updateSceneLayout(state, items(cards), new Map(), 400, held);
    expectOracle(resized, oracleStep(emptyOracle(), cards, 1));
    expect(resized.boxes.get('a')).toEqual(frozen);
    expect(resized.engineBoxes.get('a')!.x).toBe(16);
  });

  it('隣列のhold同士を迂回してもV1と同じ位置へ有限回で配置できる', () => {
    const cards = [note('lower-a', 10), note('lower-b', 10), note('a', 0), note('b', 0)];
    const grid = new Map([
      ['a', { col: 0, y: 0 }], ['b', { col: 1, y: 0 }],
      ['lower-a', { col: 0, y: 132 }], ['lower-b', { col: 1, y: 132 }],
    ]);
    const first = seeded(cards, grid, 2);
    const held = new Set(['a', 'b']);
    const nextCards = [note('new', 20), ...cards];
    const result = updateSceneLayout(first, items(nextCards), new Map(), 800, held);
    expectOracle(result, oracleStep({ grid, ids: first.previousIds, columns: 2, chain: new Map() }, nextCards, 2, new Map(), held));
    expect(result.grid.get('a')).toEqual(grid.get('a'));
    expect(result.grid.get('b')).toEqual(grid.get('b'));
    expect(result.grid.size).toBe(5);
  });

  it('入力のCard・heightMap・grid・表示Boxを変更しない', () => {
    const cards = base();
    const first = updateSceneLayout(createSceneLayout(), items(cards), new Map(), 800);
    for (const placement of first.grid.values()) Object.freeze(placement);
    for (const box of first.boxes.values()) Object.freeze(box);
    for (const card of cards) Object.freeze(card);
    const snapshot = structuredClone({ grid: first.grid, boxes: first.boxes });
    const heights = new Map([['a', 420]]);
    const nextCards = [note('new', 1, 'a'), ...cards];
    const result = updateSceneLayout(first, items(nextCards), heights, 800, new Set(['a']));
    expect(first.grid).toEqual(snapshot.grid);
    expect(first.boxes).toEqual(snapshot.boxes);
    expect(heights).toEqual(new Map([['a', 420]]));
    expect(result.grid).not.toBe(first.grid);
    expect(result.boxes.get('a')).not.toBe(first.boxes.get('a'));
  });

  it('200枚を含む連続更新も引力の連鎖と隙間のない最終gridを維持する', () => {
    let cards: Card[] = Array.from({ length: 180 }, (_, index) => note(`old-${index}`, 180 - index, `author-${index % 7}`));
    const heights = new Map(cards.map((card, index) => [card.slotId, 50 + index * 37 % 320]));
    let state = updateSceneLayout(createSceneLayout(), items(cards), heights, 1200);
    let expected = oracleStep(emptyOracle(), cards, 3, heights);
    for (let index = 0; index < 20; index++) {
      const incoming = note(`new-${index}`, 200 + index, `author-${index % 7}`);
      cards = [incoming, ...cards];
      heights.set(incoming.slotId, 70 + index * 67 % 390);
      state = updateSceneLayout(state, items(cards), heights, 1200);
      expected = oracleStep(expected, cards, 3, heights);
      expectOracle(state, expected, heights);
    }
    expect(state.grid.size).toBe(200);
  });
});
