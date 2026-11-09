import { describe, expect, test } from "vitest";
import { placeCard, gridToColumns, insertCard, buildInitialLayout, reflow } from "../layoutEngine";
import { GAP, DEFAULT_CARD_HEIGHT } from "../constants";
import type { Card } from "../types";

/** テスト用のNoteCardを作成するヘルパー */
function makeCard(id: string, score: number = 0, pubkey: string = "default-pubkey"): Card {
  return {
    type: "note",
    slotId: id,
    pubkey,
    score,
    created_at: 0,
    eventId: id,
    content: "",
    tags: [],
  };
}

describe("placeCard - 隣列の場合は上優先ロジック", () => {
  // テスト用のヘルパー関数
  function createTestSetup(columnCount: number = 3) {
    const grid = new Map<string, { col: number; y: number }>();
    const heightMap = new Map<string, number>();
    const scoreMap = new Map<string, number>();
    const chain = { movedIds: new Set<string>(), chainOrder: new Map<string, number>() };
    const holdSet = new Set<string>();
    const allCards: Card[] = [];

    const setCard = (id: string, col: number, y: number, height: number = DEFAULT_CARD_HEIGHT, score: number = 0, pubkey: string = "default-pubkey") => {
      grid.set(id, { col, y });
      heightMap.set(id, height);
      scoreMap.set(id, score);
      const existingIndex = allCards.findIndex(c => c.slotId === id);
      const card = makeCard(id, score, pubkey);
      if (existingIndex >= 0) {
        allCards[existingIndex] = card;
      } else {
        allCards.push(card);
      }
    };

    return { grid, heightMap, scoreMap, chain, holdSet, setCard, columnCount, allCards };
  }

  test("隣の列に複数候補がある場合、最低スコアではなく一番上が選ばれる", () => {
    const { grid, heightMap, scoreMap, chain, holdSet, setCard, columnCount, allCards } = createTestSetup();

    // victim: col=0, y=0, score=100
    setCard("victim", 0, 0, DEFAULT_CARD_HEIGHT, 100);
    
    // col=0のvictimの下にカードを置く（isBottomOfColumn=falseにするため）
    setCard("lower", 0, DEFAULT_CARD_HEIGHT + GAP, DEFAULT_CARD_HEIGHT, 50);
    
    // col=1に候補A: y=0, score=30 と 候補B: y=120+GAP, score=10 がある
    setCard("A", 1, 0, DEFAULT_CARD_HEIGHT, 30);
    setCard("B", 1, DEFAULT_CARD_HEIGHT + GAP, DEFAULT_CARD_HEIGHT, 10);

    // 新カード
    allCards.push(makeCard("new", 200));

    const columns = gridToColumns(grid, columnCount);

    // 新カード "new" をvictimの位置に配置して押し出しを発生させる
    placeCard(grid, columns, "new", 0, 0, heightMap, scoreMap, columnCount, chain, holdSet, allCards);

    // victimの移動先を確認
    // bestはscore=10のBだが、Bは隣列にいるので変更候補を探す
    // 変更候補: AとB（両方victimのscore=100以下）
    // 結果: yが最小のA（y=0）が押し出し先になる
    expect(grid.get("victim")).toEqual({ col: 1, y: 0 });
  });

  test("victimのスコアより高いカードは変更候補にならない", () => {
    const { grid, heightMap, scoreMap, chain, holdSet, setCard, columnCount, allCards } = createTestSetup();

    // victim: score=20
    setCard("victim", 0, 0, DEFAULT_CARD_HEIGHT, 20);
    
    // col=0のvictimの下にカードを置く（isBottomOfColumn=falseにするため）
    setCard("lower", 0, DEFAULT_CARD_HEIGHT + GAP, DEFAULT_CARD_HEIGHT, 50);
    
    // col=1に候補A: y=0, score=50（victimより高い→変更候補外）と 候補B: y=20, score=5（victimとオーバーラップ、best）
    setCard("A", 1, 0, DEFAULT_CARD_HEIGHT, 50);
    setCard("B", 1, 20, DEFAULT_CARD_HEIGHT, 5); // victimとy座標が重なるように調整

    // 新カード
    allCards.push(makeCard("new", 200));

    const columns = gridToColumns(grid, columnCount);

    // 新カード "new" をvictimの位置に配置して押し出しを発生させる
    placeCard(grid, columns, "new", 0, 0, heightMap, scoreMap, columnCount, chain, holdSet, allCards);

    // victimの移動先を確認
    // bestはBで隣列。変更候補はBのみ（Aはvictimのスコアをオーバーしてるため除外）
    // 結果: Bがそのまま押し出し先
    expect(grid.get("victim")).toEqual({ col: 1, y: 20 });
  });

  test("最低スコアのカードが同じ列にある場合は変更が発動しない", () => {
    const { grid, heightMap, scoreMap, chain, holdSet, setCard, columnCount, allCards } = createTestSetup();

    // victim: col=1, y=0, score=100
    setCard("victim", 1, 0, DEFAULT_CARD_HEIGHT, 100);
    
    // col=1の直下にカードC: y=120+GAP, score=5（best、同じ列）
    setCard("C", 1, DEFAULT_CARD_HEIGHT + GAP, DEFAULT_CARD_HEIGHT, 5);
    
    // col=2に候補D: y=0, score=30
    setCard("D", 2, 0, DEFAULT_CARD_HEIGHT, 30);

    // 新カード
    allCards.push(makeCard("new", 200));

    const columns = gridToColumns(grid, columnCount);

    // 新カード "new" をvictimの位置に配置して押し出しを発生させる
    placeCard(grid, columns, "new", 1, 0, heightMap, scoreMap, columnCount, chain, holdSet, allCards);

    // victimの移動先を確認
    // bestはCで同じ列なので変更ロジックは発動しない
    // 結果: Cが押し出し先
    expect(grid.get("victim")).toEqual({ col: 1, y: DEFAULT_CARD_HEIGHT + GAP });
  });
});

