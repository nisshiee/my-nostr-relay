import React, { useEffect, useRef, useState, useCallback } from "react";
import type { SimplePool } from "nostr-tools/pool";
import type { Event } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import type { SubCloser } from "nostr-tools/abstract-pool";
import {
  MAX_NOTES,
  INITIAL_NOTES_LIMIT,
} from "../lib/constants";
import { sortByScore } from "../lib/scoring";
import { createNoteCard, resolveSlotId } from "../lib/createNoteCard";
import type { NoteCard, NostrProfile } from "../lib/types";
import type { ConnectionStatus } from "./useNostrConnection";
import type { EventCache } from "./useEventCache";

export interface UseNostrNotesResult {
  notes: NoteCard[];
  notesRef: React.RefObject<NoteCard[]>;
  newNotesMinCreatedAtRef: React.MutableRefObject<number | undefined>;
}

/**
 * kind:1/6 subscribe、ノート追加・リポスト処理
 */
export function useNostrNotes(
  pool: SimplePool | null,
  relayUrls: string[],
  followPubkeys: string[],
  pubkey: string | null,
  publishedSlotMapRef: React.RefObject<Map<string, string>>,
  setStatus: (status: ConnectionStatus) => void,
  profilesRef: React.RefObject<Map<string, NostrProfile>>,
  fetchProfiles: (pubkeys: string[]) => void,
  onInitialNotesReady: (eventIds: string[]) => void,
  cache: EventCache,
): UseNostrNotesResult {
  const [notes, setNotes] = useState<NoteCard[]>([]);
  const notesRef = useRef<NoteCard[]>([]);
  const newNotesMinCreatedAtRef = useRef<number | undefined>(undefined);

  // コールバックをRefで保持（subscription内から最新の値を参照するため）
  const onInitialNotesReadyRef = useRef(onInitialNotesReady);
  const fetchProfilesRef = useRef(fetchProfiles);

  useEffect(() => {
    onInitialNotesReadyRef.current = onInitialNotesReady;
  }, [onInitialNotesReady]);

  useEffect(() => {
    fetchProfilesRef.current = fetchProfiles;
  }, [fetchProfiles]);

  /** ノートを追加（重複排除・スコア計算・prune込み） */
  const addNote = useCallback((event: Event) => {
    // 新規ノートのcreated_atを追跡（リアクション再subscribe時のsince計算用）
    if (
      newNotesMinCreatedAtRef.current === undefined ||
      event.created_at < newNotesMinCreatedAtRef.current
    ) {
      newNotesMinCreatedAtRef.current = event.created_at;
    }

    setNotes((prev) => {
      // eventIDで重複チェック
      if (prev.some((n) => n.eventId === event.id)) return prev;

      const now = Math.floor(Date.now() / 1000);
      const newNote = createNoteCard({
        event,
        ownerPubkey: pubkey,
        now,
        slotId: resolveSlotId(publishedSlotMapRef.current, event.id),
      });

      const updated = [...prev, newNote];

      // MAX_NOTES超過時はスコアが低いものを削除
      if (updated.length > MAX_NOTES) {
        const sorted = sortByScore(updated);
        return sorted.slice(0, MAX_NOTES);
      }

      return updated;
    });
  }, [pubkey, publishedSlotMapRef]);

  /**
   * 元ノートイベントをNoteCardに変換してstateに追加する（既存カードがあればrepostInfoを付与）
   * 初期ロードとリアルタイム処理の両方で使用する共通処理
   */
  const processOriginalNote = useCallback((origEvent: Event, repostEvent: Event) => {
    if (origEvent.kind !== 1) return;

    setNotes((prev) => {
      // 既にカードが存在する場合はrepostInfoを付与して更新
      const existingIndex = prev.findIndex((n) => n.eventId === origEvent.id);
      if (existingIndex !== -1) {
        const existing = prev[existingIndex]!;
        // 既にrepostInfoがある場合は、より新しいリポストで上書き
        if (existing.repostInfo && existing.repostInfo.repostedAt >= repostEvent.created_at) {
          return prev;
        }
        const updated = [...prev];
        updated[existingIndex] = {
          ...existing,
          repostInfo: {
            reposterPubkey: repostEvent.pubkey,
            repostedAt: repostEvent.created_at,
          },
        };
        return updated;
      }

      // 新規カードとして追加（repostInfo付き）
      const now = Math.floor(Date.now() / 1000);
      const newNote = createNoteCard({
        event: origEvent,
        ownerPubkey: pubkey,
        now,
        slotId: resolveSlotId(publishedSlotMapRef.current, origEvent.id),
        repostInfo: { reposterPubkey: repostEvent.pubkey, repostedAt: repostEvent.created_at },
      });

      const updated = [...prev, newNote];
      if (updated.length > MAX_NOTES) {
        return sortByScore(updated).slice(0, MAX_NOTES);
      }
      return updated;
    });
  }, [pubkey, publishedSlotMapRef]);

  // notesの最新値をrefで同期（タイマーコールバックからアクセスするため）
  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  // kind:1/6 subscribe
  useEffect(() => {
    if (!pool || relayUrls.length === 0 || followPubkeys.length === 0 || !pubkey) return;

    setStatus("loading");

    let cancelled = false;

    /**
     * リアルタイムリポスト処理: EOSE後に受信したkind:6イベントの元ノートを個別REQで取得する
     */
    const handleRealtimeRepost = async (repostEvent: Event) => {
      // "e" タグから元ノートのeventIDを抽出
      const eTags = repostEvent.tags.filter((tag) => tag[0] === "e" && tag[1]);
      if (eTags.length === 0) return;
      const originalEventId = eTags[eTags.length - 1]![1]!;

      try {
        // cache.fetchEvents で元ノートを取得（inflight重複排除はcache側で処理）
        const originalEvents = await cache.fetchEvents(
          { kinds: [1], ids: [originalEventId] } as Filter,
        );

        if (cancelled) return;

        if (originalEvents.length > 0) {
          const origEvent = originalEvents[0]!;
          processOriginalNote(origEvent, repostEvent);

          // フォロー外のプロフィールを追加取得（元ノート著者 + リポスター）
          const unknownPubkeys = [origEvent.pubkey, repostEvent.pubkey]
            .filter((pk) => !profilesRef.current.has(pk));
          if (unknownPubkeys.length > 0) {
            fetchProfilesRef.current(unknownPubkeys);
          }

          console.log(`[useNostrNotes] リアルタイムリポスト処理完了: 元ノート ${originalEventId.slice(0, 8)}...`);
        } else {
          console.warn(`[useNostrNotes] リアルタイムリポスト: 元ノートが見つかりません ${originalEventId.slice(0, 8)}...`);
        }
      } catch (err) {
        console.error(`[useNostrNotes] リアルタイムリポスト元ノート取得エラー:`, err);
      }
    };

    // 初期ロード中はバッファに溜めて oneose でまとめて state に反映する
    const initialBuffer: Event[] = [];
    const initialRepostBuffer: Event[] = [];
    let initialLoading = true;

    const notesSub: SubCloser = pool.subscribeMany(
      relayUrls,
      { kinds: [1, 6], authors: followPubkeys, limit: INITIAL_NOTES_LIMIT } as Filter,
      {
        onevent(event: Event) {
          if (cancelled) return;
          if (initialLoading) {
            if (event.kind === 6) {
              initialRepostBuffer.push(event);
            } else {
              initialBuffer.push(event);
            }
          } else {
            // リアルタイム処理
            if (event.kind === 1) {
              cache.addEvents([event]);
              addNote(event);
            } else if (event.kind === 6) {
              handleRealtimeRepost(event);
            }
          }
        },
        async oneose() {
          if (cancelled) return;
          initialLoading = false;
          // バッファを一括で state に反映
          let displayedNotes: NoteCard[] = [];
          // 初期ロードで受信したkind:1イベントをキャッシュに追加
          const kind1Events = initialBuffer.filter((e) => e.kind === 1);
          if (kind1Events.length > 0) {
            cache.addEvents(kind1Events);
          }

          if (initialBuffer.length > 0) {
            const now = Math.floor(Date.now() / 1000);
            const seen = new Set<string>();
            const batchNotes: NoteCard[] = [];
            for (const event of initialBuffer) {
              if (seen.has(event.id)) continue;
              seen.add(event.id);
              batchNotes.push(createNoteCard({
                event,
                ownerPubkey: pubkey,
                now,
                slotId: resolveSlotId(publishedSlotMapRef.current, event.id),
              }));
            }
            displayedNotes = sortByScore(batchNotes).slice(0, MAX_NOTES);
            setNotes(displayedNotes);
          }
          console.log(`[useNostrNotes] 初期ロード完了: kind:1=${initialBuffer.length}件, kind:6(リポスト)=${initialRepostBuffer.length}件`);

          // kind:6リポストから元ノートのeventIDを集約して一括取得
          if (initialRepostBuffer.length > 0) {
            const repostMap = new Map<string, Event>();
            for (const repostEvent of initialRepostBuffer) {
              const eTags = repostEvent.tags.filter((tag) => tag[0] === "e" && tag[1]);
              if (eTags.length === 0) continue;
              const originalEventId = eTags[eTags.length - 1]![1]!;
              const existing = repostMap.get(originalEventId);
              if (!existing || repostEvent.created_at > existing.created_at) {
                repostMap.set(originalEventId, repostEvent);
              }
            }

            // 既にdisplayedNotesに含まれている元ノートIDを除外
            const existingEventIds = new Set(displayedNotes.map((n) => n.eventId));
            const missingEventIds = [...repostMap.keys()].filter((id) => !existingEventIds.has(id));

            // 既存カードのrepostInfo更新
            const existingUpdates = [...repostMap.entries()].filter(([id]) => existingEventIds.has(id));
            if (existingUpdates.length > 0) {
              const updatedNotes = displayedNotes.map((note) => {
                const repostEvent = repostMap.get(note.eventId);
                if (!repostEvent) return note;
                return {
                  ...note,
                  repostInfo: {
                    reposterPubkey: repostEvent.pubkey,
                    repostedAt: repostEvent.created_at,
                  },
                };
              });
              displayedNotes = updatedNotes;
              setNotes(displayedNotes);
            }

            // 未取得の元ノートを一括REQで取得
            if (missingEventIds.length > 0) {
              console.log(`[useNostrNotes] リポスト元ノート取得開始: ${missingEventIds.length}件`);
              try {
                const originalEvents = await cache.fetchEvents(
                  { kinds: [1], ids: missingEventIds } as Filter,
                );
                if (!cancelled && originalEvents.length > 0) {
                  const now = Math.floor(Date.now() / 1000);
                  const newCards: NoteCard[] = [];
                  for (const origEvent of originalEvents) {
                    if (origEvent.kind !== 1) continue;
                    if (displayedNotes.some((n) => n.eventId === origEvent.id)) continue;
                    const repostEvent = repostMap.get(origEvent.id);
                    if (!repostEvent) continue;
                    newCards.push(createNoteCard({
                      event: origEvent,
                      ownerPubkey: pubkey,
                      now,
                      slotId: resolveSlotId(publishedSlotMapRef.current, origEvent.id),
                      repostInfo: { reposterPubkey: repostEvent.pubkey, repostedAt: repostEvent.created_at },
                    }));
                  }
                  if (newCards.length > 0) {
                    displayedNotes = sortByScore([...displayedNotes, ...newCards]).slice(0, MAX_NOTES);
                    setNotes(displayedNotes);
                    console.log(`[useNostrNotes] リポスト元ノート追加: ${newCards.length}件`);
                  }
                }
              } catch (err) {
                console.error("[useNostrNotes] リポスト元ノート取得エラー:", err);
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
            for (const note of displayedNotes) {
              if (note.repostInfo && !followSet.has(note.pubkey)) {
                repostPubkeys.add(note.pubkey);
              }
            }
            if (repostPubkeys.size > 0) {
              console.log(`[useNostrNotes] リポスト関連プロフィール取得: ${repostPubkeys.size}件`);
              fetchProfilesRef.current([...repostPubkeys]);
            }
          }

          setStatus("connected");

          // 初期ロード完了 — リアクションhookにeventIdリストを通知
          const eventIds = displayedNotes.map((n) => n.eventId);
          onInitialNotesReadyRef.current(eventIds);
        },
      },
    );

    return () => {
      cancelled = true;
      try {
        notesSub.close();
      } catch {
        // 既に閉じている場合は無視
      }
    };
  }, [pool, relayUrls, followPubkeys, pubkey, publishedSlotMapRef, addNote, processOriginalNote, profilesRef, setStatus, cache]);

  return { notes, notesRef, newNotesMinCreatedAtRef };
}
