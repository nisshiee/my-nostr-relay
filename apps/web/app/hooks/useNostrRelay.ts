import React, { useState, useCallback, useRef } from "react";
import type { Event } from "nostr-tools/core";
import type { NoteCard, NostrProfile, Reactions } from "../lib/types";
import type { NostrEvent } from "../types/nostr";
import { signEventWithActiveSigner } from "../lib/nostrSigner";
import { useNostrConnection } from "./useNostrConnection";
import type { ConnectionStatus } from "./useNostrConnection";
import { useNostrProfiles } from "./useNostrProfiles";
import { useNostrNotes } from "./useNostrNotes";
import type { WatchReactions } from "./useNostrReactions";
import { useNostrReactions } from "./useNostrReactions";
import { useEventCache } from "./useEventCache";
import type { EventCache } from "./useEventCache";
import { useCustomEmojis } from "./useCustomEmojis";
import type { CustomEmoji, EmojiSet } from "./useCustomEmojis";
import { SimplePool } from "nostr-tools/pool";
import { BOOTSTRAP_EOSE_TIMEOUT, CLIENT_TAG } from "../lib/constants";

interface UseNostrRelayResult {
  notes: NoteCard[];
  profiles: Map<string, NostrProfile>;
  reactions: Reactions;
  watchReactions: WatchReactions;
  status: ConnectionStatus;
  relayUrls: string[];
  pool: SimplePool | null;
  cache: EventCache;
  emojiSets: EmojiSet[];
  looseEmojis: CustomEmoji[];
  fetchProfiles: (pubkeys: string[]) => void;
  fetchUserRecentNotes: (pubkey: string) => Promise<Event[]>;
  fetchHashtagNotes: (tag: string) => Promise<Event[]>;
  publishEvent: (event: NostrEvent) => Promise<void>;
  sendReaction: (targetEventId: string, targetPubkey: string, emoji: string, imageUrl?: string) => Promise<void>;
  sendRepost: (targetEventId: string, targetPubkey: string, originalEvent: NostrEvent) => Promise<void>;
  isFollowing: (targetPubkey: string) => boolean;
  follow: (targetPubkey: string) => Promise<void>;
  unfollow: (targetPubkey: string) => Promise<void>;
}

/**
 * Nostrリレーに接続し、フォロー中ユーザーのノートとプロフィールを取得するhook
 *
 * 接続フロー:
 * 1. BOOTSTRAP_RELAYSにSimplePoolで接続してkind:10002（NIP-65リレーリスト）とkind:3（フォローリスト）を取得
 * 2. 取得したリレーリスト（またはBOOTSTRAP_RELAYSフォールバック）で接続
 * 3. フォロー中ユーザーのkind:1（ノート）とkind:0（プロフィール）をsubscribe
 */