describe("placeCard - gravity統合", () => {
  function createTestSetup(columnCount: number = 3) {
    const grid = new Map<string, { col: number; y: number }>();
    const heightMap = new Map<string, number>();
    const scoreMap = new Map<string, number>();
    const chain = { movedIds: new Set<string>(), chainOrder: new Map<string, number>() };
    const holdSet = new Set<string>();
    const allCards: Card[] = [];

    const setCard = (id: string, col: number, y: number, height: number = DEFAULT_CARD_HEIGHT, score: number = 0, pubkey: string = "default-pubkey") => {
      grid.set(id, { col, y });
      heightMap.set(id, height);
      scoreMap.set(id, score);
      const existingIndex = allCards.findIndex(c => c.slotId === id);
      const card = makeCard(id, score, pubkey);
      if (existingIndex >= 0) {
        allCards[existingIndex] = card;
      } else {
        allCards.push(card);
      }
    };

    return { grid, heightMap, scoreMap, chain, holdSet, setCard, columnCount, allCards };
  }

  test("同一pubkeyカードの近くへの移動はgravityCostにより優先される", () => {
    const { grid, heightMap, scoreMap, chain, holdSet, setCard, columnCount, allCards } = createTestSetup();

    // victim: col=1, y=0, score=50, pubkey="pk-A"
    setCard("victim", 1, 0, DEFAULT_CARD_HEIGHT, 50, "pk-A");

    // 同じ列の直下候補（ステップ1a）: score=10
    setCard("below", 1, DEFAULT_CARD_HEIGHT + GAP, DEFAULT_CARD_HEIGHT, 10);

    // 同一pubkeyの関連カード: col=1の下方に配置（belowの近く）
    // → victimがbelowの位置に移動するとrelatedに近くなる
    setCard("related", 1, 2 * (DEFAULT_CARD_HEIGHT + GAP), DEFAULT_CARD_HEIGHT, 30, "pk-A");

    // 隣列候補（ステップ1b）: col=0, y=0, score=10（belowと同スコア）
    setCard("adj", 0, 0, DEFAULT_CARD_HEIGHT, 10);

    // 新カード（victimを押し出すために配置）
    allCards.push(makeCard("new", 200));

    const columns = gridToColumns(grid, columnCount);

    placeCard(grid, columns, "new", 1, 0, heightMap, scoreMap, columnCount, chain, holdSet, allCards);

    // gravityCost計算:
    // - victimがbelow位置(col=1, y=132)に移動 → related(col=1, y=264)との距離=133 → gravityCost≈-0.0075
    //   totalCost(below) = 10 + (-0.0075)*10 = 9.925
    // - victimがadj位置(col=0, y=0)に移動 → related(col=1, y=264)との距離≈416 → gravityCost≈-0.0024
    //   totalCost(adj) = 10 + (-0.0024)*10 = 9.976
    //
    // belowのtotalCostの方が低い → belowが選ばれる（victimはrelatedの方向に引っ張られる）
    expect(grid.get("victim")).toEqual({ col: 1, y: DEFAULT_CARD_HEIGHT + GAP });
  });
});

