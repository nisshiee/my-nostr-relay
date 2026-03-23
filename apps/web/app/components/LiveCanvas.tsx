"use client";

import React, { useState, useEffect, useMemo, useCallback } from "react";
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
  /** EventCache インスタンス（引用ノード表示用） */
  cache: EventCache;
  onLogout: () => void;
  isProcessing: boolean;
}

function calcColumnCount(width: number): number {
  return Math.max(1, Math.floor(width / COLUMN_WIDTH));
}

export function LiveCanvas({ notes, threadCards, profiles, reactions, status, pubkey, npub, publishEvent, publishedSlotMapRef, sendReaction, cache, onLogout, isProcessing }: LiveCanvasProps) {
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

  const scoredCards = useMemo((): Card[] => {
    // notes + publishedNotes をマージ（eventIdで重複排除）
    const noteEventIds = new Set(notes.map((n) => n.eventId));
    const uniquePublished = publishedNotes.filter((n) => !noteEventIds.has(n.eventId));
    const allNotes = [...notes, ...uniquePublished];

    const updatedNotes: Card[] = allNotes.map((note) => {
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

    // threadCards にスコアを再計算
    const scoredThreads: Card[] = threadCards.map((thread) => {
      // スレッド内に自分のノートがあれば OWNER_SCORE_HALF_LIFE を使用
      const hasOwnerNote = thread.notes.some((n) => n.pubkey === pubkey);
      const halfLife = hasOwnerNote ? OWNER_SCORE_HALF_LIFE : SCORE_HALF_LIFE;
      // スレッド内最新リプライの created_at をベースにスコア計算
      const score = calcFreshnessScore(thread.created_at, nowEpoch, halfLife);
      return {
        ...thread,
        score,
        fadingOut: holdSet.has(thread.slotId) ? false : (thread.fadingOut || score <= FADEOUT_THRESHOLD),
      };
    });

    return sortByScore([...scoredDrafts, ...updatedNotes, ...scoredThreads]);
  }, [notes, publishedNotes, draftNotes, threadCards, nowEpoch, holdSet, pubkey]);

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

  return (
    <div className="flex h-screen flex-col bg-gray-50 dark:bg-gray-950">
      <CanvasHeader status={status} npub={npub} onAddDraft={addDraft} onLogout={onLogout} />

      <main className="flex-1 overflow-y-auto p-4">
        <EmptyState status={status} hasNotes={notes.length > 0} isProcessing={isProcessing} />

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
                      return (
                        <motion.div
                          key={note.slotId}
                          layout={false}
                          initial={{ opacity: 0, scale: 0.8, x, y }}
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
                              cache={cache}
                              profiles={profiles}
                              onHeightChange={handleHeightChange}
                              onHold={() => holdCard(note.slotId)}
                              onRelease={() => releaseCard(note.slotId)}
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
