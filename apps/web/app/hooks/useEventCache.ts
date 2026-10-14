import { useCallback, useEffect, useRef, useMemo } from "react";
import type { SimplePool } from "nostr-tools/pool";
import type { Event } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import { BOOTSTRAP_EOSE_TIMEOUT } from "../lib/constants";
import {
  resolveRelayTargets,
  type ExternalRelayCandidate,
} from "../lib/relayUrlPolicy";

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export interface EventCache {
  fetchEvents(
    filter: Filter,
    opts?: { relayCandidates?: readonly ExternalRelayCandidate[]; maxWait?: number },
  ): Promise<Event[]>;
  addEvents(events: Event[]): void;
  getEvent(id: string): Event | undefined;
  ensureProfiles(pubkeys: string[]): void;
}

// ---------------------------------------------------------------------------
// フィルターからキャッシュキーを生成
// ---------------------------------------------------------------------------

/** Filter を安定した文字列キーに変換する（inflight 重複排除用） */
function filterKey(filter: Filter): string {
  return JSON.stringify(filter, Object.keys(filter).sort());
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * イベント取得・キャッシュ・重複排除を統一するフック。
 *
 * - 内部に `Map<string, Event>` のイベントキャッシュを保持
 * - 同一 Filter に対する重複 querySync を inflight Map で排除
 * - subscribe で受信したイベントを addEvents で追加可能
 * - external relay candidate 指定時は検証済みヒントだけを通常リレーと結合
 *
 * @param pool        SimplePool インスタンス
 * @param relayUrls   接続先リレーURL配列
 * @param fetchProfiles  useNostrProfiles の fetchProfiles 関数
 */
export function useEventCache(
  pool: SimplePool | null,
  relayUrls: string[],
  fetchProfiles: (pubkeys: string[]) => void,
): EventCache {
  /** eventId → Event のメモリキャッシュ */
  const eventCacheRef = useRef<Map<string, Event>>(new Map());

  /** filterKey → Promise<Event[]> の inflight 管理（重複 REQ 排除） */
  const inflightRef = useRef<Map<string, Promise<Event[]>>>(new Map());

  // 最新の pool / relayUrls / fetchProfiles を ref で保持
  const poolRef = useRef(pool);
  const relayUrlsRef = useRef(relayUrls);
  const fetchProfilesRef = useRef(fetchProfiles);

  useEffect(() => {
    poolRef.current = pool;
    relayUrlsRef.current = relayUrls;
    fetchProfilesRef.current = fetchProfiles;
  }, [pool, relayUrls, fetchProfiles]);

  // -----------------------------------------------------------------------
  // getEvent
  // -----------------------------------------------------------------------

  const getEvent = useCallback((id: string): Event | undefined => {
    return eventCacheRef.current.get(id);
  }, []);

  // -----------------------------------------------------------------------
  // addEvents
  // -----------------------------------------------------------------------

  const addEvents = useCallback((events: Event[]): void => {
    const cache = eventCacheRef.current;
    for (const event of events) {
      if (!cache.has(event.id)) {
        cache.set(event.id, event);
      }
    }
  }, []);

  // -----------------------------------------------------------------------
  // ensureProfiles
  // -----------------------------------------------------------------------

  const ensureProfiles = useCallback((pubkeys: string[]): void => {
    fetchProfilesRef.current(pubkeys);
  }, []);

  // -----------------------------------------------------------------------
  // fetchEvents
  // -----------------------------------------------------------------------

  const fetchEvents = useCallback(
    async (
      filter: Filter,
      opts?: { relayCandidates?: readonly ExternalRelayCandidate[]; maxWait?: number },
    ): Promise<Event[]> => {
      const currentPool = poolRef.current;
      const currentRelayUrls = relayUrlsRef.current;

      if (!currentPool || currentRelayUrls.length === 0) {
        return [];
      }

      const cache = eventCacheRef.current;
      const maxWait = opts?.maxWait ?? BOOTSTRAP_EOSE_TIMEOUT;
      const targetRelays = resolveRelayTargets(
        currentRelayUrls,
        opts?.relayCandidates,
      ).relayUrls;

      // -----------------------------------------------------------------
      // ids 指定の場合: キャッシュヒット分を除外して残りだけ fetch
      // -----------------------------------------------------------------
      if (filter.ids && filter.ids.length > 0) {
        const cachedEvents: Event[] = [];
        const missingIds: string[] = [];

        for (const id of filter.ids) {
          const cached = cache.get(id);
          if (cached) {
            cachedEvents.push(cached);
          } else {
            missingIds.push(id);
          }
        }

        // 全てキャッシュ済みならそのまま返す
        if (missingIds.length === 0) {
          return cachedEvents;
        }

        // 不足分のみ querySync
        const fetchFilter: Filter = { ...filter, ids: missingIds };
        const fetched = await doFetch(
          currentPool,
          currentRelayUrls,
          fetchFilter,
          maxWait,
          opts?.relayCandidates,
        );

        // キャッシュに追加
        for (const event of fetched) {
          cache.set(event.id, event);
        }

        return [...cachedEvents, ...fetched];
      }

      // -----------------------------------------------------------------
      // ids 指定なし（authors + kinds 等の一般フィルター）
      // -----------------------------------------------------------------
      const key = requestKey(filter, targetRelays, maxWait);
      const existing = inflightRef.current.get(key);
      if (existing) {
        return existing;
      }

      const promise = (async (): Promise<Event[]> => {
        try {
          const fetched = await doFetch(
            currentPool,
            currentRelayUrls,
            filter,
            maxWait,
            opts?.relayCandidates,
          );

          // キャッシュに追加
          for (const event of fetched) {
            cache.set(event.id, event);
          }

          return fetched;
        } finally {
          inflightRef.current.delete(key);
        }
      })();

      inflightRef.current.set(key, promise);
      return promise;
    },
    [],
  );

  // -----------------------------------------------------------------------
  // 返却
  // -----------------------------------------------------------------------

  return useMemo<EventCache>(
    () => ({ fetchEvents, addEvents, getEvent, ensureProfiles }),
    [fetchEvents, addEvents, getEvent, ensureProfiles],
  );
}

// ---------------------------------------------------------------------------
// 内部ヘルパー
// ---------------------------------------------------------------------------

/**
 * pool.querySync の直前に外部候補を検証し、configured relay と結合する。
 */
export async function doFetch(
  pool: SimplePool,
  configuredRelays: readonly string[],
  filter: Filter,
  maxWait: number,
  relayCandidates?: readonly ExternalRelayCandidate[],
): Promise<Event[]> {
  const targetRelays = resolveRelayTargets(
    configuredRelays,
    relayCandidates,
  ).relayUrls;
  return pool.querySync(targetRelays, filter, { maxWait });
}

function requestKey(
  filter: Filter,
  targetRelays: string[],
  maxWait: number,
): string {
  return JSON.stringify({
    filter: filterKey(filter),
    targetRelays,
    maxWait,
  });
}
