import { useEffect, useRef, useState } from "react";
import { SimplePool } from "nostr-tools/pool";
import type { Event } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import {
  BOOTSTRAP_RELAYS,
  BOOTSTRAP_EOSE_TIMEOUT,
  MAX_WAIT_FOR_CONNECTION,
} from "../lib/constants";

export type ConnectionStatus = "connecting" | "loading" | "connected" | "error";

export interface UseNostrConnectionResult {
  pool: SimplePool | null;
  relayUrls: string[];
  followPubkeys: string[];
  status: ConnectionStatus;
  setStatus: (status: ConnectionStatus) => void;
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

  return { pool, relayUrls, followPubkeys, status, setStatus };
}
