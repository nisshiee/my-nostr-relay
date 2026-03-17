/** ブートストラップリレー群（kind:10002/kind:3取得用） */
export const BOOTSTRAP_RELAYS = [
  "wss://relay.nostr.nisshiee.org",  // 自分のリレー（最優先）
  "wss://yabu.me",                    // 日本アグリゲーター
  "wss://relay.nostr.band",           // 海外アグリゲーター（スパム少）
  "wss://nos.lol",                    // 海外大手
  "wss://relay.damus.io",             // Damus公式リレー
];

/** EOSEタイムアウト（ms）。リレーからEOSEが返らない場合にこの時間で打ち切る */
export const EOSE_TIMEOUT = 4000;

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

/** 未測定カードのデフォルト高さ推定値（px） */
export const DEFAULT_CARD_HEIGHT = 120;

/** カード間の縦方向ギャップ（px）— mb-3 相当 */
export const GAP = 12;

/** カラム間の横方向ギャップ（px）— gap-4 相当 */
export const COLUMN_GAP = 16;

/** ドミノアニメーションの1ステップあたりの遅延（秒） */
export const DOMINO_DELAY = 0.1;

/** リアクション再subscribe間隔（ms） */
export const REACTION_POLL_INTERVAL = 30_000;

/** リアクションsubscribeのsince安全マージン（秒） */
export const REACTION_SINCE_SAFETY_MARGIN = 10;
