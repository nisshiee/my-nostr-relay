/**
 * store/slices/feed.ts
 *
 * kind:1/6 フィード購読・ノート追加・リポスト解決。
 * hooks/useNostrNotes.ts からの移植。
 *
 * 主要アクション:
 * - subscribeFeed: kind:1/6 を購読し、タイムラインを構築
 * - resolveRepost: 単一リポストの元ノートを解決
 * - resolveReposts: 複数リポストを一括解決
 *
 * 連鎖フロー:
 *   subscribeFeed → onEose → resolveReposts → subscribeReactions
 */

import type { Event } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import type { SubCloser } from "nostr-tools/abstract-pool";
import type { StateCreator } from "zustand";
import type { CanvasStore, Unsubscribe, RepostMeta } from "../types";
import type { NoteCard } from "../../lib/types";
import { createNoteCard } from "../pure/buildCards";
import { sortByScore } from "../pure/scoring";
import {
  INITIAL_NOTES_LIMIT,
  MAX_NOTES,
  BOOTSTRAP_EOSE_TIMEOUT,
} from "../../lib/constants";

// ---------------------------------------------------------------------------
// Slice 型
// ---------------------------------------------------------------------------

export interface FeedSlice {
  // state
  events: Map<string, Event>;
  repostMeta: Map<string, RepostMeta>;
  timelineIds: string[];
  cards: NoteCard[];
  _feedSub: SubCloser | null;

  // actions
  subscribeFeed: () => Unsubscribe;
  resolveRepost: (repostEvent: Event) => Promise<void>;
  resolveReposts: (repostEvents: Event[]) => Promise<void>;
}

// ---------------------------------------------------------------------------
// 内部ヘルパー
// ---------------------------------------------------------------------------

/**
 * events Map と repostMeta から NoteCard[] を再構築する。
 * timelineIds の順序で events を参照し、スコア順でソート後 MAX_NOTES で切り詰め。
 */
function rebuildCards(
  events: Map<string, Event>,
  repostMeta: Map<string, RepostMeta>,
  pubkey: string | null,
  now: number,
  existingCards?: ReadonlyArray<{ type: string; slotId: string; eventId?: string }>,
): NoteCard[] {
  // 既存カードの slotId を eventId で引けるようにする（NoteCard のみ）
  const slotIdByEventId = new Map<string, string>();
  if (existingCards) {
    for (const card of existingCards) {
      if (card.type === "note" && "eventId" in card && card.eventId) {
        slotIdByEventId.set(card.eventId, card.slotId);
      }
    }
  }

  const cards: NoteCard[] = [];
  for (const [, event] of events) {
    if (event.kind !== 1) continue;
    const repostInfo = repostMeta.get(event.id);
    cards.push(
      createNoteCard({
        event,
        ownerPubkey: pubkey,
        now,
        // 既存カードの slotId を維持（安定化）。なければ eventId を使う。
        slotId: slotIdByEventId.get(event.id) ?? event.id,
        repostInfo: repostInfo
          ? {
              reposterPubkey: repostInfo.reposterPubkey,
              repostedAt: repostInfo.repostedAt,
            }
          : undefined,
      }),
    );
  }
  return sortByScore(cards).slice(0, MAX_NOTES);
}

/**
 * kind:6 リポストイベントから元ノートの eventId を抽出する。
 * 最後の "e" タグを使用（NIP-18）。
 */
function extractOriginalEventId(repostEvent: Event): string | undefined {
  const eTags = repostEvent.tags.filter((tag) => tag[0] === "e" && tag[1]);
  if (eTags.length === 0) return undefined;
  return eTags[eTags.length - 1]![1]!;
}

// ---------------------------------------------------------------------------
// Slice 実装
// ---------------------------------------------------------------------------

export const createFeedSlice: StateCreator<
  CanvasStore,
  [],
  [],
  FeedSlice
