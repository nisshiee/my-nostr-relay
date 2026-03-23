import { useState, useEffect, useRef, useMemo } from "react";
import type { Event } from "nostr-tools/core";
import { parseNostrUri } from "../lib/nip19";
import type { NostrProfile } from "../lib/types";
import type { EventCache } from "./useEventCache";

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export interface UseQuotedEventResult {
  event: Event | null;
  profile: NostrProfile | null;
  loading: boolean;
  error: string | null;
}

// ---------------------------------------------------------------------------
// 内部ヘルパー
// ---------------------------------------------------------------------------

/** URI をデコードして eventId / relayHints を抽出する（純粋関数） */
function decodeUri(nostrUri: string | null | undefined): {
  eventId: string;
  relayHints: string[];
} | null {
  if (!nostrUri) return null;
  const decoded = parseNostrUri(nostrUri);
  if (!decoded || decoded.type === "naddr") return null;
  const eventId = decoded.data.eventId;
  const relayHints =
    decoded.type === "nevent" && decoded.data.relays
      ? decoded.data.relays
      : [];
  return { eventId, relayHints };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Nostr URI（nostr:nevent1... / nostr:note1...）を受け取り、
 * 引用先イベントとそのプロフィールを EventCache 経由でフェッチするhook。
 *
 * @param nostrUri  nostr: URI 文字列（例: "nostr:nevent1..."）。null/undefined で無効化
 * @param cache     EventCache インスタンス（useEventCache から取得）
 * @param profiles  pubkey → NostrProfile のマップ（useNostrProfiles から取得）
 */
export function useQuotedEvent(
  nostrUri: string | null | undefined,
  cache: EventCache,
  profiles: Map<string, NostrProfile>,
): UseQuotedEventResult {
  const decoded = useMemo(() => decodeUri(nostrUri), [nostrUri]);

  const eventId = decoded?.eventId ?? null;
  const cachedEvent = eventId ? cache.getEvent(eventId) ?? null : null;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // URI が切り替わったときに前回のフェッチをキャンセルするための ref
  const cancelRef = useRef(0);

  useEffect(() => {
    if (!decoded || cachedEvent) {
      setLoading(false);
      return;
    }

    const fetchId = ++cancelRef.current;
    setLoading(true);
    setError(null);

    cache
      .fetchEvents(
        { ids: [decoded.eventId] },
        decoded.relayHints.length > 0
          ? { relayHints: decoded.relayHints }
          : undefined,
      )
      .then((events) => {
        if (cancelRef.current !== fetchId) return;
        if (events.length > 0) {
          // プロフィールを確保
          cache.ensureProfiles([events[0].pubkey]);
          setError(null);
        } else {
          setError("引用先イベントが見つかりませんでした");
        }
      })
      .catch(() => {
        if (cancelRef.current !== fetchId) return;
        setError("引用先イベントの取得に失敗しました");
      })
      .finally(() => {
        if (cancelRef.current !== fetchId) return;
        setLoading(false);
      });
  }, [decoded, cachedEvent, cache]);

  // デコード失敗
  if (!decoded) {
    const noError = !nostrUri ? null : "サポートされていない Nostr URI です";
    return { event: null, profile: null, loading: false, error: noError };
  }

  // イベントを取得（fetchEvents 完了後は cache.getEvent で取れる）
  const event = cachedEvent ?? cache.getEvent(decoded.eventId) ?? null;
  const profile = event ? profiles.get(event.pubkey) ?? null : null;

  return { event, profile, loading, error };
}
