/** リレーのWebSocket URL */
export const RELAY_URL = "wss://relay.nostr.nisshiee.org";

/** Masonryグリッドの1列幅目安（px） */
export const COLUMN_WIDTH = 320;

/** 新しさスコアの半減期（秒）。30分で半減 */
export const SCORE_HALF_LIFE = 1800;

/** このスコア以下でフェードアウト開始 */
export const FADEOUT_THRESHOLD = 0.05;

/** フェードアウトアニメーション時間（ms） */
export const FADEOUT_DURATION = 1000;

/** スコア再計算の間隔（ms） */
export const SCORE_UPDATE_INTERVAL = 10000;

/** メモリ管理のため保持するノート上限 */
export const MAX_NOTES = 200;

/** 初回ノート取得時のlimit */
export const INITIAL_NOTES_LIMIT = 500;