> = (set, get) => ({
  // --- initial state ---
  events: new Map(),
  repostMeta: new Map(),
  timelineIds: [],
  cards: [],
  _feedSub: null,

  // --- actions ---

  /**
   * kind:1/6 の購読を開始する。
   *
   * 初期ロードフロー:
   * 1. 初期ロード中は events をバッファに溜める
   * 2. oneose で一括 state 反映 → cards 構築
   * 3. kind:6 リポストを resolveReposts で一括解決
   * 4. subscribeReactions を呼び出し
   *
   * EOSE 後はリアルタイムで event を追加。
   *
   * @returns 購読解除関数
   */
  subscribeFeed: () => {
    const { _pool, relayUrls, followPubkeys, pubkey } = get();
    if (
      !_pool ||
      relayUrls.length === 0 ||
      followPubkeys.length === 0 ||
      !pubkey
    ) {
      return () => {};
    }

    let cancelled = false;
    const pool = _pool;

    // 初期ロードバッファ
    const initialNoteBuffer: Event[] = [];
    const initialRepostBuffer: Event[] = [];
    let initialLoading = true;

    // リアルタイムリポスト: 元ノート取得中の eventId を管理（重複 REQ 防止）
    const inflightOriginalNotes = new Set<string>();

    /**
     * リアルタイムリポスト処理: EOSE 後に受信した kind:6 の元ノートを個別 REQ で取得
     */
    const handleRealtimeRepost = async (repostEvent: Event) => {
      const originalEventId = extractOriginalEventId(repostEvent);
      if (!originalEventId) return;

      if (inflightOriginalNotes.has(originalEventId)) return;
      inflightOriginalNotes.add(originalEventId);

      try {
        const urls = get().relayUrls;
        const originalEvents = await pool.querySync(
          urls,
          { kinds: [1], ids: [originalEventId] } as Filter,
          { maxWait: BOOTSTRAP_EOSE_TIMEOUT },
        );

        if (cancelled) return;

        if (originalEvents.length > 0) {
          const origEvent = originalEvents[0]!;
          if (origEvent.kind !== 1) return;

          const now = Math.floor(Date.now() / 1000);

          set((state) => {
            const nextEvents = new Map(state.events);
            nextEvents.set(origEvent.id, origEvent);

            const nextRepostMeta = new Map(state.repostMeta);
            const existing = nextRepostMeta.get(origEvent.id);
            if (
              !existing ||
              repostEvent.created_at > existing.repostedAt
            ) {
              nextRepostMeta.set(origEvent.id, {
                reposterPubkey: repostEvent.pubkey,
                repostedAt: repostEvent.created_at,
              });
            }

            const nextTimelineIds = state.timelineIds.includes(origEvent.id)
              ? state.timelineIds
              : [...state.timelineIds, origEvent.id];

            return {
              events: nextEvents,
              repostMeta: nextRepostMeta,
              timelineIds: nextTimelineIds,
              cards: rebuildCards(
                nextEvents,
                nextRepostMeta,
                state.pubkey,
                now,
                state.cards,
              ),
            };
          });

          // フォロー外のプロフィールを取得
          const state = get();
          const unknownPubkeys = [origEvent.pubkey, repostEvent.pubkey].filter(
            (pk) => !state.profiles.has(pk),
          );
          if (unknownPubkeys.length > 0) {
            get().ensureProfiles(unknownPubkeys);
          }

          console.log(
            `[feed] リアルタイムリポスト処理完了: 元ノート ${originalEventId.slice(0, 8)}...`,
          );
        }
      } catch (err) {
        console.error(`[feed] リアルタイムリポスト元ノート取得エラー:`, err);
      } finally {
        inflightOriginalNotes.delete(originalEventId);
      }
    };

    const feedSub: SubCloser = pool.subscribeMany(
      relayUrls,
      {
        kinds: [1, 6],
        authors: followPubkeys,
        limit: INITIAL_NOTES_LIMIT,
      } as Filter,
      {
        onevent(event: Event) {
          if (cancelled) return;

          if (initialLoading) {
            if (event.kind === 6) {
              initialRepostBuffer.push(event);
            } else {
              initialNoteBuffer.push(event);
            }
          } else {
            // リアルタイム処理
            if (event.kind === 1) {
              const now = Math.floor(Date.now() / 1000);
              set((state) => {
                if (state.events.has(event.id)) return state;
                const nextEvents = new Map(state.events);
                nextEvents.set(event.id, event);
                const nextTimelineIds = [...state.timelineIds, event.id];
                return {
                  events: nextEvents,
                  timelineIds: nextTimelineIds,
                  cards: rebuildCards(
                    nextEvents,
                    state.repostMeta,
                    state.pubkey,
                    now,
                  ),
                };
              });
            } else if (event.kind === 6) {
              handleRealtimeRepost(event);
            }
          }
        },
        async oneose() {
          if (cancelled) return;
          initialLoading = false;

          const now = Math.floor(Date.now() / 1000);

          // kind:1 バッファを一括で state に反映
          const nextEvents = new Map(get().events);
          const seen = new Set<string>();
          const nextTimelineIds: string[] = [...get().timelineIds];

          for (const event of initialNoteBuffer) {
            if (seen.has(event.id)) continue;
            seen.add(event.id);
            nextEvents.set(event.id, event);
            nextTimelineIds.push(event.id);
          }

          const initialCards = rebuildCards(
            nextEvents,
            get().repostMeta,
            pubkey,
            now,
            get().cards,
          );

          set({
            events: nextEvents,
            timelineIds: nextTimelineIds,
            cards: initialCards,
          });

          console.log(
            `[feed] 初期ロード完了: kind:1=${initialNoteBuffer.length}件, kind:6(リポスト)=${initialRepostBuffer.length}件`,
          );

          // kind:6 リポストを一括解決
          if (initialRepostBuffer.length > 0) {
            await get().resolveReposts(initialRepostBuffer);
          }

          if (cancelled) return;

          // phase を ready に
          set({ phase: "ready" });

          // subscribeReactions を呼び出し（連鎖フロー）
          const currentCards = get().cards;
          const eventIds = currentCards.map((c) =>
            c.type === "note" ? c.eventId : "",
          ).filter(Boolean);
          if (eventIds.length > 0) {
            get().subscribeReactions(eventIds);
          }
        },
      },
    );

    set({ _feedSub: feedSub });

    // 購読解除関数
    return () => {
      cancelled = true;
      try {
        feedSub.close();
      } catch {
        // already closed
      }
      inflightOriginalNotes.clear();
      set({ _feedSub: null });
    };
  },

  /**
   * 単一の kind:6 リポストイベントから元ノートを解決する。
   */
  resolveRepost: async (repostEvent: Event) => {
    const originalEventId = extractOriginalEventId(repostEvent);
    if (!originalEventId) return;

    const { _pool, relayUrls, _inflight } = get();
    if (!_pool || relayUrls.length === 0) return;

    // インフライト重複排除
    if (_inflight.has(`repost:${originalEventId}`)) return;
    const nextInflight = new Set(_inflight);
    nextInflight.add(`repost:${originalEventId}`);
    set({ _inflight: nextInflight });

    try {
      const originalEvents = await _pool.querySync(
        relayUrls,
        { kinds: [1], ids: [originalEventId] } as Filter,
        { maxWait: BOOTSTRAP_EOSE_TIMEOUT },
      );

      if (originalEvents.length > 0) {
        const origEvent = originalEvents[0]!;
        if (origEvent.kind !== 1) return;

        const now = Math.floor(Date.now() / 1000);

        set((state) => {
          const nextEvents = new Map(state.events);
          nextEvents.set(origEvent.id, origEvent);

          const nextRepostMeta = new Map(state.repostMeta);
          const existing = nextRepostMeta.get(origEvent.id);
          if (
            !existing ||
            repostEvent.created_at > existing.repostedAt
          ) {
            nextRepostMeta.set(origEvent.id, {
              reposterPubkey: repostEvent.pubkey,
              repostedAt: repostEvent.created_at,
            });
          }

          const nextTimelineIds = state.timelineIds.includes(origEvent.id)
            ? state.timelineIds
            : [...state.timelineIds, origEvent.id];

          return {
            events: nextEvents,
            repostMeta: nextRepostMeta,
            timelineIds: nextTimelineIds,
            cards: rebuildCards(
              nextEvents,
              nextRepostMeta,
              state.pubkey,
              now,
            ),
          };
        });
      }
    } catch (err) {
      console.error(`[feed] resolveRepost エラー:`, err);
    } finally {
      const updatedInflight = new Set(get()._inflight);
      updatedInflight.delete(`repost:${originalEventId}`);
      set({ _inflight: updatedInflight });
    }
  },

  /**
   * 複数の kind:6 リポストイベントを一括解決する。
   *
   * 1. repostEvents から originalEventId を集約（重複排除、最新リポスト優先）
   * 2. 既に events Map にあるものは repostMeta のみ更新
   * 3. 未取得の元ノートを一括 querySync で取得
   * 4. cards を再構築
   * 5. 関連プロフィールを ensureProfiles
   */
  resolveReposts: async (repostEvents: Event[]) => {
    const { _pool, relayUrls, followPubkeys } = get();
    if (!_pool || relayUrls.length === 0) return;

    // originalEventId → 最新リポストイベント のマップ
    const repostMap = new Map<string, Event>();
    for (const repostEvent of repostEvents) {
      const originalEventId = extractOriginalEventId(repostEvent);
      if (!originalEventId) continue;
      const existing = repostMap.get(originalEventId);
      if (!existing || repostEvent.created_at > existing.created_at) {
        repostMap.set(originalEventId, repostEvent);
      }
    }

    if (repostMap.size === 0) return;

    const now = Math.floor(Date.now() / 1000);

    // 既存 events にある元ノートの repostMeta を更新
    const currentEvents = get().events;
    const existingIds: string[] = [];
    const missingIds: string[] = [];

    for (const [originalId] of repostMap) {
      if (currentEvents.has(originalId)) {
        existingIds.push(originalId);
      } else {
        missingIds.push(originalId);
      }
    }

    // 既存カードの repostMeta 更新
    if (existingIds.length > 0) {
      set((state) => {
        const nextRepostMeta = new Map(state.repostMeta);
        for (const id of existingIds) {
          const repostEvent = repostMap.get(id)!;
          const existing = nextRepostMeta.get(id);
          if (
            !existing ||
            repostEvent.created_at > existing.repostedAt
          ) {
            nextRepostMeta.set(id, {
              reposterPubkey: repostEvent.pubkey,
              repostedAt: repostEvent.created_at,
            });
          }
        }
        return {
          repostMeta: nextRepostMeta,
          cards: rebuildCards(
            state.events,
            nextRepostMeta,
            state.pubkey,
            now,
            get().cards,
          ),
        };
      });
    }

    // 未取得の元ノートを一括取得
    if (missingIds.length > 0) {
      console.log(
        `[feed] リポスト元ノート取得開始: ${missingIds.length}件`,
      );
      try {
        const originalEvents = await _pool.querySync(
          relayUrls,
          { kinds: [1], ids: missingIds } as Filter,
          { maxWait: BOOTSTRAP_EOSE_TIMEOUT },
        );

        if (originalEvents.length > 0) {
          set((state) => {
            const nextEvents = new Map(state.events);
            const nextRepostMeta = new Map(state.repostMeta);
            const nextTimelineIds = [...state.timelineIds];

            for (const origEvent of originalEvents) {
              if (origEvent.kind !== 1) continue;
              nextEvents.set(origEvent.id, origEvent);

              const repostEvent = repostMap.get(origEvent.id);
              if (repostEvent) {
                const existing = nextRepostMeta.get(origEvent.id);
                if (
                  !existing ||
                  repostEvent.created_at > existing.repostedAt
                ) {
                  nextRepostMeta.set(origEvent.id, {
                    reposterPubkey: repostEvent.pubkey,
                    repostedAt: repostEvent.created_at,
                  });
                }
              }

              if (!nextTimelineIds.includes(origEvent.id)) {
                nextTimelineIds.push(origEvent.id);
              }
            }

            return {
              events: nextEvents,
              repostMeta: nextRepostMeta,
              timelineIds: nextTimelineIds,
              cards: rebuildCards(
                nextEvents,
                nextRepostMeta,
                state.pubkey,
                now,
                state.cards,
              ),
            };
          });

          console.log(
            `[feed] リポスト元ノート追加: ${originalEvents.length}件`,
          );
        }
      } catch (err) {
        console.error("[feed] リポスト元ノート取得エラー:", err);
      }
    }

    // リポスト関連の未取得プロフィールを一括フェッチ
    const followSet = new Set(followPubkeys);
    const repostPubkeys = new Set<string>();
    for (const [, repostEvent] of repostMap) {
      if (!followSet.has(repostEvent.pubkey)) {
        repostPubkeys.add(repostEvent.pubkey);
      }
    }
    // 元ノート著者でフォロー外のもの
    const currentState = get();
    for (const [eventId] of repostMap) {
      const event = currentState.events.get(eventId);
      if (event && !followSet.has(event.pubkey)) {
        repostPubkeys.add(event.pubkey);
      }
    }
    if (repostPubkeys.size > 0) {
      console.log(
        `[feed] リポスト関連プロフィール取得: ${repostPubkeys.size}件`,
      );
      get().ensureProfiles([...repostPubkeys]);
    }
  },
});
