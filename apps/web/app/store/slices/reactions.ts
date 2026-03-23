/**
 * store/slices/reactions.ts
 *
 * kind:7 リアクション取得・集計・定期再購読。
 * hooks/useNostrReactions.ts からの移植。
 *
 * 主要アクション:
 * - subscribeReactions: kind:7 を購読し、集計を開始。定期 re-subscribe 付き。
 *
 * 連鎖フロー:
 *   subscribeFeed → onEose → resolveReposts → subscribeReactions
 */

import type { Event } from "nostr-tools/core";
import type { SubCloser } from "nostr-tools/abstract-pool";
import type { StateCreator } from "zustand";
import type { CanvasStore, ReactionEntry, Unsubscribe } from "../types";
import {
  REACTION_POLL_INTERVAL,
  REACTION_SINCE_SAFETY_MARGIN,
} from "../../lib/constants";

// ---------------------------------------------------------------------------
// Slice 型
// ---------------------------------------------------------------------------

export interface ReactionsSlice {
  // state
  reactions: Map<string, Map<string, ReactionEntry>>;
  _reactionSub: SubCloser | null;

  // actions
  subscribeReactions: (eventIds: string[]) => Unsubscribe;
}

// ---------------------------------------------------------------------------
// 内部ヘルパー
// ---------------------------------------------------------------------------

/** カスタム絵文字（:shortcode: 形式）のイベントタグから画像URLを取得する */
function extractCustomEmojiUrl(
  emoji: string,
  tags: string[][],
): string | undefined {
  if (!emoji.startsWith(":") || !emoji.endsWith(":") || emoji.length <= 2)
    return undefined;
  const shortcode = emoji.slice(1, -1);
  const emojiTag = tags.find(
    (tag) => tag[0] === "emoji" && tag[1] === shortcode && tag[2],
  );
  return emojiTag?.[2];
}

/** リアクションの content を正規化する */
function normalizeReactionContent(content: string): string | null {
  if (content === "+" || content === "") return "👍";
  if (content === "-") return "👎";
  if (content.startsWith(":") && content.endsWith(":") && content.length > 2)
    return content;
  return content;
}

/**
 * リアクション Map にイベントを追加する（イミュータブル更新）
 * @returns 新しい Map（変更がなければ同じ参照を返す）
 */
function addReactionToMap(
  reactions: Map<string, Map<string, ReactionEntry>>,
  event: Event,
  seenIds: Set<string>,
): Map<string, Map<string, ReactionEntry>> {
  if (seenIds.has(event.id)) return reactions;
  seenIds.add(event.id);

  const eTags = event.tags.filter((tag) => tag[0] === "e" && tag[1]);
  if (eTags.length === 0) return reactions;
  const targetEventId = eTags[eTags.length - 1]![1]!;

  const emoji = normalizeReactionContent(event.content);
  if (emoji === null) return reactions;

  const imageUrl = extractCustomEmojiUrl(emoji, event.tags);

  const next = new Map(reactions);
  const eventReactions = next.get(targetEventId);
  if (eventReactions) {
    const updated = new Map(eventReactions);
    const existing = updated.get(emoji);
    if (existing) {
      const newPubkeys = new Set(existing.pubkeys);
      newPubkeys.add(event.pubkey);
      updated.set(emoji, {
        count: existing.count + 1,
        imageUrl: existing.imageUrl ?? imageUrl,
        pubkeys: newPubkeys,
      });
    } else {
      updated.set(emoji, {
        count: 1,
        imageUrl,
        pubkeys: new Set([event.pubkey]),
      });
    }
    next.set(targetEventId, updated);
  } else {
    next.set(
      targetEventId,
      new Map([
        [emoji, { count: 1, imageUrl, pubkeys: new Set([event.pubkey]) }],
      ]),
    );
  }
  return next;
}

// ---------------------------------------------------------------------------
// Slice 実装
// ---------------------------------------------------------------------------

export const createReactionsSlice: StateCreator<
  CanvasStore,
  [],
  [],
  ReactionsSlice