export function useNostrRelay(
  pubkey: string | null,
  publishedSlotMapRef: React.RefObject<Map<string, string>>,
): UseNostrRelayResult {
  const { pool, timelinePool, relayUrls, followPubkeys, status, setStatus, updateFollowList } = useNostrConnection(pubkey);
  const { profiles, fetchProfiles, profilesRef } = useNostrProfiles(pool, relayUrls, followPubkeys);
  const cache = useEventCache(pool, relayUrls, fetchProfiles);
  const { emojiSets, looseEmojis } = useCustomEmojis(pool, relayUrls, pubkey);

  // initialEventIds を管理するstate
  const [initialEventIds, setInitialEventIds] = useState<string[]>([]);
  const onInitialNotesReady = useCallback((eventIds: string[]) => {
    setInitialEventIds(eventIds);
  }, []);

  const { notes, notesRef, newNotesMinCreatedAtRef } = useNostrNotes(
    timelinePool, relayUrls, followPubkeys, pubkey, publishedSlotMapRef,
    setStatus, profilesRef, fetchProfiles, onInitialNotesReady,
    cache,
  );

  const { reactions, addReaction, watchReactions } = useNostrReactions(
    pool, relayUrls, notesRef, newNotesMinCreatedAtRef, initialEventIds,
  );

  const fetchUserRecentNotes = useCallback(
    async (targetPubkey: string): Promise<Event[]> => {
      if (!pool || relayUrls.length === 0) {
        throw new Error("recent note を取得できませんでした。リレー接続を確認してください");
      }

      const events = await pool.querySync(
        relayUrls,
        { kinds: [1], authors: [targetPubkey], limit: 50 },
        { maxWait: BOOTSTRAP_EOSE_TIMEOUT },
      );

      const recentNotes = events
        .filter((event) => event.kind === 1)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 50);

      cache.addEvents(recentNotes);
      return recentNotes;
    },
    [pool, relayUrls, cache],
  );

  const fetchHashtagNotes = useCallback(
    async (tag: string): Promise<Event[]> => {
      if (!pool || relayUrls.length === 0) {
        throw new Error("ハッシュタグを取得できませんでした。リレー接続を確認してください");
      }

      const events = await pool.querySync(
        relayUrls,
        { kinds: [1], "#t": [tag], limit: 50 },
        { maxWait: BOOTSTRAP_EOSE_TIMEOUT },
      );

      const hashtagNotes = events
        .filter((event) => event.kind === 1)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 50);

      cache.addEvents(hashtagNotes);
      fetchProfiles(Array.from(new Set(hashtagNotes.map((event) => event.pubkey))));
      return hashtagNotes;
    },
    [pool, relayUrls, cache, fetchProfiles],
  );

  /** 署名済みイベントを全リレーにpublishする（1つ以上のリレーに成功すればOK） */
  const publishEvent = useCallback(
    async (event: NostrEvent) => {
      if (!pool || relayUrls.length === 0) {
        throw new Error("リレーに接続されていません");
      }
      const results = await Promise.allSettled(
        pool.publish(relayUrls, event as Event),
      );
      const hasSuccess = results.some((r) => r.status === "fulfilled");
      if (!hasSuccess) {
        throw new Error("すべてのリレーへの送信に失敗しました");
      }
    },
    [pool, relayUrls],
  );

  const isFollowing = useCallback(
    (targetPubkey: string) => followPubkeys.includes(targetPubkey),
    [followPubkeys],
  );

  const follow = useCallback(
    async (targetPubkey: string) => {
      await updateFollowList(targetPubkey, "follow");
    },
    [updateFollowList],
  );

  const unfollow = useCallback(
    async (targetPubkey: string) => {
      await updateFollowList(targetPubkey, "unfollow");
    },
    [updateFollowList],
  );

  const pendingReactionsRef = useRef(new Map<string, { key: string; promise: Promise<void> }>());

  /** NIP-25準拠のリアクションイベントを構築・署名・送信し、楽観的にUIを更新する */
  const sendReaction = useCallback(
    (targetEventId: string, targetPubkey: string, emoji: string, imageUrl?: string) => {
      // モーダルを閉じて開き直しても、同じ投稿への署名待ちを二重に開始しない。
      const key = JSON.stringify([targetPubkey, emoji, imageUrl ?? null]);
      const pending = pendingReactionsRef.current.get(targetEventId);
      if (pending) {
        return pending.key === key
          ? pending.promise
          : Promise.reject(new Error("この投稿へのリアクションを送信中です。完了後にもう一度お試しください"));
      }
      const sending = (async () => {
      // NIP-25準拠のkind:7イベントを構築
      const tags: string[][] = [
        ["e", targetEventId, "", targetPubkey],
        ["p", targetPubkey],
        ["k", "1"],
        CLIENT_TAG,
      ];

      // カスタム絵文字（:shortcode: 形式）の場合はemojiタグを追加
      let content = emoji;
      if (emoji.startsWith(":") && emoji.endsWith(":") && emoji.length > 2 && imageUrl) {
        const shortcode = emoji.slice(1, -1);
        tags.push(["emoji", shortcode, imageUrl]);
        content = emoji;
      }

      const unsignedEvent = {
        kind: 7,
        content,
        tags,
        created_at: Math.floor(Date.now() / 1000),
      };

      const signedEvent = await signEventWithActiveSigner(unsignedEvent);

      // リレーに送信
      await publishEvent(signedEvent as unknown as NostrEvent);

      // 楽観的にローカルのreactions stateを更新
      addReaction(signedEvent as unknown as Event);
      })();
      pendingReactionsRef.current.set(targetEventId, { key, promise: sending });
      void sending.finally(() => {
        if (pendingReactionsRef.current.get(targetEventId)?.promise === sending) {
          pendingReactionsRef.current.delete(targetEventId);
        }
      }).catch(() => {});
      return sending;
    },
    [publishEvent, addReaction],
  );

  /** NIP-18準拠のリポストイベントを構築・署名・送信する */
  const sendRepost = useCallback(
    async (targetEventId: string, targetPubkey: string, originalEvent: NostrEvent) => {
      // NIP-18準拠のkind:6リポストイベントを構築
      const unsignedEvent = {
        kind: 6,
        content: JSON.stringify(originalEvent), // 元イベントのJSON文字列
        tags: [
          ["e", targetEventId, relayUrls[0] ?? ""],
          ["p", targetPubkey],
          CLIENT_TAG,
        ],
        created_at: Math.floor(Date.now() / 1000),
      };

      const signedEvent = await signEventWithActiveSigner(unsignedEvent);

      // リレーに送信
      await publishEvent(signedEvent as unknown as NostrEvent);
    },
    [publishEvent, relayUrls],
  );

  return {
    notes,
    profiles,
    reactions,
    watchReactions,
    status,
    relayUrls,
    pool,
    cache,
    emojiSets,
    looseEmojis,
    fetchProfiles,
    fetchUserRecentNotes,
    fetchHashtagNotes,
    publishEvent,
    sendReaction,
    sendRepost,
    isFollowing,
    follow,
    unfollow,
  };
}
