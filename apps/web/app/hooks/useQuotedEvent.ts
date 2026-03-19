import { useState, useEffect, useRef, useMemo } from "react";
import type { SimplePool } from "nostr-tools/pool";
import type { Event } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import { parseNostrUri } from "../lib/nip19";
import type { NostrProfile } from "../lib/types";
import { BOOTSTRAP_EOSE_TIMEOUT } from "../lib/constants";

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export interface UseQuotedEventResult {
  event: Event | null;
  profile: NostrProfile | null;
  loading: boolean;
  error: string | null;
}

/** キャッシュエントリ */
interface CacheEntry {
  event: Event;
  profile: NostrProfile | null;
}

// ---------------------------------------------------------------------------
// モジュールレベルのメモリキャッシュ（eventId → CacheEntry）
// ---------------------------------------------------------------------------

const cache = new Map<string, CacheEntry>();

/** 進行中のフェッチを重複排除するための Promise キャッシュ */
const inflight = new Map<string, Promise<CacheEntry | null>>();

// ---------------------------------------------------------------------------
// 内部ヘルパー
// ---------------------------------------------------------------------------

/**
 * eventId でイベントを取得し、そのイベントの pubkey でプロフィールもフェッチする。
 * 結果をキャッシュに保存して返す。
 */
async function fetchEventAndProfile(
  pool: SimplePool,
  relayUrls: string[],
  eventId: string,
  relayHints: string[],
): Promise<CacheEntry | null> {
  // キャッシュヒット
  const cached = cache.get(eventId);
  if (cached) return cached;

  // 重複フェッチ排除
  const existing = inflight.get(eventId);
  if (existing) return existing;

  const promise = (async (): Promise<CacheEntry | null> => {
    try {
      // リレーヒントがあれば優先的に使い、通常のリレーも含める
      const targetRelays = [...new Set([...relayHints, ...relayUrls])];

      // イベントをフェッチ
      const events = await pool.querySync(
        targetRelays,
        { ids: [eventId] } as Filter,
        { maxWait: BOOTSTRAP_EOSE_TIMEOUT },
      );

      if (events.length === 0) return null;

      const event = events[0];

      // プロフィールをフェッチ
      let profile: NostrProfile | null = null;
      try {
        const profileEvents = await pool.querySync(
          targetRelays,
          { kinds: [0], authors: [event.pubkey] } as Filter,
          { maxWait: BOOTSTRAP_EOSE_TIMEOUT },
        );
        if (profileEvents.length > 0) {
          // 最新のプロフィールを使用
          const latestProfile = profileEvents.reduce((a, b) =>
            a.created_at > b.created_at ? a : b,
          );
          profile = JSON.parse(latestProfile.content) as NostrProfile;
        }
      } catch {
        // プロフィール取得失敗は無視（event は返す）
      }

      const entry: CacheEntry = { event, profile };
      cache.set(eventId, entry);
      return entry;
    } catch {
      return null;
    } finally {
      inflight.delete(eventId);
    }
  })();

  inflight.set(eventId, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Nostr URI（nostr:nevent1... / nostr:note1...）を受け取り、
 * 引用先イベントとそのプロフィールをフェッチするhook。
 *
 * - モジュールレベルのメモリキャッシュでパフォーマンス最適化
 * - 同一 eventId の重複フェッチを排除
 * - useNostrRelay の pool / relayUrls を活用
 *
 * @param nostrUri  nostr: URI 文字列（例: "nostr:nevent1..."）。null/undefined で無効化
 * @param pool      SimplePool インスタンス（useNostrRelay から取得）
 * @param relayUrls 接続先リレーURL配列（useNostrRelay から取得）
 */
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

export function useQuotedEvent(
  nostrUri: string | null | undefined,
  pool: SimplePool | null,
  relayUrls: string[],
): UseQuotedEventResult {
  // URI のデコードとキャッシュ確認はレンダリング中に行う（副作用なし）
  const decoded = useMemo(() => decodeUri(nostrUri), [nostrUri]);
  const cached = decoded ? cache.get(decoded.eventId) ?? null : null;

  // フェッチが必要かどうかをレンダリング中に判定
  const needsFetch = !!decoded && !!pool && relayUrls.length > 0 && !cached;

  const [fetchResult, setFetchResult] = useState<{
    event: Event | null;
    profile: NostrProfile | null;
    error: string | null;
    /** どの eventId に対する結果か */
    forEventId: string | null;
  }>({ event: null, profile: null, error: null, forEventId: null });

  // URI が切り替わったときに前回のフェッチをキャンセルするための ref
  const cancelRef = useRef(0);

  // eventId が変わったら fetchResult をリセット（render-time state update）
  const currentEventId = decoded?.eventId ?? null;
  if (currentEventId !== fetchResult.forEventId && fetchResult.forEventId !== null) {
    setFetchResult({ event: null, profile: null, error: null, forEventId: null });
  }

  useEffect(() => {
    if (!needsFetch || !decoded || !pool) return;

    const fetchId = ++cancelRef.current;

    fetchEventAndProfile(pool, relayUrls, decoded.eventId, decoded.relayHints).then(
      (entry) => {
        if (cancelRef.current !== fetchId) return; // stale
        if (entry) {
          setFetchResult({ event: entry.event, profile: entry.profile, error: null, forEventId: decoded.eventId });
        } else {
          setFetchResult({ event: null, profile: null, error: "引用先イベントが見つかりませんでした", forEventId: decoded.eventId });
        }
      },
    );
  }, [needsFetch, decoded, pool, relayUrls]);

  // キャッシュがあればそれを優先、なければ fetch 結果を使う
  if (cached) {
    return { event: cached.event, profile: cached.profile, loading: false, error: null };
  }

  if (!decoded) {
    const noError = !nostrUri ? null : "サポートされていない Nostr URI です";
    return { event: null, profile: null, loading: false, error: noError };
  }

  // loading: フェッチが必要だがまだ結果が来ていない
  const loading = needsFetch && fetchResult.forEventId !== currentEventId;

  return { event: fetchResult.event, profile: fetchResult.profile, loading, error: fetchResult.error };
}
