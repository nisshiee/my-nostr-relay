/** カード共通フィールド */
interface CardBase {
  /** カードの配置スロットID（UUID）。レイアウト・heightMap等はこのIDで管理する */
  slotId: string;
  pubkey: string;
  score: number;
  /** フェードアウト中かどうか */
  fadingOut: boolean;
  /** スコア計算用のタイムスタンプ（Unix timestamp、秒） */
  created_at: number;
}

/** リレーから届いたノートカード */
export interface NoteCard extends CardBase {
  type: "note";
  /** NostrイベントID */
  eventId: string;
  content: string;
}

/** 投稿カード（下書き） */
export interface ComposeCard extends CardBase {
  type: "compose";
}

/** キャンバス上に配置されるカード（Discriminated Union） */
export type Card = NoteCard | ComposeCard;

/** リアクション集計: eventId → (絵文字 → 件数) のマッピング */
export type Reactions = Map<string, Map<string, number>>;

/** プロフィール情報 */
export interface NostrProfile {
  name?: string;
  display_name?: string;
  picture?: string;
  about?: string;
  nip05?: string;
}
