"use client";

import React, { useRef, useEffect, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Card } from "../lib/types";
import {
  COLUMN_WIDTH,
  SCORE_UPDATE_INTERVAL,
  COLUMN_GAP,
  DEFAULT_CARD_HEIGHT,
} from "../lib/constants";
import { useDraftNotes } from "../hooks/useDraftNotes";
import useCanvasStore from "../store";
import { useShallow } from "zustand/react/shallow";
import {
  useCards,
  usePhase,
  useProfiles,
  useActions,
  useLayout,
  useColumnCount,
  useHoldSet,
} from "../store/selectors";
import { NoteCard } from "./NoteCard";
import { ThreadCard } from "./ThreadCard";
import { ComposeCard } from "./ComposeCard";
import { CanvasHeader } from "./CanvasHeader";
import { EmptyState } from "./EmptyState";
import type { Phase } from "../store/types";
import type { NostrEvent } from "../types/nostr";
import type { Event } from "nostr-tools/core";

interface LiveCanvasProps {
  pubkey: string;
  npub: string | null;
  onLogout: () => void;
}

/** Store の Phase → CanvasHeader/EmptyState の status 文字列に変換 */
function phaseToStatus(phase: Phase): "connecting" | "loading" | "connected" | "error" {
  if (phase === "ready") return "connected";
  return phase;
}

function calcColumnCount(width: number): number {
  return Math.max(1, Math.floor(width / COLUMN_WIDTH));
}

export function LiveCanvas({ pubkey, npub, onLogout }: LiveCanvasProps) {
  // --- Store セレクター ---
  const cards = useCanvasStore(useCards);
  const phase = useCanvasStore(usePhase);
  const profiles = useCanvasStore(useProfiles);
  const layout = useCanvasStore(useLayout);
  const columnCount = useCanvasStore(useColumnCount);
  const holdSet = useCanvasStore(useHoldSet);
  const heights = useCanvasStore((s) => s.heights);
  const delays = useCanvasStore((s) => s.delays);
  
  const {
    connect,
    disconnect,
    publishEvent,
    setHeight,
    setColumnCount: storeSetColumnCount,
    holdCard,
    releaseCard,
    tick,
  } = useCanvasStore(useShallow(useActions));

  // publishedSlotMapRef は useDraftNotes 用に維持
  const publishedSlotMapRef = useRef<Map<string, string>>(new Map());

  // --- Store 接続 ---
  useEffect(() => {
    connect(pubkey);
    return () => {
      disconnect();
    };
  }, [pubkey, connect, disconnect]);

  // --- ウィンドウリサイズ → カラム数更新 ---
  useEffect(() => {
    const update = () => storeSetColumnCount(calcColumnCount(window.innerWidth));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [storeSetColumnCount]);

  // --- スコア定期 tick ---
  useEffect(() => {
    const timer = setInterval(() => {
      tick(Math.floor(Date.now() / 1000));
    }, SCORE_UPDATE_INTERVAL);
    return () => clearInterval(timer);
  }, [tick]);

  // 下書き・Publish管理（store の cards (NoteCard[]) から notes を抽出）
  const notes = cards.filter((c): c is import("../lib/types").NoteCard => c.type === "note");

  const {
    draftNotes,
    publishedNotes,
    addDraft,
    handleDraftInput,
    handleDraftClose,
    handleDraftPublish,
  } = useDraftNotes({ pubkey, notes, publishedSlotMapRef });

  // ドラフトと publishedNotes を store cards にマージ（表示用）
  // store の cards には NoteCard + ThreadCard が入っている
  // ここに ComposeCard（drafts）と publishedNotes（まだ store に到着していないもの）を追加
  const displayCards = React.useMemo((): Card[] => {
    const noteEventIds = new Set(notes.map((n) => n.eventId));
    const uniquePublished = publishedNotes.filter((n) => !noteEventIds.has(n.eventId));
    return [...draftNotes, ...uniquePublished, ...cards];
  }, [draftNotes, publishedNotes, notes, cards]);

  const status = phaseToStatus(phase);

  // 高さ変更ハンドラ（store の setHeight に直接渡す）
  const onHeightChange = useCallback((slotId: string, height: number) => {
    setHeight(slotId, height);
  }, [setHeight]);

  // カラム高さ計算（useCardLayoutから移植）
  const computeColumnHeight = useCallback((colIdx: number): number => {
    let maxBottom = 0;
    for (const [id, placement] of layout) {
      if (placement.col !== colIdx) continue;
      const h = heights.get(id) ?? DEFAULT_CARD_HEIGHT;
      const bottom = placement.y + h;
      if (bottom > maxBottom) maxBottom = bottom;
    }
    return maxBottom;
  }, [layout, heights]);

  return (
    <div className="flex h-screen flex-col bg-gray-50 dark:bg-gray-950">
      <CanvasHeader status={status} npub={npub} onAddDraft={addDraft} onLogout={onLogout} />

      <main className="flex-1 overflow-y-auto p-4">
        <EmptyState status={status} hasNotes={notes.length > 0} isProcessing={false} />

        {displayCards.length > 0 && (() => {
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
                  {displayCards
                    .filter((n) => layout.has(n.slotId))
                    .map((note, idx, arr) => {
                      const placement = layout.get(note.slotId)!;
                      const x = placement.col * (COLUMN_WIDTH + COLUMN_GAP);
                      const y = placement.y;
                      const delay = delays.get(note.slotId) ?? 0;
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
                              onHeightChange={onHeightChange}
                              onPublish={(slotId, event) => { releaseCard(slotId); handleDraftPublish(slotId, event); }}
                              onInput={handleDraftInput}
                              onClose={(slotId) => { releaseCard(slotId); handleDraftClose(slotId); }}
                              publishEvent={(event: NostrEvent) => publishEvent(event as unknown as Event)}
                              onHold={holdCard}
                              onRelease={releaseCard}
                              autoFocus
                            />
                          ) : note.type === "thread" ? (
                            <ThreadCard
                              thread={note}
                              myPubkey={pubkey}
                              onHeightChange={onHeightChange}
                              onHold={() => holdCard(note.slotId)}
                              onRelease={() => releaseCard(note.slotId)}
                            />
                          ) : (
                            <NoteCard
                              note={note}
                              myPubkey={pubkey}
                              onHeightChange={onHeightChange}
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
