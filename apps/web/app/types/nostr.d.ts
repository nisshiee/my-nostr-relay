/** NIP-07 ブラウザ拡張の型定義 */

interface NostrEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  pubkey?: string;
  id?: string;
  sig?: string;
}

interface Nostr {
  getPublicKey(): Promise<string>;
  signEvent(
    event: NostrEvent,
  ): Promise<NostrEvent & { id: string; sig: string; pubkey: string }>;
}

interface Window {
  nostr?: Nostr;
}
