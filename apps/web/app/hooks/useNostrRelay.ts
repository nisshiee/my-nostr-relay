import React, { useState, useCallback } from "react";
import type { Event } from "nostr-tools/core";
import type { NoteCard, NostrProfile, Reactions } from "../lib/types";
import type { NostrEvent } from "../types/nostr";
import { useNostrConnection } from "./useNostrConnection";
import type { ConnectionStatus } from "./useNostrConnection";
import { useNostrProfiles } from "./useNostrProfiles";
import { useNostrNotes } from "./useNostrNotes";
import { useNostrReactions } from "./useNostrReactions";
import { useEventCache } from "./useEventCache";
import type { EventCache } from "./useEventCache";
import { SimplePool } from "nostr-tools/pool";
import { CLIENT_TAG } from "../lib/constants";

/** NIP-07拡張(window.nostr)の署名済みイベント型 */
type SignedNostrEvent = NostrEvent & { id: string; sig: string };

interface UseNostrRelayResult {
  notes: NoteCard[];
  profiles: Map<string, NostrProfile>;
  reactions: Reactions;
  status: ConnectionStatus;
  relayUrls: string[];
  pool: SimplePool | null;
  cache: EventCache;
  publishEvent: (event: NostrEvent) => Promise<void>;
  sendReaction: (targetEventId: string, targetPubkey: string, emoji: string, imageUrl?: string) => Promise<void>;
  sendRepost: (targetEventId: string, targetPubkey: string, originalEvent: NostrEvent) => Promise<void>;
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
  const { pool, relayUrls, followPubkeys, status, setStatus } = useNostrConnection(pubkey);
  const { profiles, upsertProfile, fetchProfiles, profilesRef } = useNostrProfiles(pool, relayUrls, followPubkeys);
  const cache = useEventCache(pool, relayUrls, fetchProfiles);

  // initialEventIds を管理するstate
  const [initialEventIds, setInitialEventIds] = useState<string[]>([]);
  const onInitialNotesReady = useCallback((eventIds: string[]) => {
    setInitialEventIds(eventIds);
  }, []);

  const { notes, notesRef, newNotesMinCreatedAtRef } = useNostrNotes(
    pool, relayUrls, followPubkeys, pubkey, publishedSlotMapRef,
    setStatus, profilesRef, fetchProfiles, onInitialNotesReady,
    cache,
  );

  const { reactions, addReaction } = useNostrReactions(
    pool, relayUrls, notesRef, newNotesMinCreatedAtRef, initialEventIds,
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

  /** NIP-25準拠のリアクションイベントを構築・署名・送信し、楽観的にUIを更新する */
  const sendReaction = useCallback(
    async (targetEventId: string, targetPubkey: string, emoji: string, imageUrl?: string) => {
      // NIP-07拡張の存在チェック
      const nostrExt = (window as unknown as { nostr?: { signEvent: (event: Record<string, unknown>) => Promise<SignedNostrEvent> } }).nostr;
      if (!nostrExt) {
        throw new Error("NIP-07拡張（window.nostr）が見つかりません");
      }

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

      // NIP-07拡張で署名
      const signedEvent = await nostrExt.signEvent(unsignedEvent);

      // リレーに送信
      await publishEvent(signedEvent as unknown as NostrEvent);

      // 楽観的にローカルのreactions stateを更新
      addReaction(signedEvent as unknown as Event);
    },
    [publishEvent, addReaction],
  );

  /** NIP-18準拠のリポストイベントを構築・署名・送信する */
  const sendRepost = useCallback(
    async (targetEventId: string, targetPubkey: string, originalEvent: NostrEvent) => {
      // NIP-07拡張の存在チェック（sendReactionと同じパターン）
      const nostrExt = (window as unknown as { nostr?: { signEvent: (event: Record<string, unknown>) => Promise<SignedNostrEvent> } }).nostr;
      if (!nostrExt) {
        throw new Error("NIP-07拡張（window.nostr）が見つかりません");
      }

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

      // NIP-07拡張で署名
      const signedEvent = await nostrExt.signEvent(unsignedEvent);

      // リレーに送信
      await publishEvent(signedEvent as unknown as NostrEvent);
    },
    [publishEvent, relayUrls],
  );

  return { notes, profiles, reactions, status, relayUrls, pool, cache, publishEvent, sendReaction, sendRepost };
}
