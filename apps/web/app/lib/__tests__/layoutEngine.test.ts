import { placeCard, gridToColumns } from "../../store/pure/layoutEngine";
import { GAP, DEFAULT_CARD_HEIGHT } from "../constants";

describe("placeCard - 隣列の場合は上優先ロジック", () => {
  // テスト用のヘルパー関数
  function createTestSetup(columnCount: number = 3) {
    const grid = new Map<string, { col: number; y: number }>();
    const heightMap = new Map<string, number>();
    const scoreMap = new Map<string, number>();
    const chain = { movedIds: new Set<string>(), chainOrder: new Map<string, number>() };
    const holdSet = new Set<string>();

    // デフォルトの高さを設定
    const setCard = (id: string, col: number, y: number, height: number = DEFAULT_CARD_HEIGHT, score: number = 0) => {
      grid.set(id, { col, y });
      heightMap.set(id, height);
      scoreMap.set(id, score);
    };

    return { grid, heightMap, scoreMap, chain, holdSet, setCard, columnCount };
  }

  test("隣の列に複数候補がある場合、最低スコアではなく一番上が選ばれる", () => {
    const { grid, heightMap, scoreMap, chain, holdSet, setCard, columnCount } = createTestSetup();

    // victim: col=0, y=0, score=100
    setCard("victim", 0, 0, DEFAULT_CARD_HEIGHT, 100);
    
    // col=0のvictimの下にカードを置く（isBottomOfColumn=falseにするため）
    setCard("lower", 0, DEFAULT_CARD_HEIGHT + GAP, DEFAULT_CARD_HEIGHT, 50);
    
    // col=1に候補A: y=0, score=30 と 候補B: y=120+GAP, score=10 がある
    setCard("A", 1, 0, DEFAULT_CARD_HEIGHT, 30);
    setCard("B", 1, DEFAULT_CARD_HEIGHT + GAP, DEFAULT_CARD_HEIGHT, 10);

    const columns = gridToColumns(grid, columnCount);

    // 新カード "new" をvictimの位置に配置して押し出しを発生させる
    placeCard(grid, columns, "new", 0, 0, heightMap, scoreMap, columnCount, chain, holdSet);

    // victimの移動先を確認
    // bestはscore=10のBだが、Bは隣列にいるので変更候補を探す
    // 変更候補: AとB（両方victimのscore=100以下）
    // 結果: yが最小のA（y=0）が押し出し先になる
    expect(grid.get("victim")).toEqual({ col: 1, y: 0 });
  });

  test("victimのスコアより高いカードは変更候補にならない", () => {
    const { grid, heightMap, scoreMap, chain, holdSet, setCard, columnCount } = createTestSetup();

    // victim: score=20
    setCard("victim", 0, 0, DEFAULT_CARD_HEIGHT, 20);
    
    // col=0のvictimの下にカードを置く（isBottomOfColumn=falseにするため）
    setCard("lower", 0, DEFAULT_CARD_HEIGHT + GAP, DEFAULT_CARD_HEIGHT, 50);
    
    // col=1に候補A: y=0, score=50（victimより高い→変更候補外）と 候補B: y=20, score=5（victimとオーバーラップ、best）
    setCard("A", 1, 0, DEFAULT_CARD_HEIGHT, 50);
    setCard("B", 1, 20, DEFAULT_CARD_HEIGHT, 5); // victimとy座標が重なるように調整

    const columns = gridToColumns(grid, columnCount);

    // 新カード "new" をvictimの位置に配置して押し出しを発生させる
    placeCard(grid, columns, "new", 0, 0, heightMap, scoreMap, columnCount, chain, holdSet);

    // victimの移動先を確認
    // bestはBで隣列。変更候補はBのみ（Aはvictimのスコアをオーバーしてるため除外）
    // 結果: Bがそのまま押し出し先
    expect(grid.get("victim")).toEqual({ col: 1, y: 20 });
  });

  test("最低スコアのカードが同じ列にある場合は変更が発動しない", () => {
    const { grid, heightMap, scoreMap, chain, holdSet, setCard, columnCount } = createTestSetup();

    // victim: col=1, y=0, score=100
    setCard("victim", 1, 0, DEFAULT_CARD_HEIGHT, 100);
    
    // col=1の直下にカードC: y=120+GAP, score=5（best、同じ列）
    setCard("C", 1, DEFAULT_CARD_HEIGHT + GAP, DEFAULT_CARD_HEIGHT, 5);
    
    // col=2に候補D: y=0, score=30
    setCard("D", 2, 0, DEFAULT_CARD_HEIGHT, 30);

    const columns = gridToColumns(grid, columnCount);

    // 新カード "new" をvictimの位置に配置して押し出しを発生させる
    placeCard(grid, columns, "new", 1, 0, heightMap, scoreMap, columnCount, chain, holdSet);

    // victimの移動先を確認
    // bestはCで同じ列なので変更ロジックは発動しない
    // 結果: Cが押し出し先
    expect(grid.get("victim")).toEqual({ col: 1, y: DEFAULT_CARD_HEIGHT + GAP });
  });
});