describe("insertCard - gravity列選択", () => {
  test("同一pubkeyのカードが列2にいる場合、新カードは列2のy=0に挿入される", () => {
    // 3列構成、列2に同一pubkeyのカードを配置
    const columnCount = 3;
    const heightMap = new Map<string, number>();
    const holdSet = new Set<string>();

    const existing = makeCard("existing", 10, "pk-shared");
    heightMap.set("existing", DEFAULT_CARD_HEIGHT);

    // 既存カードを列2に配置
    const prevGrid = new Map<string, { col: number; y: number }>();
    prevGrid.set("existing", { col: 2, y: 0 });

    // 同一pubkeyの新カードを挿入
    const newCard = makeCard("new", 20, "pk-shared");
    heightMap.set("new", DEFAULT_CARD_HEIGHT);

    const allNotes = [existing, newCard];

    const result = insertCard(prevGrid, newCard, allNotes, columnCount, heightMap, holdSet);

    // 結果: 列0ではなく列2のy=0に配置される（引力で列2が選ばれる）
    const placement = result.grid.get("new");
    expect(placement).toBeDefined();
    expect(placement!.col).toBe(2);
    expect(placement!.y).toBe(0);
  });

  test("関連カードがいない場合は列0に挿入される", () => {
    // 3列構成、全カードが異なるpubkey
    const columnCount = 3;
    const heightMap = new Map<string, number>();
    const holdSet = new Set<string>();

    const card1 = makeCard("card1", 10, "pk-A");
    const card2 = makeCard("card2", 10, "pk-B");
    heightMap.set("card1", DEFAULT_CARD_HEIGHT);
    heightMap.set("card2", DEFAULT_CARD_HEIGHT);

    const prevGrid = new Map<string, { col: number; y: number }>();
    prevGrid.set("card1", { col: 1, y: 0 });
    prevGrid.set("card2", { col: 2, y: 0 });

    // 異なるpubkeyの新カードを挿入
    const newCard = makeCard("new", 20, "pk-C");
    heightMap.set("new", DEFAULT_CARD_HEIGHT);

    const allNotes = [card1, card2, newCard];

    const result = insertCard(prevGrid, newCard, allNotes, columnCount, heightMap, holdSet);

    // 結果: 従来通り列0のy=0に配置される
    const placement = result.grid.get("new");
    expect(placement).toBeDefined();
    expect(placement!.col).toBe(0);
    expect(placement!.y).toBe(0);
  });
});