> = (set, get) => ({
  // --- initial state ---
  reactions: new Map(),
  _reactionSub: null,

  // --- actions ---

  /**
   * kind:7 リアクションを購読し、集計を開始する。
   *
   * - 初期ロード: バッファに溜めて oneose で一括反映
   * - oneose 後: リアルタイムで addReaction
   * - 定期 re-subscribe: REACTION_POLL_INTERVAL ごとに再購読
   *
   * @param eventIds 対象のノート eventId 配列
   * @returns 購読解除関数
   */
  subscribeReactions: (eventIds: string[]) => {
    const { _pool, relayUrls } = get();
    if (!_pool || relayUrls.length === 0 || eventIds.length === 0) {
      return () => {};
    }

    let cancelled = false;
    const seenReactionIds = new Set<string>();
    let reactionSubRef: SubCloser | null = null;
    let reactionIntervalId: ReturnType<typeof setInterval> | null = null;
    let lastReactionSubClosedAt: number | undefined = undefined;
    /** EOSE 後にリアルタイムで受信した新規ノートの最小 created_at */
    let newNotesMinCreatedAt: number | undefined = undefined;

    // 初期ロード用バッファ
    const reactionBuffer: Event[] = [];
    let initialLoading = true;

    const reactionSub = _pool.subscribeMany(
      relayUrls,
      { kinds: [7], "#e": eventIds },
      {
        onevent(event: Event) {
          if (cancelled) return;
          if (initialLoading) {
            reactionBuffer.push(event);
          } else {
            // リアルタイム — 1件ずつ反映
            set((state) => ({
              reactions: addReactionToMap(
                state.reactions,
                event,
                seenReactionIds,
              ),
            }));
          }
        },
        oneose() {
          initialLoading = false;

          // バッファを一括反映
          if (reactionBuffer.length > 0) {
            let batch: Map<string, Map<string, ReactionEntry>> = new Map();
            for (const evt of reactionBuffer) {
              batch = addReactionToMap(batch, evt, seenReactionIds);
            }
            set({ reactions: batch });
          }

          // 定期 re-subscribe タイマーを開始
          lastReactionSubClosedAt = Math.floor(Date.now() / 1000);

          reactionIntervalId = setInterval(() => {
            if (cancelled) return;

            // 1. 現在の sub を閉じる
            if (reactionSubRef) {
              try {
                reactionSubRef.close();
              } catch {
                // already closed
              }
              reactionSubRef = null;
            }

            // 2. since を計算
            let since =
              (lastReactionSubClosedAt ?? Math.floor(Date.now() / 1000)) -
              REACTION_SINCE_SAFETY_MARGIN;
            if (newNotesMinCreatedAt !== undefined) {
              since = Math.min(since, newNotesMinCreatedAt);
            }

            // 3. 時刻を記録・リセット
            lastReactionSubClosedAt = Math.floor(Date.now() / 1000);
            newNotesMinCreatedAt = undefined;

            // 4. 現在の events から eventId を収集
            const currentEvents = get().events;
            const currentEventIds = [...currentEvents.keys()];
            if (currentEventIds.length === 0) return;

            // 5. 新しい購読を発行
            const pool = get()._pool;
            const urls = get().relayUrls;
            if (!pool || urls.length === 0) return;

            const newSub = pool.subscribeMany(
              urls,
              { kinds: [7], "#e": currentEventIds, since },
              {
                onevent(event: Event) {
                  if (!cancelled) {
                    set((state) => ({
                      reactions: addReactionToMap(
                        state.reactions,
                        event,
                        seenReactionIds,
                      ),
                    }));
                  }
                },
                oneose() {
                  // re-subscribe 完了（特に処理なし）
                },
              },
            );
            reactionSubRef = newSub;
          }, REACTION_POLL_INTERVAL);
        },
      },
    );

    reactionSubRef = reactionSub;
    set({ _reactionSub: reactionSub });

    // newNotesMinCreatedAt を外部から更新できるようにするため、
    // store 内の timelineIds の変化を監視する代わりに、
    // 購読解除関数に getter を付ける。
    // ただし zustand slice パターンでは、feed slice が新しいイベントを追加するときに
    // newNotesMinCreatedAt を更新する必要がある。
    // → reactions slice は events Map のタイムスタンプから計算し直す方が簡潔。

    // 購読解除関数
    return () => {
      cancelled = true;
      if (reactionIntervalId !== null) {
        clearInterval(reactionIntervalId);
        reactionIntervalId = null;
      }
      if (reactionSubRef) {
        try {
          reactionSubRef.close();
        } catch {
          // already closed
        }
        reactionSubRef = null;
      }
      set({ _reactionSub: null, reactions: new Map() });
    };
  },
});
