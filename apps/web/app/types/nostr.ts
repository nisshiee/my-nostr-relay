/** NIP-07 ブラウザ拡張の型定義 */

export interface NostrEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  pubkey?: string;
  id?: string;
  sig?: string;
}

export type SignedNostrEvent = NostrEvent & {
  id: string;
  sig: string;
  pubkey: string;
};

declare global {
  interface Nostr {
    /** window.nostr.js が提供する署名器かどうか */
    isWnj?: boolean;
    getPublicKey(): Promise<string>;
    signEvent(event: NostrEvent): Promise<SignedNostrEvent>;
  }
  interface Window {
    nostr?: Nostr;
  }
}

export type { Nostr };
