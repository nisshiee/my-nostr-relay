import { useEffect, useRef, useState, useCallback, useMemo, type RefObject } from "react";
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
  publishedSlotMapRef: RefObject<Map<string, string>>,
): UseThreadCardsResult {
  const [threadCards, setThreadCards] = useState<ThreadCard[]>([]);
  const [isProcessing, setIsProcessing] = useState(true);
  const initialProcessingDoneRef = useRef(false);

  // スレッドに含まれる全eventIdの集合（filteredNotes計算用、threadCardsから派生）
  const threadEventIds = useMemo(() => {
    const ids = new Set<string>();
    for (const card of threadCards) {
      for (const eid of card.eventIds) ids.add(eid);
    }
    return ids;
  }, [threadCards]);
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
      if (cancelled) return;
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

      // 各リプライについてスレッド構築（2フェーズ）
      const processReplies = () => {
        // リプライをグルーピング: 共通の参照eventIdを持つリプライは同じスレッドに
        const replyGroups: { note: NoteCard; refIds: string[] }[] = [];
        for (const note of newReplies) {
          const refIds = extractReplyEventIds(note.tags);
          replyGroups.push({ note, refIds });
        }

        // --- フェーズ1: ローカルデータのみでスレッド構築（同期的） ---

        // 既存notesからルックアップ用マップを構築
        const notesMap = new Map<string, NoteCard>();
        for (const note of notes) {
          notesMap.set(note.eventId, note);
        }

        // ローカルに存在するノートと、フェッチが必要なIDを分類
        const localNotesMap = new Map<string, ThreadNote>();
        const missingIds = new Set<string>();
        for (const { refIds } of replyGroups) {
          for (const id of refIds) {
            if (localNotesMap.has(id) || missingIds.has(id)) continue;
            // notesMap（現在のnotes配列）から探す
            const existingNote = notesMap.get(id);
            if (existingNote) {
              localNotesMap.set(id, noteCardToThreadNote(existingNote));
              continue;
            }
            // cache から探す
            const cached = cache.getEvent(id);
            if (cached) {
              localNotesMap.set(id, eventToThreadNote(cached));
              continue;
            }
            missingIds.add(id);
          }
        }

        // フェーズ1: ローカルデータでスレッド構築・マージ（immutable更新）
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

              // 参照先のローカルデータを追加
              for (const refId of refIds) {
                if (!newEventIds.has(refId)) {
                  const localNote = localNotesMap.get(refId);
                  const existingNote = notesMap.get(refId);
                  const noteToAdd = localNote ?? (existingNote ? noteCardToThreadNote(existingNote) : undefined);
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

              // 参照先を追加（ローカルデータのみ）
              for (const refId of refIds) {
                if (eventIds.has(refId)) continue;
                const localNote = localNotesMap.get(refId);
                const existingNote = notesMap.get(refId);
                const noteToAdd = localNote ?? (existingNote ? noteCardToThreadNote(existingNote) : undefined);
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

              // slotId解決: publishedSlotMapRef → 構成ノートの既存slotId → 新規UUID
              let resolvedSlotId: string | undefined;

              // 自分がpublishしたリプライのslotIdマッピングを確認
              for (const eid of eventIds) {
                resolvedSlotId = publishedSlotMapRef.current?.get(eid);
                if (resolvedSlotId) break;
              }

              // 構成ノートがキャンバス上にNoteCardとして既に存在すればそのslotIdを引き継ぐ
              if (!resolvedSlotId) {
                for (const n of sortedNotes) {
                  const existingNoteCard = notesMap.get(n.eventId);
                  if (existingNoteCard?.slotId) {
                    resolvedSlotId = existingNoteCard.slotId;
                    break;
                  }
                }
              }

              const newCard: ThreadCard = {
                type: "thread",
                slotId: resolvedSlotId ?? crypto.randomUUID(),
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

          return updatedCards;
        });

        // フェーズ1完了: リプライIDを処理済みとしてマーク
        for (const { note } of replyGroups) {
          processedReplyIdsRef.current.add(note.eventId);
        }

        // フェーズ1完了: isProcessing を false に（ネットワーク待ちなし）
        if (!initialProcessingDoneRef.current) {
          initialProcessingDoneRef.current = true;
          setIsProcessing(false);
        }

        // --- フェーズ2: バックグラウンドで祖先をフェッチしてマージ ---
        if (missingIds.size > 0) {
          fetchThreadAncestors([...missingIds]).then((fetchedEvents) => {
            if (cancelled) return;
            if (fetchedEvents.length === 0) return;

            const fetchedNotesMap = new Map<string, ThreadNote>();
            for (const event of fetchedEvents) {
              fetchedNotesMap.set(event.id, eventToThreadNote(event));
            }

            // setThreadCards の updater で既存カードにマージ
            setThreadCards((prev) => {
              let updatedCards = prev.map((card) => ({
                ...card,
                notes: [...card.notes],
                eventIds: new Set(card.eventIds),
              }));

              // 既存カードのeventId → index マッピング
              const eventIdToCardIndex = new Map<string, number>();
              for (let i = 0; i < updatedCards.length; i++) {
                for (const eid of updatedCards[i]!.eventIds) {
                  eventIdToCardIndex.set(eid, i);
                }
              }

              // 各カードの全ノートが参照しているeventId → カードindex のマッピング
              // （フェッチした祖先ノートの eventId が直接カードの eventIds に入っていない場合、
              //  そのノートを参照しているノートが所属するカードを探す必要がある）
              const referencedIdToCardIndex = new Map<string, number>();
              for (let i = 0; i < updatedCards.length; i++) {
                for (const n of updatedCards[i]!.notes) {
                  // replyTo の eventId
                  if (n.replyTo?.eventId) {
                    referencedIdToCardIndex.set(n.replyTo.eventId, i);
                  }
                  // 全ての e タグ参照
                  for (const tag of n.tags) {
                    if (tag[0] === "e" && tag[1]) {
                      referencedIdToCardIndex.set(tag[1], i);
                    }
                  }
                }
              }

              let changed = false;

              // 追加できなくなるまでループ（深い祖先チェーンに対応）
              let remaining = new Map(fetchedNotesMap);
              let lastSize = -1;
              while (remaining.size > 0 && remaining.size !== lastSize) {
                lastSize = remaining.size;
                for (const [fetchedId, fetchedNote] of remaining) {
                  let cardIdx = eventIdToCardIndex.get(fetchedId)
                    ?? referencedIdToCardIndex.get(fetchedId);
                  if (cardIdx === undefined) continue;

                  const card = updatedCards[cardIdx]!;
                  if (!card.eventIds.has(fetchedId)) {
                    card.notes.push(fetchedNote);
                    card.eventIds.add(fetchedId);
                    eventIdToCardIndex.set(fetchedId, cardIdx);
                    // 新しいノートの参照先もマッピングに追加
                    if (fetchedNote.replyTo?.eventId) {
                      referencedIdToCardIndex.set(fetchedNote.replyTo.eventId, cardIdx);
                    }
                    for (const tag of fetchedNote.tags) {
                      if (tag[0] === "e" && tag[1]) {
                        referencedIdToCardIndex.set(tag[1], cardIdx);
                      }
                    }
                    changed = true;
                  }
                  remaining.delete(fetchedId);
                }
              }

              if (!changed) return prev;

              // ソート、replyTo解決、スコア再計算
              for (let i = 0; i < updatedCards.length; i++) {
                const card = updatedCards[i]!;
                const sortedNotes = resolveReplyAuthors(sortThreadNotes(card.notes));
                const latestCreatedAt = sortedNotes.length > 0
                  ? Math.max(...sortedNotes.map((n) => n.created_at))
                  : card.created_at;
                const now = Math.floor(Date.now() / 1000);
                const hasOwnerNote = sortedNotes.some((n) => n.pubkey === pubkey);
                const halfLife = hasOwnerNote ? OWNER_SCORE_HALF_LIFE : SCORE_HALF_LIFE;

                updatedCards[i] = {
                  ...card,
                  notes: sortedNotes,
                  created_at: latestCreatedAt,
                  score: calcFreshnessScore(latestCreatedAt, now, halfLife),
                };
              }

              return updatedCards;
            });
          }).catch((err) => {
            console.error("[useThreadCards] フェーズ2 祖先フェッチエラー:", err);
          });
        }
      };

      processReplies();
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
