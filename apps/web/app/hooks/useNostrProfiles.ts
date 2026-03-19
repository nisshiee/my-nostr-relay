import React, { useEffect, useRef, useState, useCallback } from "react";
import type { SimplePool } from "nostr-tools/pool";
import type { Event } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import type { SubCloser } from "nostr-tools/abstract-pool";
import { BOOTSTRAP_EOSE_TIMEOUT } from "../lib/constants";
import type { NostrProfile } from "../lib/types";

export interface UseNostrProfilesResult {
  profiles: Map<string, NostrProfile>;
  upsertProfile: (event: Event) => void;
  fetchProfiles: (pubkeys: string[]) => void;
  profilesRef: React.RefObject<Map<string, NostrProfile>>;
}

/**
 * kind:0 subscribe、プロフィールキャッシュ管理
 */
export function useNostrProfiles(
  pool: SimplePool | null,
  relayUrls: string[],
  followPubkeys: string[],
): UseNostrProfilesResult {
  const [profiles, setProfiles] = useState<Map<string, NostrProfile>>(new Map());
  const profilesRef = useRef<Map<string, NostrProfile>>(new Map());

  // pool/relayUrlsのrefを保持（fetchProfilesから安定的にアクセスするため）
  const poolRef = useRef<SimplePool | null>(null);
  const relayUrlsRef = useRef<string[]>([]);

  /** プロフィールを追加・更新（kind:0イベントから） */
  const upsertProfile = useCallback((event: Event) => {
    try {
      const data = JSON.parse(event.content) as NostrProfile;
      setProfiles((prev) => {
        const next = new Map(prev);
        next.set(event.pubkey, data);
        return next;
      });
    } catch {
      // JSONパース失敗は無視
    }
  }, []);

  /** 指定pubkeyのプロフィールを追加取得（リポスト関連で使用） */
  const fetchProfiles = useCallback((pubkeys: string[]) => {
    const currentPool = poolRef.current;
    const currentRelays = relayUrlsRef.current;
    if (!currentPool || currentRelays.length === 0 || pubkeys.length === 0) return;

    // 未取得のpubkeyのみフィルタ
    const unknownPubkeys = pubkeys.filter((pk) => !profilesRef.current.has(pk));
    if (unknownPubkeys.length === 0) return;

    currentPool.querySync(
      currentRelays,
      { kinds: [0], authors: unknownPubkeys } as Filter,
      { maxWait: BOOTSTRAP_EOSE_TIMEOUT },
    ).then((profileEvents) => {
      for (const pe of profileEvents) {
        upsertProfile(pe);
      }
    }).catch(() => { /* プロフィール取得失敗は無視 */ });
  }, [upsertProfile]);

  // profilesの最新値をrefで同期
  useEffect(() => {
    profilesRef.current = profiles;
  }, [profiles]);

  // pool/relayUrlsのrefを同期
  useEffect(() => {
    poolRef.current = pool;
  }, [pool]);

  useEffect(() => {
    relayUrlsRef.current = relayUrls;
  }, [relayUrls]);

  // フォロー中ユーザーの kind:0 subscribe
  useEffect(() => {
    if (!pool || relayUrls.length === 0 || followPubkeys.length === 0) return;

    let cancelled = false;

    const profileSub: SubCloser = pool.subscribeMany(
      relayUrls,
      { kinds: [0], authors: followPubkeys } as Filter,
      {
        onevent(event: Event) {
          if (!cancelled) {
            upsertProfile(event);
          }
        },
        oneose() {
          // プロフィール取得完了
        },
      },
    );

    return () => {
      cancelled = true;
      try {
        profileSub.close();
      } catch {
        // 既に閉じている場合は無視
      }
      setProfiles(new Map());
    };
  }, [pool, relayUrls, followPubkeys, upsertProfile]);

  return { profiles, upsertProfile, fetchProfiles, profilesRef };
}
