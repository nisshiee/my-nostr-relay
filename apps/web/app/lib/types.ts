/** キャンバス上に表示するノートの型 */
export interface CanvasNote {
  id: string;
  pubkey: string;
  content: string;
  created_at: number; // Unix timestamp
  score: number;
  /** フェードアウト中かどうか */
  fadingOut: boolean;
}

/** プロフィール情報 */
export interface NostrProfile {
  name?: string;
  display_name?: string;
  picture?: string;
  about?: string;
  nip05?: string;
}
