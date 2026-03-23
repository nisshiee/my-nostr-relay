/**
 * store/slices/threads.ts
 *
 * スレッド検出・祖先フェッチ・ThreadCard 構築。
 * hooks/useThreadCards.ts からの移植。
 *
 * 主要アクション:
 * - fetchAncestors: 指定 eventId の祖先ノートを再帰的にフェッチし、
 *                   スレッドをグルーピング・マージする
 *
 * 純粋関数群は store/pure/buildThreads.ts に委譲。
 */

import type { Event } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import type { StateCreator } from "zustand";
import type { CanvasStore } from "../types";
import type { ThreadCard, ThreadNote } from "../../lib/types";
import {
  extractReplyEventIds,
  isReply,
  eventToThreadNote,
  resolveReplyAuthors,
  collectMissingEventIds,
  findOverlappingThreads,
  mergeThreadCards,
  MAX_THREAD_DEPTH,
} from "../pure/buildThreads";
import { calcFreshnessScore } from "../pure/scoring";
import {
  BOOTSTRAP_EOSE_TIMEOUT,
  SCORE_HALF_LIFE,
  OWNER_SCORE_HALF_LIFE,
} from "../../lib/constants";

// ---------------------------------------------------------------------------
// Slice 型
// ---------------------------------------------------------------------------

export interface ThreadsSlice {
  // state
  threadGroups: Map<string, string[]>;

  // actions
  fetchAncestors: (eventIds: string[]) => Promise<void>;
}

// ---------------------------------------------------------------------------
// 内部ヘルパー
// ---------------------------------------------------------------------------

/**
 * NoteCard → ThreadNote 変換（events Map から生成）
 */
function eventToThreadNoteFromStore(event: Event): ThreadNote {
  return eventToThreadNote({
    id: event.id,
    pubkey: event.pubkey,
    content: event.content,
    created_at: event.created_at,
    tags: event.tags,
  });
}

// ---------------------------------------------------------------------------
// Slice 実装
// ---------------------------------------------------------------------------

export const createThreadsSlice: StateCreator<
  CanvasStore,
  [],
  [],
  ThreadsSlice
