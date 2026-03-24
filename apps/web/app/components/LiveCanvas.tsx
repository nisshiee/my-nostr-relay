"use client";

import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Card, NoteCard as NoteCardType, ThreadCard as ThreadCardType, NostrProfile, Reactions } from "../lib/types";
import {
  COLUMN_WIDTH,
  SCORE_UPDATE_INTERVAL,
  FADEOUT_THRESHOLD,
  COLUMN_GAP,
  SCORE_HALF_LIFE,
  OWNER_SCORE_HALF_LIFE,
} from "../lib/constants";
import { calcFreshnessScore, sortByScore } from "../lib/scoring";
import { useDraftNotes } from "../hooks/useDraftNotes";
import { useReplyDrafts } from "../hooks/useReplyDrafts";

/** isProcessing中にuseCardLayoutに渡す空配列（参照を安定させて無限ループ防止） */
const EMPTY_CARDS: Card[] = [];
import { useCardLayout } from "../hooks/useCardLayout";
import { NoteCard } from "./NoteCard";
import { ThreadCard } from "./ThreadCard";
import { ComposeCard } from "./ComposeCard";
import { CanvasHeader } from "./CanvasHeader";
import { EmptyState } from "./EmptyState";
import type { NostrEvent } from "../types/nostr";
import type { EventCache } from "../hooks/useEventCache";

interface LiveCanvasProps {
  notes: NoteCardType[];
  threadCards: ThreadCardType[];
  profiles: Map<string, NostrProfile>;
  /** リアクション集計: eventId → (絵文字 → 件数) */
  reactions: Reactions;
  status: "connecting" | "loading" | "connected" | "error";
  pubkey: string;
  npub: string | null;
  publishEvent: (event: NostrEvent) => Promise<void>;
  publishedSlotMapRef: React.RefObject<Map<string, string>>;
  /** リアクション送信ハンドラ */
  sendReaction: (targetEventId: string, targetPubkey: string, emoji: string, imageUrl?: string) => Promise<void>;
  /** リポスト送信ハンドラ */
  sendRepost: (targetEventId: string, targetPubkey: string, originalEvent: NostrEvent) => Promise<void>;
  /** EventCache インスタンス（引用ノード表示用） */
  cache: EventCache;
  onLogout: () => void;
  isProcessing: boolean;
}

function calcColumnCount(width: number): number {
  return Math.max(1, Math.floor(width / COLUMN_WIDTH));
}

