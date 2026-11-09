import { useCallback, useEffect, useRef, useMemo } from "react";
import type { SimplePool } from "nostr-tools/pool";
import type { Event } from "nostr-tools/core";
import { matchFilter, type Filter } from "nostr-tools/filter";
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
 * - pool・Filter・リレー・待ち時間が同じ進行中の querySync を共有
 * - 完全 ID の取得はキャッシュ済み分を省略し、他の Filter 条件も検証
 * - limit / search 付きの取得はキャッシュと合成せずリレーへ委譲
 * - 未取得・失敗をキャッシュせず、イベント本体は pool の変更後も保持
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

  /** pool ごとに取得条件が同じ進行中の REQ だけを共有する */
  const inflightRef = useRef<WeakMap<SimplePool, Map<string, Promise<Event[]>>>>(new WeakMap());

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

      // 完全な ID のみ、不変イベントの存在で取得済みと判断できる。
      // limit は全体の並び順、search はリレーの検索仕様に依存するので分割しない。
      const cachedEvents: Event[] = [];
      let fetchFilter = filter;
      if (
        filter.ids && filter.ids.length > 0 &&
        filter.ids.every((id) => /^[0-9a-f]{64}$/.test(id)) &&
        filter.limit === undefined && filter.search === undefined
      ) {
        const missingIds: string[] = [];
        for (const id of new Set(filter.ids)) {
          const cached = cache.get(id);
          if (!cached) {
            missingIds.push(id);
          } else if (
            matchFilter(filter, cached) &&
            // nostr-tools の matchFilter は until=0 を判定しないため補う。
            (filter.until === undefined || cached.created_at <= filter.until)
          ) {
            cachedEvents.push(cached);
          }
        }
        if (missingIds.length === 0) return cachedEvents;
        fetchFilter = { ...filter, ids: missingIds };
      }

      let inflight = inflightRef.current.get(currentPool);
      if (!inflight) {
        inflight = new Map();
        inflightRef.current.set(currentPool, inflight);
      }
      // 不足分が同じなら共有できるが、キャッシュ済み部分は呼び出しごとに結合する。
      const key = requestKey(fetchFilter, targetRelays, maxWait);
      let promise = inflight.get(key);
      if (!promise) {
        const requests = inflight;
        promise = (async (): Promise<Event[]> => {
          try {
            const fetched = await doFetch(
              currentPool,
              currentRelayUrls,
              fetchFilter,
              maxWait,
              opts?.relayCandidates,
            );
            for (const event of fetched) {
              cache.set(event.id, event);
            }
            return fetched;
          } finally {
            // 失敗・空応答も記録し続けず、次の呼び出しで再取得できるようにする。
            requests.delete(key);
          }
        })();
        inflight.set(key, promise);
      }
      const fetched = await promise;
      return [...cachedEvents, ...fetched];
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
