import { useEffect, useRef, useState, useCallback, useMemo, type RefObject } from "react";
import type { SimplePool } from "nostr-tools/pool";
import type { Event } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import type { NoteCard, ThreadCard, ThreadNote } from "../lib/types";
import type { EventCache } from "./useEventCache";
import { BOOTSTRAP_EOSE_TIMEOUT, MAX_THREAD_DEPTH } from "../lib/constants";
import { collectMissingEventIds, eventToThreadNote, extractReplyEventIds, isReply, materializeFeedCards, resolveReplyAuthors } from "../lib/threadBuilder";

// --- ヘルパー関数 ---

/** 表示形式の変換は共通のNIP-10解決を使う。 */
function noteCardToThreadNote(note: NoteCard): ThreadNote {
  return eventToThreadNote({ ...note, id: note.eventId });
}

/** ThreadNote配列をcreated_at昇順でソート */
function sortThreadNotes(notes: ThreadNote[]): ThreadNote[] {
  return [...notes].sort((a, b) => a.created_at - b.created_at);
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

  // 過去のstateは表示文脈・slotのキャッシュ。保持対象は常に現在のnotes。
  const processedReplyIdsRef = useRef<Set<string>>(new Set());
  const retainedNotesRef = useRef(notes);
  const scopeRef = useRef({ active: false });
  useEffect(() => { retainedNotesRef.current = notes; }, [notes]);
  useEffect(() => {
    const scope = { active: true };
    scopeRef.current = scope;
    processedReplyIdsRef.current.clear();
    initialProcessingDoneRef.current = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- セッション境界で文脈キャッシュを破棄する
    setThreadCards([]);
    setIsProcessing(true);
    return () => { scope.active = false; };
  }, [pubkey, pool, relayUrls, cache]);

  /** 取得開始時のセッションとcacheを固定し、終了後は追加REQを出さない。 */
  const fetchThreadAncestors = useCallback(async (ids: string[]): Promise<Event[]> => {
    const scope = scopeRef.current;
    const visited = new Set<string>();
    const fetchAncestors = async (requested: string[], depth: number): Promise<Event[]> => {
      const missing = requested.filter(id => !visited.has(id));
      if (!scope.active || depth >= MAX_THREAD_DEPTH || !missing.length) return [];
      missing.forEach(id => visited.add(id));
      try {
        const events = await cache.fetchEvents(
          { kinds: [1], ids: missing } as Filter,
          { maxWait: BOOTSTRAP_EOSE_TIMEOUT },
        );
        if (!scope.active) return [];
        const authors = [...new Set(events.map(event => event.pubkey))];
        if (authors.length) cache.ensureProfiles(authors);
        events.forEach(event => visited.add(event.id));
        const deeper = await fetchAncestors(collectMissingEventIds(visited, events), depth + 1);
        return [...events, ...deeper];
      } catch (err) {
        console.error("[useThreadCards] 祖先フェッチエラー:", err);
        return [];
      }
    };
    return fetchAncestors(ids, 0);
  }, [cache]);

  // notes変更時のスレッド処理（デバウンス付き）
  useEffect(() => {
    const retainedIds = new Set(notes.map(note => note.eventId));
    processedReplyIdsRef.current = new Set([...processedReplyIdsRef.current].filter(id => retainedIds.has(id)));
    const pruneContext = () => setThreadCards(prev => {
      const active = materializeFeedCards(retainedNotesRef.current, prev).threadCards;
      return active.length === prev.length ? prev : active;
    });
    if (notes.length === 0 || relayUrls.length === 0) {
      queueMicrotask(pruneContext);
      // EOSE到達後（connected）にnotesが空 → 初回処理完了
      if (status === "connected" && !initialProcessingDoneRef.current) {
        initialProcessingDoneRef.current = true;
        // queueMicrotask で同期 setState を回避
        queueMicrotask(() => setIsProcessing(false));
      }
      return;
    }

    let cancelled = false;
    const scope = scopeRef.current;

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
        pruneContext();
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

              // 表示文脈を更新する。採点元は最後に共通処理で解決する。
              const sortedNotes = resolveReplyAuthors(sortThreadNotes(newNotes));
              const latestCreatedAt = sortedNotes.length > 0
                ? Math.max(...sortedNotes.map((n) => n.created_at))
                : note.created_at;


              updatedCards[targetCardIndex] = {
                ...card,
                notes: sortedNotes,
                eventIds: newEventIds,
                created_at: latestCreatedAt,
                score: 0,
                scoreSources: [],
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
                score: 0,
                scoreSources: [],
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

          return materializeFeedCards(retainedNotesRef.current, updatedCards).threadCards;
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
            if (!scope.active) return;
            if (fetchedEvents.length === 0) return;

            const fetchedNotesMap = new Map<string, ThreadNote>();
            for (const event of fetchedEvents) {
              fetchedNotesMap.set(event.id, eventToThreadNote(event));
            }

            // setThreadCards の updater で既存カードにマージ
            setThreadCards((prev) => {
              const updatedCards = prev.map((card) => ({
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
              const remaining = new Map(fetchedNotesMap);
              let lastSize = -1;
              while (remaining.size > 0 && remaining.size !== lastSize) {
                lastSize = remaining.size;
                for (const [fetchedId, fetchedNote] of remaining) {
                  const cardIdx = eventIdToCardIndex.get(fetchedId)
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

              // 表示文脈のソートとreplyTo解決
              for (let i = 0; i < updatedCards.length; i++) {
                const card = updatedCards[i]!;
                const sortedNotes = resolveReplyAuthors(sortThreadNotes(card.notes));
                const latestCreatedAt = sortedNotes.length > 0
                  ? Math.max(...sortedNotes.map((n) => n.created_at))
                  : card.created_at;

                updatedCards[i] = {
                  ...card,
                  notes: sortedNotes,
                  created_at: latestCreatedAt,
                  score: 0,
                  scoreSources: [],
                };
              }

              return materializeFeedCards(retainedNotesRef.current, updatedCards).threadCards;
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
  }, [notes, relayUrls, fetchThreadAncestors, status, cache, pubkey, pool, publishedSlotMapRef]);

  const materialized = useMemo(() => materializeFeedCards(notes, threadCards), [notes, threadCards]);
  return { ...materialized, isProcessing };
}
