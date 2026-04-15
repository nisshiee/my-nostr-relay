import { useEffect, useRef, useState, useCallback } from "react";
import { SimplePool } from "nostr-tools/pool";
import type { Event } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import {
  BOOTSTRAP_RELAYS,
  BOOTSTRAP_EOSE_TIMEOUT,
  CLIENT_TAG,
  MAX_WAIT_FOR_CONNECTION,
} from "../lib/constants";
import type { NostrEvent } from "../types/nostr";

export type ConnectionStatus = "connecting" | "loading" | "connected" | "error";

type FollowAction = "follow" | "unfollow";

export interface UseNostrConnectionResult {
  pool: SimplePool | null;
  relayUrls: string[];
  followPubkeys: string[];
  status: ConnectionStatus;
  setStatus: (status: ConnectionStatus) => void;
  updateFollowList: (targetPubkey: string, action: FollowAction) => Promise<string[]>;
}

/**
 * SimplePool接続管理、リレーリスト解決（kind:10002）、フォローリスト取得（kind:3）
 */
export function useNostrConnection(pubkey: string | null): UseNostrConnectionResult {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [relayUrls, setRelayUrls] = useState<string[]>([]);
  const [followPubkeys, setFollowPubkeys] = useState<string[]>([]);
  const [pool, setPool] = useState<SimplePool | null>(null);
  const poolRef = useRef<SimplePool | null>(null);
  const relayUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    relayUrlsRef.current = relayUrls;
  }, [relayUrls]);

  const fetchLatestContactEvent = useCallback(async (): Promise<Event | null> => {
    const currentPool = poolRef.current;
    if (!currentPool || !pubkey) {
      throw new Error("kind:3 を取得できませんでした。接続を確認してください");
    }

    const queryRelays = relayUrlsRef.current.length > 0 ? relayUrlsRef.current : BOOTSTRAP_RELAYS;
    const contactEvents = await currentPool.querySync(
      queryRelays,
      { authors: [pubkey], kinds: [3], limit: 1 } as Filter,
      { maxWait: BOOTSTRAP_EOSE_TIMEOUT },
    );

    return contactEvents.reduce<Event | null>(
      (latest, event) => (!latest || event.created_at > latest.created_at ? event : latest),
      null,
    );
  }, [pubkey]);

  const updateFollowList = useCallback(async (targetPubkey: string, action: FollowAction): Promise<string[]> => {
    if (!targetPubkey) {
      throw new Error("対象ユーザーが不正です");
    }

    const currentPool = poolRef.current;
    const currentRelays = relayUrlsRef.current.length > 0 ? relayUrlsRef.current : BOOTSTRAP_RELAYS;
    if (!currentPool || currentRelays.length === 0 || !pubkey) {
      throw new Error("フォロー状態を更新できませんでした。接続を確認してください");
    }

    const nostrExt = window.nostr;
    if (!nostrExt) {
      throw new Error("NIP-07拡張（window.nostr）が見つかりません");
    }

    const latestContactEvent = await fetchLatestContactEvent();
    const baseTags = latestContactEvent?.tags ?? [CLIENT_TAG];
    const nonPTags = baseTags.filter((tag) => tag[0] !== "p");
    const existingPTags = baseTags.filter((tag) => tag[0] === "p" && tag[1]);

    const pTagMap = new Map<string, string[]>();
    for (const tag of existingPTags) {
      const followedPubkey = tag[1];
      if (!followedPubkey || pTagMap.has(followedPubkey)) continue;
      pTagMap.set(followedPubkey, tag);
    }

    if (action === "follow") {
      if (!pTagMap.has(targetPubkey)) {
        pTagMap.set(targetPubkey, ["p", targetPubkey]);
      }
    } else {
      pTagMap.delete(targetPubkey);
    }

    const nextFollowPubkeys = Array.from(pTagMap.keys());
    const nextTags = [...nonPTags, ...Array.from(pTagMap.values())];

    const unsignedEvent: NostrEvent = {
      kind: 3,
      content: latestContactEvent?.content ?? "",
      tags: nextTags,
      created_at: Math.floor(Date.now() / 1000),
    };

    const signedEvent = await nostrExt.signEvent(unsignedEvent);
    const results = await Promise.allSettled(
      currentPool.publish(currentRelays, signedEvent as Event),
    );
    const hasSuccess = results.some((result) => result.status === "fulfilled");
    if (!hasSuccess) {
      throw new Error("kind:3 の送信に失敗しました");
    }

    setFollowPubkeys(nextFollowPubkeys);
    return nextFollowPubkeys;
  }, [fetchLatestContactEvent, pubkey]);

  useEffect(() => {
    if (!pubkey) {
      return;
    }

    let cancelled = false;

    const connect = async () => {
      setStatus("connecting");

      try {
        // SimplePoolを作成（ブートストラップ取得とメインfeedで使い回す）
        const newPool = new SimplePool({
          enableReconnect: true,
          enablePing: true,
        });
        newPool.maxWaitForConnection = MAX_WAIT_FOR_CONNECTION;
        poolRef.current = newPool;
        setPool(newPool);

        // ステップ1: kind:10002（リレーリスト）とkind:3（フォローリスト）を1リクエストで取得
        const bootstrapEvents = await newPool.querySync(
          BOOTSTRAP_RELAYS,
          { kinds: [10002, 3], authors: [pubkey], limit: 2 } as Filter,
          { maxWait: BOOTSTRAP_EOSE_TIMEOUT },
        );

        if (cancelled) return;

        // 最新のkind:10002イベントを取得（created_atが最大のもの）
        const relayListEvent = bootstrapEvents
          .filter((e) => e.kind === 10002)
          .reduce<Event | null>((a, b) => (!a || b.created_at > a.created_at ? b : a), null);

        // kind:10002から"r"タグのリレーURLを抽出
        const resolvedRelayUrls = relayListEvent
          ? relayListEvent.tags
              .filter((tag) => tag[0] === "r" && tag[1])
              .map((tag) => tag[1]!)
          : [];

        // 最新のkind:3イベントを取得（created_atが最大のもの）
        const contactEvent = bootstrapEvents
          .filter((e) => e.kind === 3)
          .reduce<Event | null>((a, b) => (!a || b.created_at > a.created_at ? b : a), null);

        // "p"タグからフォロー中のpubkeyを抽出
        const resolvedFollowPubkeys = contactEvent
          ? contactEvent.tags
              .filter((tag) => tag[0] === "p" && tag[1])
              .map((tag) => tag[1]!)
          : [];

        if (resolvedFollowPubkeys.length === 0) return;

        // リレーリスト決定（kind:10002から取得 or BOOTSTRAP_RELAYSフォールバック）
        const allRelays = resolvedRelayUrls.length > 0
          ? [...new Set([...BOOTSTRAP_RELAYS, ...resolvedRelayUrls])]
          : [...BOOTSTRAP_RELAYS];

        setRelayUrls(allRelays);
        setFollowPubkeys(resolvedFollowPubkeys);
        setStatus("loading");
      } catch {
        if (!cancelled) {
          setStatus("error");
        }
      }
    };

    connect();

    return () => {
      cancelled = true;
      if (poolRef.current) {
        try {
          poolRef.current.destroy();
        } catch {
          // 既に閉じている場合は無視
        }
        poolRef.current = null;
      }
      setPool(null);
      setStatus("connecting");
      setRelayUrls([]);
      setFollowPubkeys([]);
    };
  }, [pubkey]);

  return { pool, relayUrls, followPubkeys, status, setStatus, updateFollowList };
}
