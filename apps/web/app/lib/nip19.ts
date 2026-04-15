/**
 * NIP-19 デコードユーティリティ
 *
 * Nostr の bech32 エンコードされた識別子（nevent, note, naddr）をデコードする。
 * nostr-tools の nip19 モジュールをラップし、型安全なインターフェースを提供する。
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/19.md
 */

import { nip19 } from "nostr-tools";

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

/** nevent デコード結果 */
export interface NeventData {
  eventId: string;
  relays?: string[];
  pubkey?: string;
  kind?: number;
}

/** note デコード結果 */
export interface NoteData {
  eventId: string;
}

/** naddr デコード結果 */
export interface NaddrData {
  kind: number;
  pubkey: string;
  d: string;
  relays?: string[];
}

/** parseNostrUri の返り値（discriminated union） */
export type NostrUriDecoded =
  | { type: "nevent"; data: NeventData }
  | { type: "note"; data: NoteData }
  | { type: "naddr"; data: NaddrData };

// ---------------------------------------------------------------------------
// デコード関数
// ---------------------------------------------------------------------------

/**
 * nevent1... 文字列をデコードする
 *
 * @param nevent bech32 エンコードされた nevent 文字列
 * @returns デコード結果。不正な入力の場合は null
 */
export function decodeNevent(nevent: string): NeventData | null {
  try {
    const decoded = nip19.decode(nevent);
    if (decoded.type !== "nevent") return null;

    const { id, relays, author, kind } = decoded.data;
    return {
      eventId: id,
      relays: relays && relays.length > 0 ? relays : undefined,
      pubkey: author ?? undefined,
      kind: kind ?? undefined,
    };
  } catch {
    return null;
  }
}

/**
 * note1... 文字列をデコードする
 *
 * @param note bech32 エンコードされた note 文字列
 * @returns デコード結果。不正な入力の場合は null
 */
export function decodeNote(note: string): NoteData | null {
  try {
    const decoded = nip19.decode(note);
    if (decoded.type !== "note") return null;

    return { eventId: decoded.data };
  } catch {
    return null;
  }
}

/**
 * naddr1... 文字列をデコードする
 *
 * @param naddr bech32 エンコードされた naddr 文字列
 * @returns デコード結果。不正な入力の場合は null
 */
export function decodeNaddr(naddr: string): NaddrData | null {
  try {
    const decoded = nip19.decode(naddr);
    if (decoded.type !== "naddr") return null;

    const { kind, pubkey, identifier, relays } = decoded.data;
    return {
      kind,
      pubkey,
      d: identifier,
      relays: relays && relays.length > 0 ? relays : undefined,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// エンコード関数
// ---------------------------------------------------------------------------

/**
 * eventId (と任意のpubkey) を nevent1... 文字列にエンコードする
 *
 * @param eventId hex形式のイベントID
 * @param pubkey hex形式のpubkey（オプション）
 * @returns bech32エンコードされた nevent 文字列
 */
export function encodeNevent(eventId: string, pubkey?: string): string {
  return nip19.neventEncode({
    id: eventId,
    ...(pubkey ? { author: pubkey } : {}),
  });
}

/**
 * pubkey を npub1... 文字列にエンコードする
 *
 * @param pubkey hex形式のpubkey
 * @returns bech32エンコードされた npub 文字列
 */
export function encodeNpub(pubkey: string): string {
  return nip19.npubEncode(pubkey);
}

/**
 * nostr: URI をパースしてデコード結果を返す
 *
 * 対応プレフィックス: nostr:nevent1..., nostr:note1..., nostr:naddr1...
 *
 * @param uri nostr: URI 文字列（例: "nostr:nevent1..."）
 * @returns デコード結果。不正な URI や未対応のタイプの場合は null
 */
export function parseNostrUri(uri: string): NostrUriDecoded | null {
  // nostr: プレフィックスを除去
  const match = uri.match(/^nostr:(.+)$/i);
  if (!match) return null;

  const bech32str = match[1];

  try {
    const decoded = nip19.decode(bech32str);

    switch (decoded.type) {
      case "nevent": {
        const { id, relays, author, kind } = decoded.data;
        return {
          type: "nevent",
          data: {
            eventId: id,
            relays: relays && relays.length > 0 ? relays : undefined,
            pubkey: author ?? undefined,
            kind: kind ?? undefined,
          },
        };
      }
      case "note":
        return {
          type: "note",
          data: { eventId: decoded.data },
        };
      case "naddr": {
        const { kind, pubkey, identifier, relays } = decoded.data;
        return {
          type: "naddr",
          data: {
            kind,
            pubkey,
            d: identifier,
            relays: relays && relays.length > 0 ? relays : undefined,
          },
        };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}
