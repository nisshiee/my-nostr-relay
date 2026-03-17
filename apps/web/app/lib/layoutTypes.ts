/** カード1枚の配置座標 */
export interface Placement {
  col: number;
  y: number;
}

/**
 * グリッド全体の配置状態。
 * カードID → Placement の不変マップ。
 * エンジンの入力にも出力にもなる中心的な型。
 */
export type Grid = ReadonlyMap<string, Placement>;

/**
 * 列ごとのカードスロット。
 * エンジン内部の作業用構造。Grid との相互変換ヘルパーで生成する。
 * columns[colIndex] = そのカラムに属するカードの配列（y昇順）。
 */
export type ColumnSlots = { id: string; y: number }[][];

/**
 * 押し出し連鎖（DisplaceChain）の結果。
 * placeCard 1回の呼び出しで発生した全移動を記録する。
 */
export interface DisplaceChain {
  /** 連鎖で移動したカードID（挿入されたカード自身を含む）の順序付きリスト */
  movedIds: ReadonlySet<string>;
  /**
   * 各カードの連鎖順序。
   * key=カードID, value=0始まりの連鎖ステップ番号。
   * React側でこれを DOMINO_DELAY 倍してアニメーション遅延に変換する。
   */
  chainOrder: ReadonlyMap<string, number>;
}

/**
 * 配置エンジンの出力。
 * すべてのエンジン関数がこの型を返す。
 */
export interface LayoutResult {
  grid: Grid;
  /** 連鎖情報。初期配置・高さ変更時は空（chainOrder.size === 0） */
  chain: DisplaceChain;
}
