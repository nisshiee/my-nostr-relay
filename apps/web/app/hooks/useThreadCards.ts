import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import type { SimplePool } from "nostr-tools/pool";
import type { Event } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import type { NoteCard, ThreadCard, ThreadNote } from "../lib/types";
import type { EventCache } from "./useEventCache";
import { BOOTSTRAP_EOSE_TIMEOUT, MAX_THREAD_DEPTH, SCORE_HALF_LIFE, OWNER_SCORE_HALF_LIFE } from "../lib/constants";
import { calcFreshnessScore } from "../lib/scoring";
import { resolveReplyAuthors } from "../lib/threadBuilder";

// --- ヘルパー関数 ---

/** ノートがリプライかどうか判定（"e" タグを持つ） */
function isReply(tags: string[][]): boolean {
  return tags.some((tag) => tag[0] === "e" && tag[1]);
}

/** タグから参照先の eventId を全て抽出 */
function extractReplyEventIds(tags: string[][]): string[] {
  return tags
    .filter((tag) => tag[0] === "e" && tag[1])
    .map((tag) => tag[1]!);
}

/** NIP-10準拠: 最後の "e" タグを直接返信先として取得 */
function extractReplyTo(tags: string[][]): { eventId: string; pubkey?: string } | undefined {
  const eTags = tags.filter((tag) => tag[0] === "e" && tag[1]);
  if (eTags.length === 0) return undefined;

  // NIP-10: marker付きタグを優先
  const replyTag = eTags.find((tag) => tag[3] === "reply");
  if (replyTag) {
    return { eventId: replyTag[1]!, pubkey: replyTag[4] || undefined };
  }

  // marker付きがなければ最後の "e" タグを返信先とする（NIP-10 positional方式）
  const lastETag = eTags[eTags.length - 1]!;
  return { eventId: lastETag[1]!, pubkey: lastETag[4] || undefined };
}

/** NoteCard → ThreadNote 変換 */
function noteCardToThreadNote(note: NoteCard): ThreadNote {
  return {
    eventId: note.eventId,
    pubkey: note.pubkey,
    content: note.content,
    created_at: note.created_at,
    tags: note.tags,
    replyTo: extractReplyTo(note.tags),
  };
}

/** Event → ThreadNote 変換（リレーから取得した祖先イベント用） */
function eventToThreadNote(event: Event): ThreadNote {
  return {
    eventId: event.id,
    pubkey: event.pubkey,
    content: event.content,
    created_at: event.created_at,
    tags: event.tags,
    replyTo: extractReplyTo(event.tags),
  };
}

/** ThreadNote配列をcreated_at昇順でソート */
function sortThreadNotes(notes: ThreadNote[]): ThreadNote[] {
  return [...notes].sort((a, b) => a.created_at - b.created_at);
}

/** イベント群から未知の参照先eventIdを収集 */
function collectMissingEventIds(knownIds: Set<string>, events: Event[]): string[] {
  const missing = new Set<string>();
  for (const event of events) {
    const refIds = extractReplyEventIds(event.tags);
    for (const id of refIds) {
      if (!knownIds.has(id)) {
        missing.add(id);
      }
    }
  }
  return [...missing];
}

// --- デバウンス用定数 ---
const THREAD_PROCESS_DEBOUNCE_MS = 200;

// --- メインフック ---

interface UseThreadCardsResult {
  /** スレッドに属さないノート（タイムライン表示用） */
  filteredNotes: NoteCard[];
  /** 構築済みスレッドカード */
  threadCards: ThreadCard[];
  /** 初回スレッド構築が完了するまで true */
  isProcessing: boolean;
}

/**
 * ノート配列からリプライスレッドを検出・構築するフック
 *
 * - リプライ（"e"タグ付き）のノートを検出
 * - 祖先イベントを再帰的にフェッチ
 * - ThreadCardを構築・マージ
 * - スレッドに含まれるNoteCardをフィルタリング
 */
