"use client";

import React, { useState, useEffect, useMemo, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Card, NoteCard as NoteCardType, NostrProfile, Reactions } from "../lib/types";
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
import { useCardLayout } from "../hooks/useCardLayout";
import { NoteCard } from "./NoteCard";
import { ComposeCard } from "./ComposeCard";

interface LiveCanvasProps {
  notes: NoteCardType[];
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
  onLogout: () => void;
}

function calcColumnCount(width: number): number {
  return Math.max(1, Math.floor(width / COLUMN_WIDTH));
}

/** npubを省略表示する */
function truncateNpub(npub: string): string {
  if (npub.length <= 20) return npub;
  return `${npub.slice(0, 12)}...${npub.slice(-8)}`;
}

export function LiveCanvas({ notes, profiles, reactions, status, pubkey, npub, publishEvent, publishedSlotMapRef, sendReaction, onLogout }: LiveCanvasProps) {
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
      const score = calcFreshnessScore(note.created_at, nowEpoch, halfLife);
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

    return sortByScore([...scoredDrafts, ...updatedNotes]);
  }, [notes, publishedNotes, draftNotes, nowEpoch, holdSet, pubkey]);

  // レイアウト計算
  const {
    handleHeightChange,
    displayLayout,
    delayMap,
    computeColumnHeight,
  } = useCardLayout(scoredCards, columnCount, holdSet);

  const statusIndicator = useCallback(() => {
    switch (status) {
      case "connecting":
        return (
          <div className="flex items-center gap-2 text-yellow-500">
            <div className="h-2 w-2 animate-pulse rounded-full bg-yellow-500" />
            <span className="text-xs">接続中...</span>
          </div>
        );
      case "loading":
        return (
          <div className="flex items-center gap-2 text-blue-500">
            <div className="h-2 w-2 animate-pulse rounded-full bg-blue-500" />
            <span className="text-xs">読み込み中...</span>
          </div>
        );
      case "connected":
        return (
          <div className="flex items-center gap-2 text-green-500">
            <div className="h-2 w-2 rounded-full bg-green-500" />
            <span className="text-xs">接続済み</span>
          </div>
        );
      case "error":
        return (
          <div className="flex items-center gap-2 text-red-500">
            <div className="h-2 w-2 rounded-full bg-red-500" />
            <span className="text-xs">接続エラー</span>
          </div>
        );
    }
  }, [status]);

  return (
    <div className="flex h-screen flex-col bg-gray-50 dark:bg-gray-950">
      <header className="flex shrink-0 items-center justify-between border-b border-gray-200 bg-white px-6 py-3 dark:border-gray-800 dark:bg-gray-900">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">
            Nostr Live Canvas
          </h1>
          {statusIndicator()}
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={addDraft}
            className="rounded-lg bg-purple-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-600 transition-colors"
            title="新規投稿 (n)"
          >
            ✏️ 投稿
          </button>
          {npub && (
            <span
              className="rounded bg-gray-100 px-2 py-1 font-mono text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400"
              title={npub}
            >
              {truncateNpub(npub)}
            </span>
          )}
          <button
            type="button"
            onClick={onLogout}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            ログアウト
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-4">
        {status === "connecting" && notes.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-purple-400 border-t-transparent" />
              <p className="text-gray-500 dark:text-gray-400">
                リレーに接続中...
              </p>
            </div>
          </div>
        )}

        {status === "loading" && notes.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-blue-400 border-t-transparent" />
              <p className="text-gray-500 dark:text-gray-400">
                ノートを読み込み中...
              </p>
            </div>
          </div>
        )}

        {status === "error" && notes.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <p className="mb-2 text-lg text-red-500">⚠️ 接続エラー</p>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                リレーへの接続に失敗しました。再接続を試みています...
              </p>
            </div>
          </div>
        )}

        {scoredCards.length > 0 && (() => {
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
                          ) : (
                            <NoteCard
                              note={note}
                              profile={profiles.get(note.pubkey)}
                              reactions={reactions.get(note.eventId)}
                              myPubkey={pubkey}
                              onReaction={(emoji, imageUrl) => {
                                sendReaction(note.eventId, note.pubkey, emoji, imageUrl).catch(console.error);
                              }}
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