> = (set, get) => ({
  // --- initial state ---
  threadGroups: new Map(),

  // --- actions ---

  /**
   * スレッド祖先ノートを再帰的にフェッチし、ThreadCard を構築・マージする。
   *
   * フロー:
   * 1. eventIds の中からリプライ（e タグ付き）のイベントを検出
   * 2. 未知の参照先 eventId を収集
   * 3. 再帰的に pool.querySync で祖先を取得（MAX_THREAD_DEPTH まで）
   * 4. 取得した祖先を events Map に追加
   * 5. ThreadCard を構築・既存スレッドとマージ
   * 6. cards から ThreadCard に含まれるノートを除外（filteredNotes 相当）
   *
   * @param eventIds 対象の eventId 配列（通常は timelineIds の新規分）
   */
  fetchAncestors: async (eventIds: string[]) => {
    const { _pool, relayUrls, pubkey, events } = get();
    if (!_pool || relayUrls.length === 0 || eventIds.length === 0) return;

    // 新しいリプライを検出
    const replyEvents: Event[] = [];
    for (const eventId of eventIds) {
      const event = events.get(eventId);
      if (!event) continue;
      if (!isReply(event.tags)) continue;
      replyEvents.push(event);
    }

    if (replyEvents.length === 0) return;

    // 既知の eventId 集合（events Map のキー）
    const knownEventIds = new Set(get().events.keys());
    // インフライト管理
    const inflight = new Set<string>();

    /**
     * 再帰的に祖先イベントをフェッチ
     */
    const fetchRecursive = async (
      idsToFetch: string[],
      depth: number,
    ): Promise<Event[]> => {
      if (depth >= MAX_THREAD_DEPTH || idsToFetch.length === 0) return [];

      const pool = get()._pool;
      const urls = get().relayUrls;
      if (!pool || urls.length === 0) return [];

      // インフライト重複排除
      const toFetch = idsToFetch.filter((id) => !inflight.has(id));
      if (toFetch.length === 0) return [];

      for (const id of toFetch) {
        inflight.add(id);
      }

      try {
        const fetchedEvents = await pool.querySync(
          urls,
          { kinds: [1], ids: toFetch } as Filter,
          { maxWait: BOOTSTRAP_EOSE_TIMEOUT },
        );

        // knownEventIds に追加
        for (const id of toFetch) {
          knownEventIds.add(id);
        }
        for (const event of fetchedEvents) {
          knownEventIds.add(event.id);
        }

        // さらに遡る必要のある未知の参照を収集
        const nextMissing = collectMissingEventIds(
          knownEventIds,
          fetchedEvents.map((e) => ({ id: e.id, tags: e.tags })),
        );

        if (nextMissing.length > 0) {
          const deeper = await fetchRecursive(nextMissing, depth + 1);
          return [...fetchedEvents, ...deeper];
        }

        return fetchedEvents;
      } catch (err) {
        console.error("[threads] 祖先フェッチエラー:", err);
        return [];
      } finally {
        for (const id of toFetch) {
          inflight.delete(id);
        }
      }
    };

    // 未知の参照先 eventId を収集
    const allMissingIds = new Set<string>();
    for (const event of replyEvents) {
      const refIds = extractReplyEventIds(event.tags);
      for (const id of refIds) {
        if (!knownEventIds.has(id)) {
          allMissingIds.add(id);
        }
      }
    }

    // 祖先を一括フェッチ
    let fetchedEvents: Event[] = [];
    if (allMissingIds.size > 0) {
      fetchedEvents = await fetchRecursive([...allMissingIds], 0);
    }

    // フェッチしたイベントを events Map に追加
    if (fetchedEvents.length > 0) {
      set((state) => {
        const nextEvents = new Map(state.events);
        for (const event of fetchedEvents) {
          if (!nextEvents.has(event.id)) {
            nextEvents.set(event.id, event);
          }
        }
        return { events: nextEvents };
      });
    }

    // フェッチした祖先を ThreadNote に変換
    const fetchedNotesMap = new Map<string, ThreadNote>();
    for (const event of fetchedEvents) {
      fetchedNotesMap.set(event.id, eventToThreadNoteFromStore(event));
    }

    // 既存 events から ThreadNote のルックアップ
    const currentEvents = get().events;
    const allNotesLookup = new Map<string, ThreadNote>();
    for (const [id, event] of currentEvents) {
      allNotesLookup.set(id, eventToThreadNoteFromStore(event));
    }
    for (const [id, note] of fetchedNotesMap) {
      allNotesLookup.set(id, note);
    }

    // ThreadCard 構築・マージ
    set((state) => {
      let updatedCards = state.cards.filter(
        (c) => c.type === "thread",
      ) as ThreadCard[];
      // non-thread cards は後で再統合
      const nonThreadCards = state.cards.filter((c) => c.type !== "thread");

      // eventId → ThreadCard index マッピング
      const eventIdToCardIndex = new Map<string, number>();
      for (let i = 0; i < updatedCards.length; i++) {
        for (const eid of updatedCards[i]!.eventIds) {
          eventIdToCardIndex.set(eid, i);
        }
      }

      for (const replyEvent of replyEvents) {
        const refIds = extractReplyEventIds(replyEvent.tags);
        const allRelatedIds = [replyEvent.id, ...refIds];

        // 既存スレッドとの照合
        let targetCardIndex: number | undefined;

        for (const id of allRelatedIds) {
          const idx = eventIdToCardIndex.get(id);
          if (idx !== undefined) {
            if (targetCardIndex !== undefined && targetCardIndex !== idx) {
              // 2つの異なるスレッドをマージ
              const keepIdx = Math.min(targetCardIndex, idx);
              const mergeIdx = Math.max(targetCardIndex, idx);
              const keepCard = updatedCards[keepIdx]!;
              const mergeCard = updatedCards[mergeIdx]!;

              // マージ
              const mergedNotes = new Map<string, ThreadNote>();
              for (const n of keepCard.notes) mergedNotes.set(n.eventId, n);
              for (const n of mergeCard.notes) {
                if (!mergedNotes.has(n.eventId)) mergedNotes.set(n.eventId, n);
              }

              const sorted = [...mergedNotes.values()].sort(
                (a, b) => a.created_at - b.created_at,
              );
              const resolved = resolveReplyAuthors(sorted);
              const mergedEventIds = new Set([
                ...keepCard.eventIds,
                ...mergeCard.eventIds,
              ]);

              const latestCreatedAt =
                resolved.length > 0
                  ? Math.max(...resolved.map((n) => n.created_at))
                  : keepCard.created_at;

              const now = Math.floor(Date.now() / 1000);
              const hasOwnerNote = resolved.some((n) => n.pubkey === pubkey);
              const halfLife = hasOwnerNote
                ? OWNER_SCORE_HALF_LIFE
                : SCORE_HALF_LIFE;

              updatedCards[keepIdx] = {
                ...keepCard,
                notes: resolved,
                eventIds: mergedEventIds,
                created_at: latestCreatedAt,
                score: calcFreshnessScore(latestCreatedAt, now, halfLife),
              };

              // マージ元を削除
              updatedCards = [
                ...updatedCards.slice(0, mergeIdx),
                ...updatedCards.slice(mergeIdx + 1),
              ];

              // index 再構築
              for (const eid of mergeCard.eventIds) {
                eventIdToCardIndex.set(eid, keepIdx);
              }
              for (const [eid, cardIdx] of eventIdToCardIndex) {
                if (cardIdx > mergeIdx) {
                  eventIdToCardIndex.set(eid, cardIdx - 1);
                }
              }

              targetCardIndex = keepIdx;
            } else {
              targetCardIndex = idx;
            }
          }
        }

        if (targetCardIndex !== undefined) {
          // 既存スレッドにノートを追加
          const card = updatedCards[targetCardIndex]!;
          const newNotes = new Map<string, ThreadNote>();
          for (const n of card.notes) newNotes.set(n.eventId, n);

          // リプライ自体
          const replyNote = allNotesLookup.get(replyEvent.id);
          if (replyNote && !newNotes.has(replyEvent.id)) {
            newNotes.set(replyEvent.id, replyNote);
          }

          // 参照先
          for (const refId of refIds) {
            if (!newNotes.has(refId)) {
              const note = allNotesLookup.get(refId);
              if (note) newNotes.set(refId, note);
            }
          }

          const sorted = [...newNotes.values()].sort(
            (a, b) => a.created_at - b.created_at,
          );
          const resolved = resolveReplyAuthors(sorted);
          const newEventIds = new Set(card.eventIds);
          for (const n of resolved) newEventIds.add(n.eventId);

          const latestCreatedAt =
            resolved.length > 0
              ? Math.max(...resolved.map((n) => n.created_at))
              : card.created_at;

          const now = Math.floor(Date.now() / 1000);
          const hasOwnerNote = resolved.some((n) => n.pubkey === pubkey);
          const halfLife = hasOwnerNote
            ? OWNER_SCORE_HALF_LIFE
            : SCORE_HALF_LIFE;

          updatedCards[targetCardIndex] = {
            ...card,
            notes: resolved,
            eventIds: newEventIds,
            created_at: latestCreatedAt,
            score: calcFreshnessScore(latestCreatedAt, now, halfLife),
          };

          // index 更新
          for (const eid of newEventIds) {
            eventIdToCardIndex.set(eid, targetCardIndex);
          }
        } else {
          // 新規スレッド作成
          const threadNotes = new Map<string, ThreadNote>();

          // リプライ自体
          const replyNote = allNotesLookup.get(replyEvent.id);
          if (replyNote) threadNotes.set(replyEvent.id, replyNote);

          // 参照先
          for (const refId of refIds) {
            if (!threadNotes.has(refId)) {
              const note = allNotesLookup.get(refId);
              if (note) threadNotes.set(refId, note);
            }
          }

          const sorted = [...threadNotes.values()].sort(
            (a, b) => a.created_at - b.created_at,
          );
          const resolved = resolveReplyAuthors(sorted);
          const threadEventIds = new Set(
            resolved.map((n) => n.eventId),
          );

          const latestCreatedAt =
            resolved.length > 0
              ? Math.max(...resolved.map((n) => n.created_at))
              : replyEvent.created_at;

          const now = Math.floor(Date.now() / 1000);
          const hasOwnerNote = resolved.some((n) => n.pubkey === pubkey);
          const halfLife = hasOwnerNote
            ? OWNER_SCORE_HALF_LIFE
            : SCORE_HALF_LIFE;

          const newCard: ThreadCard = {
            type: "thread",
            slotId: crypto.randomUUID(),
            pubkey: resolved[0]?.pubkey ?? replyEvent.pubkey,
            score: calcFreshnessScore(latestCreatedAt, now, halfLife),
            fadingOut: false,
            created_at: latestCreatedAt,
            notes: resolved,
            eventIds: threadEventIds,
          };

          const newCardIndex = updatedCards.length;
          updatedCards = [...updatedCards, newCard];

          for (const eid of threadEventIds) {
            eventIdToCardIndex.set(eid, newCardIndex);
          }
        }
      }

      // threadGroups を更新
      const nextThreadGroups = new Map<string, string[]>();
      for (const card of updatedCards) {
        // root eventId をキーにする（notes[0] の eventId）
        const rootId =
          card.notes.length > 0 ? card.notes[0]!.eventId : card.slotId;
        nextThreadGroups.set(rootId, [...card.eventIds]);
      }

      // スレッドに含まれる全 eventId を収集
      const threadEventIds = new Set<string>();
      for (const card of updatedCards) {
        for (const eid of card.eventIds) {
          threadEventIds.add(eid);
        }
      }

      // non-thread cards からスレッドに含まれるノートを除外
      const filteredNonThread = nonThreadCards.filter((c) => {
        if (c.type === "note") return !threadEventIds.has(c.eventId);
        return true;
      });

      return {
        threadGroups: nextThreadGroups,
        cards: [...filteredNonThread, ...updatedCards],
      };
    });
  },
});