describe("レイアウトの公開契約", () => {
  function expectNoOverlap(grid: ReadonlyMap<string, { col: number; y: number }>, heights: ReadonlyMap<string, number>, columnCount: number) {
    for (const placement of grid.values()) {
      expect(Number.isInteger(placement.col)).toBe(true);
      expect(placement.col).toBeGreaterThanOrEqual(0);
      expect(placement.col).toBeLessThan(columnCount);
      expect(Number.isFinite(placement.y)).toBe(true);
      expect(placement.y).toBeGreaterThanOrEqual(0);
    }
    for (const column of gridToColumns(grid, columnCount)) {
      const ordered = [...column].sort((a, b) => a.y - b.y);
      for (let i = 1; i < ordered.length; i++) {
        expect(ordered[i].y).toBeGreaterThanOrEqual(
          ordered[i - 1].y + (heights.get(ordered[i - 1].id) ?? DEFAULT_CARD_HEIGHT) + GAP,
        );
      }
    }
  }

  test("隣列のホールド同士を迂回しても終了し、固定位置と入力を維持する", () => {
    const cards = [makeCard("a", 0, "a"), makeCard("b", 0, "b"), makeCard("lower-a", 10, "c"), makeCard("lower-b", 10, "d")];
    const step = DEFAULT_CARD_HEIGHT + GAP;
    const prevGrid = new Map([
      ["a", { col: 0, y: 0 }], ["b", { col: 1, y: 0 }],
      ["lower-a", { col: 0, y: step }], ["lower-b", { col: 1, y: step }],
    ]);
    const snapshot = structuredClone(prevGrid);
    const note = makeCard("new", 20, "new");
    const heights = new Map<string, number>();
    const held = new Set(["a", "b"]);
    const result = insertCard(prevGrid, note, [...cards, note], 2, heights, held);
    expect(prevGrid).toEqual(snapshot);
    expect(held).toEqual(new Set(["a", "b"]));
    expect(result.grid.size).toBe(5);
    expect(result.grid.get("a")).toEqual(prevGrid.get("a"));
    expect(result.grid.get("b")).toEqual(prevGrid.get("b"));
    expect(result.chain.movedIds.has("a")).toBe(false);
    expect(result.chain.movedIds.has("b")).toBe(false);
    expectNoOverlap(result.grid, heights, 2);
  });

  test("高さの異なるカードを挿入しても重ならず、既存の入力座標は変更しない", () => {
    const cards = [makeCard("a", 1, "a"), makeCard("b", 0, "b")];
    const heights = new Map([["a", 40], ["b", 60], ["new", 300]]);
    const prevGrid = buildInitialLayout(cards, 1, heights).grid;
    const snapshot = structuredClone(prevGrid);
    const note = makeCard("new", 2, "new");
    const result = insertCard(prevGrid, note, [...cards, note], 1, heights, new Set());
    expect(prevGrid).toEqual(snapshot);
    expect(result.grid.size).toBe(3);
    expectNoOverlap(result.grid, heights, 1);
    expect([...result.chain.chainOrder.values()]).toEqual([0, 1, 2]);
  });

  test("高さ補正はホールド領域を避け、重ならないカードは動かさない", () => {
    const cards = [makeCard("a", 2, "a"), makeCard("held", 1, "b"), makeCard("untouched", 0, "c")];
    const heights = new Map([["a", 40], ["held", 60], ["new", 300]]);
    const prevGrid = new Map([
      ["a", { col: 0, y: 0 }], ["held", { col: 0, y: 52 }],
      ["untouched", { col: 1, y: 1000 }],
    ]);
    const note = makeCard("new", 3, "new");
    const result = insertCard(prevGrid, note, [...cards, note], 2, heights, new Set(["held"]));
    expect(result.grid.get("held")).toEqual(prevGrid.get("held"));
    expect(result.grid.get("untouched")).toEqual(prevGrid.get("untouched"));
    expect(result.chain.movedIds.has("held")).toBe(false);
    expect(result.chain.movedIds.has("untouched")).toBe(false);
    expectNoOverlap(result.grid, heights, 2);
  });

  test.each([1, 2, 3])("%i列で高さとホールドの組み合わせを変えて連続挿入しても契約を維持する", (columnCount) => {
    for (const holdMode of ["none", "some", "all"] as const) {
      const cards = Array.from({ length: 12 }, (_, i) => makeCard(`card-${i}`, 12 - i, `author-${i % 3}`));
      const heights = new Map(cards.map((card, i) => [card.slotId, 20 + (i * 73) % 300]));
      let grid = buildInitialLayout(cards, columnCount, heights).grid;
      const held = new Set(cards.filter((_, i) => holdMode === "all" || (holdMode === "some" && i % 2 === 0)).map((card) => card.slotId));
      for (let i = 0; i < 8; i++) {
        const note = makeCard(`new-${i}`, 20 + i, `author-${i % 3}`);
        cards.push(note);
        heights.set(note.slotId, 30 + (i * 97) % 400);
        const snapshot = structuredClone(grid);
        const result = insertCard(grid, note, cards, columnCount, heights, held);
        expect(grid).toEqual(snapshot);
        expect(result.grid.size).toBe(cards.length);
        for (const id of held) {
          expect(result.grid.get(id)).toEqual(grid.get(id));
          expect(result.chain.movedIds.has(id)).toBe(false);
        }
        expect(new Set(result.chain.chainOrder.keys())).toEqual(result.chain.movedIds);
        expect([...result.chain.chainOrder.values()]).toEqual(Array.from({ length: result.chain.chainOrder.size }, (_, index) => index));
        expectNoOverlap(result.grid, heights, columnCount);
        grid = result.grid;
      }
    }
  });

  test("初期配置は入力を変更せず、reflowは列と旧y順を維持して削除と高さ変更を反映する", () => {
    const cards = [makeCard("a", 4), makeCard("b", 3), makeCard("c", 2), makeCard("d", 1)];
    const original = structuredClone(cards);
    const heights = new Map([["a", 40], ["b", 180]]);
    const initial = buildInitialLayout(cards, 2, heights);
    expect(cards).toEqual(original);
    expect(initial.chain.movedIds.size).toBe(0);
    expectNoOverlap(initial.grid, heights, 2);
    const snapshot = structuredClone(initial.grid);
    const active = [makeCard("d", 99), makeCard("b", 0), makeCard("a", -1), makeCard("unplaced", 200)];
    const updatedHeights = new Map([["a", 250], ["b", 80]]);
    const result = reflow(initial.grid, active, 2, updatedHeights);
    expect(initial.grid).toEqual(snapshot);
    expect(result.grid.has("c")).toBe(false);
    expect(result.grid.has("unplaced")).toBe(false);
    expect(result.chain.chainOrder.size).toBe(0);
    for (let col = 0; col < 2; col++) {
      const previousOrder = [...initial.grid].filter(([id, p]) => p.col === col && id !== "c").sort((a, b) => a[1].y - b[1].y).map(([id]) => id);
      const currentOrder = [...result.grid].filter(([, p]) => p.col === col).sort((a, b) => a[1].y - b[1].y).map(([id]) => id);
      expect(currentOrder).toEqual(previousOrder);
    }
    expectNoOverlap(result.grid, updatedHeights, 2);
  });
});
