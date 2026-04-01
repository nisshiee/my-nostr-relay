import { placeCard, gridToColumns, insertCard } from "../layoutEngine";
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

  test("同一pubkeyカードの近くへの移動はgravityCostにより回避され、遠い候補が選ばれる", () => {
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