export function LiveCanvas({ notes, threadCards, profiles, reactions, status, pubkey, npub, publishEvent, publishedSlotMapRef, sendReaction, sendRepost, cache, onLogout, isProcessing }: LiveCanvasProps) {
  const [columnCount, setColumnCount] = useState(1);
  const [holdSet, setHoldSet] = useState<Set<string>>(() => new Set());

  /** カードをホールド状態にする */
  const holdCard = useCallback((slotId: string) => {
    setHoldSet(prev => {
      const next = new Set(prev);
      next.add(slotId);
      return next;
    });
  }, []);

  /** カードのホールドを解除する */
  const releaseCard = useCallback((slotId: string) => {
    setHoldSet(prev => {
      if (!prev.has(slotId)) return prev;
      const next = new Set(prev);
      next.delete(slotId);
      return next;
    });
  }, []);
  const [nowEpoch, setNowEpoch] = useState(() =>
    Math.floor(Date.now() / 1000),
  );

  useEffect(() => {
    const update = () => setColumnCount(calcColumnCount(window.innerWidth));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setNowEpoch(Math.floor(Date.now() / 1000));
    }, SCORE_UPDATE_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  // 下書き・Publish管理
  const {
    draftNotes,
    publishedNotes,
    addDraft,
    handleDraftInput,
    handleDraftClose,
    handleDraftPublish,
  } = useDraftNotes({ pubkey, notes, publishedSlotMapRef });

  // リプライ仮データ管理
  const {
    pendingNoteReplies,
    pendingThreadReplies,
    addNoteReply,
    addThreadReply,
  } = useReplyDrafts({ threadCards, pubkey, publishedSlotMapRef });

  const scoredCards = useMemo((): Card[] => {
    // pendingNoteReplies の originalNote.eventId を収集（仮ThreadCardに変換されるため notes から除外する）
    const pendingOriginalEventIds = new Set<string>();
    for (const pending of pendingNoteReplies.values()) {
      pendingOriginalEventIds.add(pending.originalNote.eventId);
    }

    // notes + publishedNotes をマージ（eventIdで重複排除、pendingNoteRepliesの元ノートは除外）
    const noteEventIds = new Set(notes.map((n) => n.eventId));
    const uniquePublished = publishedNotes.filter((n) => !noteEventIds.has(n.eventId));
    const allNotes = [...notes, ...uniquePublished].filter(
      (n) => !pendingOriginalEventIds.has(n.eventId),
    );

    let updatedNotes: Card[] = allNotes.map((note) => {
      const halfLife = note.pubkey === pubkey ? OWNER_SCORE_HALF_LIFE : SCORE_HALF_LIFE;
      // リポストの場合はリポスト時刻をスコア計算に使用（フィード上での鮮度を反映）
      const scoreTimestamp = note.repostInfo?.repostedAt ?? note.created_at;
      const score = calcFreshnessScore(scoreTimestamp, nowEpoch, halfLife);
      return {
        ...note,
        score,
        fadingOut: holdSet.has(note.slotId) ? false : (note.fadingOut || score <= FADEOUT_THRESHOLD),
      };
    });

    // draftNotes にスコアを再計算
    const scoredDrafts: Card[] = draftNotes.map((d) => {
      const score = calcFreshnessScore(d.created_at, nowEpoch, OWNER_SCORE_HALF_LIFE);
      return {
        ...d,
        score,
        fadingOut: holdSet.has(d.slotId) ? false : score <= FADEOUT_THRESHOLD,
      };
    });

    // pendingNoteReplies から仮ThreadCard を生成
    const fakeThreads: Card[] = Array.from(pendingNoteReplies.values()).map(
      (pending) => ({
        type: "thread" as const,
        slotId: pending.slotId,
        pubkey: pending.originalNote.pubkey,
        score: calcFreshnessScore(
          pending.replyNote.created_at,
          nowEpoch,
          OWNER_SCORE_HALF_LIFE,
        ),
        fadingOut: false,
        created_at: pending.replyNote.created_at,
        notes: [
          // 元のNoteCardをThreadNoteに変換
          {
            eventId: pending.originalNote.eventId,
            pubkey: pending.originalNote.pubkey,
            content: pending.originalNote.content,
            created_at: pending.originalNote.created_at,
            tags: pending.originalNote.tags,
          },
          // リプライ
          pending.replyNote,
        ],
        eventIds: new Set([
          pending.originalNote.eventId,
          pending.replyNote.eventId,
        ]),
      }),
    );

    // 本物のthreadCardsに同じslotIdが存在する仮ThreadCardは除外（重複によるアニメーション発火防止）
    const threadSlotIds = new Set(threadCards.map((tc) => tc.slotId));
    const dedupedFakeThreads = fakeThreads.filter((ft) => !threadSlotIds.has(ft.slotId));

    // ThreadCard（本物 or 仮）と同じslotIdのNoteCardを除外
    // - fakeThreadSlotIds: pendingNoteRepliesから生成された仮ThreadCard（NoteCard→ThreadCard変化時の重複防止）
    // - threadSlotIds: 本物のthreadCards（filteredNotesのeventIdベース除外だけでは
    //   タイミングずれでNoteCardが残る場合があるため、slotIdベースでも除外する）
    const allThreadSlotIds = new Set([
      ...threadSlotIds,
      ...dedupedFakeThreads.map((ft) => ft.slotId),
    ]);
    if (allThreadSlotIds.size > 0) {
      updatedNotes = updatedNotes.filter((n) => !allThreadSlotIds.has(n.slotId));
    }

    // threadCards にスコアを再計算（pendingThreadReplies の仮ノートをマージ）
    const scoredThreads: Card[] = threadCards.map((thread) => {
      // pendingThreadReplies の仮ノートを追加
      // ※ threadCards更新後、pendingThreadRepliesクリア前の1レンダーで重複マージされるのを防ぐため、
      //    すでにthreadCards.eventIdsに含まれるリプライは除外する
      const pendingReplies = pendingThreadReplies.get(thread.slotId);
      let mergedThread = thread;
      if (pendingReplies && pendingReplies.length > 0) {
        const newPending = pendingReplies.filter((p) => !thread.eventIds.has(p.replyEventId));
        if (newPending.length > 0) {
          const latestCreatedAt = Math.max(
            thread.created_at,
            ...newPending.map((p) => p.replyNote.created_at),
          );
          mergedThread = {
            ...thread,
            notes: [
              ...thread.notes,
              ...newPending.map((p) => p.replyNote),
            ],
            eventIds: new Set([
              ...thread.eventIds,
              ...newPending.map((p) => p.replyEventId),
            ]),
            created_at: latestCreatedAt,
          };
        }
      }

      // スレッド内に自分のノートがあれば OWNER_SCORE_HALF_LIFE を使用
      const hasOwnerNote = mergedThread.notes.some((n) => n.pubkey === pubkey);
      const halfLife = hasOwnerNote ? OWNER_SCORE_HALF_LIFE : SCORE_HALF_LIFE;
      // スレッド内最新リプライの created_at をベースにスコア計算
      const score = calcFreshnessScore(mergedThread.created_at, nowEpoch, halfLife);
      return {
        ...mergedThread,
        score,
        fadingOut: holdSet.has(mergedThread.slotId) ? false : (mergedThread.fadingOut || score <= FADEOUT_THRESHOLD),
      };
    });

    return sortByScore([...scoredDrafts, ...updatedNotes, ...scoredThreads, ...dedupedFakeThreads]);
  }, [notes, publishedNotes, draftNotes, threadCards, pendingNoteReplies, pendingThreadReplies, nowEpoch, holdSet, pubkey]);

  // レイアウト計算
  // isProcessing中は空配列を渡してレイアウトエンジンを停止する
  // 参照を安定させるため、モジュールスコープの定数を使用
  const layoutCards = isProcessing ? EMPTY_CARDS : scoredCards;

  const {
    handleHeightChange,
    displayLayout,
    delayMap,
    computeColumnHeight,
  } = useCardLayout(layoutCards, columnCount, holdSet);

  // 前回レンダーに存在したslotIdを追跡（既知カードの initial アニメーションをスキップするため）
  const prevSlotIdsRef = useRef<Set<string>>(new Set());
  const knownSlotIds = prevSlotIdsRef.current;
  useEffect(() => {
    prevSlotIdsRef.current = new Set(scoredCards.map((c) => c.slotId));
  });

  return (
    <div className="flex h-screen flex-col bg-gray-50 dark:bg-gray-950">
      <CanvasHeader status={status} npub={npub} onAddDraft={addDraft} onLogout={onLogout} />

      <main className="flex-1 overflow-y-auto p-4">
        <EmptyState status={status} hasNotes={notes.length > 0} isProcessing={isProcessing} />

        {/* eslint-disable-next-line react-hooks/refs -- knownSlotIds is captured from ref before JSX intentionally */}
        {scoredCards.length > 0 && !isProcessing && (() => {
          const containerHeight = Math.max(
            ...Array.from({ length: columnCount }, (_, i) => computeColumnHeight(i)),
            0,
          );
          return (
            <div className="flex justify-center">
              <div
                className="relative"
                style={{
                  width: columnCount * COLUMN_WIDTH + (columnCount - 1) * COLUMN_GAP,
                  height: containerHeight,
                }}
              >
                <AnimatePresence>
                  {scoredCards
                    .filter((n) => displayLayout.has(n.slotId))
                    .map((note, idx, arr) => {
                      const placement = displayLayout.get(note.slotId)!;
                      const x = placement.col * (COLUMN_WIDTH + COLUMN_GAP);
                      const y = placement.y;
                      const delay = delayMap.get(note.slotId) ?? 0;
                      const zIndex = holdSet.has(note.slotId)
                        ? arr.length + 1000 // ホールド中は最前面
                        : arr.length - idx;
                      // 前回レンダーに存在していたslotIdはinitialアニメーションをスキップ
                      // （NoteCard→ThreadCard変化やリプライ追加時のズームを防止）
                      const isKnownCard = knownSlotIds.has(note.slotId);
                      return (
                        <motion.div
                          key={note.slotId}
                          layout={false}
                          initial={isKnownCard ? false : { opacity: 0, scale: 0.8, x, y }}
                          animate={{
                            opacity: note.fadingOut ? 0 : 1,
                            scale: note.fadingOut ? 0.95 : 1,
                            x,
                            y,
                          }}
                          exit={{ opacity: 0, scale: 0.8 }}
                          transition={{
                            x: {
                              type: "spring",
                              stiffness: 300,
                              damping: 30,
                              delay,
                            },
                            y: {
                              type: "spring",
                              stiffness: 300,
                              damping: 30,
                              delay,
                            },
                            opacity: {
                              duration: note.fadingOut ? 1 : 0.4,
                            },
                            scale: {
                              duration: note.fadingOut ? 1 : 0.3,
                            },
                          }}
                          style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            width: COLUMN_WIDTH,
                            zIndex,
                          }}
                        >
                          {note.type === "compose" ? (
                            <ComposeCard
                              slotId={note.slotId}
                              pubkey={note.pubkey}
                              profile={profiles.get(note.pubkey)}
                              onHeightChange={handleHeightChange}
                              onPublish={(slotId, event) => { releaseCard(slotId); handleDraftPublish(slotId, event); }}
                              onInput={handleDraftInput}
                              onClose={(slotId) => { releaseCard(slotId); handleDraftClose(slotId); }}
                              publishEvent={publishEvent}
                              onHold={holdCard}
                              onRelease={releaseCard}
                              autoFocus
                              quotedEvent={note.quotedEvent}
                              cache={cache}
                              profiles={profiles}
                            />
                          ) : note.type === "thread" ? (
                            <ThreadCard
                              thread={note}
                              profiles={profiles}
                              reactions={reactions}
                              myPubkey={pubkey}
                              onReaction={(targetEventId, targetPubkey, emoji, imageUrl) => {
                                sendReaction(targetEventId, targetPubkey, emoji, imageUrl).catch(console.error);
                              }}
                              onHeightChange={handleHeightChange}
                              onHold={() => holdCard(note.slotId)}
                              onRelease={() => releaseCard(note.slotId)}
                              cache={cache}
                              onReplyPublish={(signedEvent, noteCard, threadSlotId) => {
                                addThreadReply(signedEvent, noteCard, threadSlotId);
                              }}
                              publishEvent={publishEvent}
                              myProfile={profiles.get(pubkey)}
                              onQuote={(eventId, quotePubkey) => {
                                addDraft({
                                  quotedEvent: {
                                    eventId,
                                    pubkey: quotePubkey,
                                  },
                                });
                              }}
                            />
                          ) : (
                            <NoteCard
                              note={note}
                              profile={profiles.get(note.pubkey)}
                              reposterProfile={note.repostInfo ? profiles.get(note.repostInfo.reposterPubkey) : undefined}
                              reactions={reactions.get(note.eventId)}
                              myPubkey={pubkey}
                              onReaction={(emoji, imageUrl) => {
                                sendReaction(note.eventId, note.pubkey, emoji, imageUrl).catch(console.error);
                              }}
                              onQuote={() => {
                                addDraft({
                                  quotedEvent: {
                                    eventId: note.eventId,
                                    pubkey: note.pubkey,
                                    sig: note.sig,
                                  },
                                });
                              }}
                              onRepost={() => {
                                const originalEvent: NostrEvent = {
                                  kind: 1,
                                  content: note.content,
                                  tags: note.tags,
                                  created_at: note.created_at,
                                  pubkey: note.pubkey,
                                  id: note.eventId,
                                  sig: note.sig,
                                };
                                sendRepost(note.eventId, note.pubkey, originalEvent).catch(console.error);
                              }}
                              cache={cache}
                              profiles={profiles}
                              onHeightChange={handleHeightChange}
                              onHold={() => holdCard(note.slotId)}
                              onRelease={() => releaseCard(note.slotId)}
                              onReplyPublish={(signedEvent, noteCard, originalNote) => {
                                addNoteReply(signedEvent, noteCard, originalNote);
                              }}
                              publishEvent={publishEvent}
                              myProfile={profiles.get(pubkey)}
                            />
                          )}
                        </motion.div>
                      );
                    })}
                </AnimatePresence>
              </div>
            </div>
          );
        })()}
      </main>
    </div>
  );
}