export function useThreadCards(
  notes: NoteCard[],
  pubkey: string | null,
  relayUrls: string[],
  pool: SimplePool | null,
  status: "connecting" | "loading" | "connected" | "error",
  cache: EventCache,
): UseThreadCardsResult {
  const [threadCards, setThreadCards] = useState<ThreadCard[]>([]);
  const [isProcessing, setIsProcessing] = useState(true);
  const initialProcessingDoneRef = useRef(false);

  // スレッドに含まれる全eventIdの集合（filteredNotes計算用）
  const [threadEventIds, setThreadEventIds] = useState<Set<string>>(new Set());
  // 処理済みリプライeventId（再処理防止）
  const processedReplyIdsRef = useRef<Set<string>>(new Set());

  /** 祖先イベントを再帰的にフェッチ（ref 経由で再帰呼び出し） */
  const fetchThreadAncestorsRef = useRef<(ids: string[], depth?: number) => Promise<Event[]>>(
    async () => [],
  );

  const fetchThreadAncestors = useCallback(
    async (
      eventIdsToFetch: string[],
      depth: number = 0,
    ): Promise<Event[]> => {
      if (depth >= MAX_THREAD_DEPTH || eventIdsToFetch.length === 0) {
        return [];
      }

      try {
        const events = await cache.fetchEvents(
          { kinds: [1], ids: eventIdsToFetch } as Filter,
          { maxWait: BOOTSTRAP_EOSE_TIMEOUT },
        );

        // 祖先のプロフィールを確保（フォロー外ユーザー対応）
        const ancestorPubkeys = [...new Set(events.map((e) => e.pubkey))];
        if (ancestorPubkeys.length > 0) {
          cache.ensureProfiles(ancestorPubkeys);
        }

        // 取得済みIDを収集（cache内部 + 今回取得分）
        const knownIds = new Set<string>(eventIdsToFetch);
        for (const event of events) {
          knownIds.add(event.id);
        }

        // さらに遡る必要のある未知の参照を収集
        const nextMissing = collectMissingEventIds(knownIds, events);
        if (nextMissing.length > 0) {
          const deeper = await fetchThreadAncestorsRef.current(nextMissing, depth + 1);
          return [...events, ...deeper];
        }

        return events;
      } catch (err) {
        console.error("[useThreadCards] 祖先フェッチエラー:", err);
        return [];
      }
    },
    [cache],
  );

  // ref を最新に同期（再帰呼び出し用）
  useEffect(() => {
    fetchThreadAncestorsRef.current = fetchThreadAncestors;
  }, [fetchThreadAncestors]);

  // notes変更時のスレッド処理（デバウンス付き）
  useEffect(() => {
    if (notes.length === 0 || relayUrls.length === 0) {
      // EOSE到達後（connected）にnotesが空 → 初回処理完了
      if (status === "connected" && !initialProcessingDoneRef.current) {
        initialProcessingDoneRef.current = true;
        // queueMicrotask で同期 setState を回避
        queueMicrotask(() => setIsProcessing(false));
      }
      return;
    }

    let cancelled = false;

    const timer = setTimeout(() => {
      // 新しいリプライを検出
      const newReplies: NoteCard[] = [];
      for (const note of notes) {
        if (processedReplyIdsRef.current.has(note.eventId)) continue;
        if (!isReply(note.tags)) continue;
        newReplies.push(note);
      }

      if (newReplies.length === 0) {
        if (!initialProcessingDoneRef.current) {
          initialProcessingDoneRef.current = true;
          setIsProcessing(false);
        }
        return;
      }

      // notes をキャッシュに登録
      cache.addEvents(notes.map((note) => ({
        id: note.eventId,
        pubkey: note.pubkey,
        content: note.content,
        created_at: note.created_at,
        tags: note.tags,
        kind: 1,
        sig: "",
      } satisfies Event)));

      // 各リプライについてスレッド構築
      const processReplies = async () => {
        // リプライをグルーピング: 共通の参照eventIdを持つリプライは同じスレッドに
        const replyGroups: { note: NoteCard; refIds: string[] }[] = [];
        for (const note of newReplies) {
          const refIds = extractReplyEventIds(note.tags);
          replyGroups.push({ note, refIds });
        }

        // 未フェッチの祖先eventIdを収集（cache が既知イベントを管理）
        const allMissingIds = new Set<string>();
        for (const { refIds } of replyGroups) {
          for (const id of refIds) {
            if (!cache.getEvent(id)) {
              allMissingIds.add(id);
            }
          }
        }

        // 祖先を一括フェッチ
        let fetchedEvents: Event[] = [];
        if (allMissingIds.size > 0) {
          fetchedEvents = await fetchThreadAncestors([...allMissingIds]);
        }

        // キャンセルチェック
        if (cancelled) return;

        // フェッチした祖先をThreadNoteに変換
        const fetchedNotesMap = new Map<string, ThreadNote>();
        for (const event of fetchedEvents) {
          fetchedNotesMap.set(event.id, eventToThreadNote(event));
        }

        // 既存notesからもThreadNoteを構築（EventIDでルックアップ用）
        const notesMap = new Map<string, NoteCard>();
        for (const note of notes) {
          notesMap.set(note.eventId, note);
        }

        // スレッドを構築・マージ（immutable更新）
        setThreadCards((prev) => {
          // 全カードのディープコピー（immutable更新のため）
          let updatedCards: ThreadCard[] = prev.map((card) => ({
            ...card,
            notes: [...card.notes],
            eventIds: new Set(card.eventIds),
          }));

          // 既存スレッドのeventIds → index マッピング
          const eventIdToCardIndex = new Map<string, number>();
          for (let i = 0; i < updatedCards.length; i++) {
            for (const eid of updatedCards[i]!.eventIds) {
              eventIdToCardIndex.set(eid, i);
            }
          }

          for (const { note, refIds } of replyGroups) {
            // このリプライが既存スレッドに属するか検索
            const allRelatedIds = [note.eventId, ...refIds];
            let targetCardIndex: number | undefined;

            for (const id of allRelatedIds) {
              const idx = eventIdToCardIndex.get(id);
              if (idx !== undefined) {
                if (targetCardIndex !== undefined && targetCardIndex !== idx) {
                  // 2つの異なるスレッドがマージされるケース
                  const keepIdx = Math.min(targetCardIndex, idx);
                  const mergeIdx = Math.max(targetCardIndex, idx);
                  const keepCard = updatedCards[keepIdx]!;
                  const mergeCard = updatedCards[mergeIdx]!;

                  // マージ: 新しいノート配列とeventIds集合を構築
                  const mergedNotes = [...keepCard.notes];
                  const mergedEventIds = new Set(keepCard.eventIds);
                  for (const mn of mergeCard.notes) {
                    if (!mergedEventIds.has(mn.eventId)) {
                      mergedNotes.push(mn);
                      mergedEventIds.add(mn.eventId);
                    }
                  }

                  // keepCard を新しいオブジェクトで置き換え
                  updatedCards[keepIdx] = {
                    ...keepCard,
                    notes: resolveReplyAuthors(sortThreadNotes(mergedNotes)),
                    eventIds: mergedEventIds,
                  };

                  // マージ元を削除
                  updatedCards = [
                    ...updatedCards.slice(0, mergeIdx),
                    ...updatedCards.slice(mergeIdx + 1),
                  ];

                  // eventIdToCardIndex を再構築
                  for (const eid of mergeCard.eventIds) {
                    eventIdToCardIndex.set(eid, keepIdx);
                  }
                  // mergeIdx以降のindexをずらす
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
              // 既存スレッドにノートを追加（immutable）
              const card = updatedCards[targetCardIndex]!;
              const newNotes = [...card.notes];
              const newEventIds = new Set(card.eventIds);

              const threadNote = noteCardToThreadNote(note);
              if (!newEventIds.has(note.eventId)) {
                newNotes.push(threadNote);
                newEventIds.add(note.eventId);
                eventIdToCardIndex.set(note.eventId, targetCardIndex);
              }

              // 参照先のフェッチ結果も追加
              for (const refId of refIds) {
                if (!newEventIds.has(refId)) {
                  const fetched = fetchedNotesMap.get(refId);
                  const existingNote = notesMap.get(refId);
                  const noteToAdd = fetched ?? (existingNote ? noteCardToThreadNote(existingNote) : undefined);
                  if (noteToAdd) {
                    newNotes.push(noteToAdd);
                    newEventIds.add(refId);
                    eventIdToCardIndex.set(refId, targetCardIndex);
                  }
                }
              }

              // ソートしてreplyTo.pubkey解決、スコア更新、新しいオブジェクトで置き換え
              const sortedNotes = resolveReplyAuthors(sortThreadNotes(newNotes));
              const latestCreatedAt = sortedNotes.length > 0
                ? Math.max(...sortedNotes.map((n) => n.created_at))
                : note.created_at;

              const now = Math.floor(Date.now() / 1000);
              const hasOwnerNote = sortedNotes.some(n => n.pubkey === pubkey);
              const halfLife = hasOwnerNote ? OWNER_SCORE_HALF_LIFE : SCORE_HALF_LIFE;

              updatedCards[targetCardIndex] = {
                ...card,
                notes: sortedNotes,
                eventIds: newEventIds,
                created_at: latestCreatedAt,
                score: calcFreshnessScore(latestCreatedAt, now, halfLife),
              };
            } else {
              // 新規スレッド作成
              const threadNotes: ThreadNote[] = [noteCardToThreadNote(note)];
              const eventIds = new Set<string>([note.eventId]);

              // 参照先を追加
              for (const refId of refIds) {
                if (eventIds.has(refId)) continue;
                const fetched = fetchedNotesMap.get(refId);
                const existingNote = notesMap.get(refId);
                const noteToAdd = fetched ?? (existingNote ? noteCardToThreadNote(existingNote) : undefined);
                if (noteToAdd) {
                  threadNotes.push(noteToAdd);
                  eventIds.add(refId);
                }
              }

              const sortedNotes = resolveReplyAuthors(sortThreadNotes(threadNotes));
              const latestCreatedAt = sortedNotes.length > 0
                ? Math.max(...sortedNotes.map((n) => n.created_at))
                : note.created_at;
              const newCardIndex = updatedCards.length;
              const now = Math.floor(Date.now() / 1000);
              const hasOwnerNote = sortedNotes.some(n => n.pubkey === pubkey);
              const halfLife = hasOwnerNote ? OWNER_SCORE_HALF_LIFE : SCORE_HALF_LIFE;

              const newCard: ThreadCard = {
                type: "thread",
                slotId: crypto.randomUUID(),
                pubkey: sortedNotes[0]?.pubkey ?? note.pubkey,
                score: calcFreshnessScore(latestCreatedAt, now, halfLife),
                fadingOut: false,
                created_at: latestCreatedAt,
                notes: sortedNotes,
                eventIds,
              };
              updatedCards = [...updatedCards, newCard];

              // index更新
              for (const eid of eventIds) {
                eventIdToCardIndex.set(eid, newCardIndex);
              }
            }
          }

          // threadEventIdsRef を更新（filteredNotes計算用）
          const allThreadEventIds = new Set<string>();
          for (const card of updatedCards) {
            for (const eid of card.eventIds) {
              allThreadEventIds.add(eid);
            }
          }
          setThreadEventIds(allThreadEventIds);

          return updatedCards;
        });

        // スレッド構築成功後にリプライIDを処理済みとしてマーク
        // （updater内ではなく外に置くことで、React updaterの純粋性を保つ）
        for (const { note } of replyGroups) {
          processedReplyIdsRef.current.add(note.eventId);
        }

        // 初回処理完了
        if (!cancelled && !initialProcessingDoneRef.current) {
          initialProcessingDoneRef.current = true;
          setIsProcessing(false);
        }
      };

      processReplies().catch((err) => {
        console.error("[useThreadCards] スレッド処理エラー:", err);
        if (!cancelled && !initialProcessingDoneRef.current) {
          initialProcessingDoneRef.current = true;
          setIsProcessing(false);
        }
      });
    }, THREAD_PROCESS_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [notes, relayUrls, fetchThreadAncestors, status, cache]);

  // filteredNotes: スレッドに含まれないノートだけを返す
  const filteredNotes = useMemo(() => {
    if (threadCards.length === 0) return notes;
    return notes.filter((note) => !threadEventIds.has(note.eventId));
  }, [notes, threadCards, threadEventIds]);

  return { filteredNotes, threadCards, isProcessing };
}
