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
  /** Nostrイベント署名（リポスト時のcontent構築に必要） */
  sig?: string;
  content: string;
  /** Nostrイベントのタグ配列 */
  tags: string[][];
  /** リポスト情報（リポスト経由で表示される場合に設定） */
  repostInfo?: {
    /** 最後にリポストした人のpubkey */
    reposterPubkey: string;
    /** 最終リポスト時刻（Unix timestamp、秒） */
    repostedAt: number;
  };
}

/** 投稿カード（下書き） */
export interface ComposeCard extends CardBase {
  type: "compose";
}

/** スレッド内の個別ノート */
export interface ThreadNote {
  eventId: string;
  pubkey: string;
  content: string;
  created_at: number;
  tags: string[][];
  /** 直接の返信先（最後の e タグから取得）。歯抜けの場合は undefined */
  replyTo?: { eventId: string; pubkey?: string };
}

/** リプライスレッドカード */
export interface ThreadCard extends CardBase {
  type: "thread";
  /** スレッド内のノート（created_at 順） */
  notes: ThreadNote[];
  /** スレッドに含まれる全 eventId の集合（マージ判定に使用） */
  eventIds: Set<string>;
}

/** キャンバス上に配置されるカード（Discriminated Union） */
export type Card = NoteCard | ComposeCard | ThreadCard;

/** リアクション集計: eventId → (絵文字 → {件数, 画像URL, 送信者pubkey集合}) のマッピング */
export type Reactions = Map<string, Map<string, { count: number; imageUrl?: string; pubkeys: Set<string> }>>;

/** プロフィール情報 */
export interface NostrProfile {
  name?: string;
  display_name?: string;
  picture?: string;
  about?: string;
  nip05?: string;
}
