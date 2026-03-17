"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { CanvasNote, NostrProfile } from "../lib/types";
import type { Grid, Placement } from "../lib/layoutTypes";
import {
  COLUMN_WIDTH,
  SCORE_UPDATE_INTERVAL,
  FADEOUT_THRESHOLD,
  DEFAULT_CARD_HEIGHT,
} from "../lib/constants";
import { DOMINO_DELAY, COLUMN_GAP } from "../lib/layoutConstants";
import {
  buildInitialLayout,
  insertCard,
  reflow,
} from "../lib/layoutEngine";
import { calcFreshnessScore, sortByScore } from "../lib/scoring";
import { NoteCard } from "./NoteCard";

interface LiveCanvasProps {
  notes: CanvasNote[];
  profiles: Map<string, NostrProfile>;
  status: "connecting" | "loading" | "connected" | "error";
}

function calcColumnCount(width: number): number {
  return Math.max(1, Math.floor(width / COLUMN_WIDTH));
}

export function LiveCanvas({ notes, profiles, status }: LiveCanvasProps) {
  const [columnCount, setColumnCount] = useState(1);
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

  const scoredNotes = useMemo(() => {
    const updated = notes.map((note) => {
      const score = calcFreshnessScore(note.created_at, nowEpoch);
      return {
        ...note,
        score,
        fadingOut: note.fadingOut || score <= FADEOUT_THRESHOLD,
      };
    });
    return sortByScore(updated);
  }, [notes, nowEpoch]);

  const [heightMap, setHeightMap] = useState<Map<string, number>>(
    () => new Map(),
  );

  const handleHeightChange = useCallback((id: string, height: number) => {
    setHeightMap((prev) => {
      if (prev.get(id) === height) return prev;
      const next = new Map(prev);
      next.set(id, height);
      return next;
    });
  }, []);

  // レイアウト状態
  const [layoutState, setLayoutState] = useState<{
    grid: Grid;
    delayMap: Map<string, number>;
    prevNoteIds: Set<string>;
    prevColumnCount: number;
    prevHeightMap: Map<string, number>;
  }>({
    grid: new Map(),
    delayMap: new Map(),
    prevNoteIds: new Set(),
    prevColumnCount: 0,
    prevHeightMap: new Map(),
  });

  const currentNoteIds = useMemo(
    () => new Set(scoredNotes.map((n) => n.id)),
    [scoredNotes],
  );

  if (
    currentNoteIds !== layoutState.prevNoteIds ||
    columnCount !== layoutState.prevColumnCount ||
    heightMap !== layoutState.prevHeightMap
  ) {
    let result: { grid: Grid; chain: { chainOrder: ReadonlyMap<string, number> } };

    if (
      columnCount !== layoutState.prevColumnCount ||
      layoutState.grid.size === 0
    ) {
      // ── シナリオA: 初期配置 / カラム数変更 ──
      result = buildInitialLayout(scoredNotes, columnCount, heightMap);
    } else {
      const newNotes = scoredNotes.filter(
        (n) => !layoutState.prevNoteIds.has(n.id),
      );

      if (newNotes.length > 0) {
        // ── シナリオB: 新規カード挿入 ──
        // 複数同時挿入時の chainOrder は最後の挿入の値が優先される
        // （実運用では WebSocket で1件ずつ到着するため稀なケース）
        let grid = layoutState.grid;
        const mergedChainOrder = new Map<string, number>();
        for (const note of newNotes) {
          const r = insertCard(grid, note, scoredNotes, columnCount, heightMap);
          grid = r.grid;
          for (const [id, order] of r.chain.chainOrder) {
            mergedChainOrder.set(id, order);
          }
        }
        result = { grid, chain: { chainOrder: mergedChainOrder } };
      } else {
        // ── シナリオC: 高さ変更 / カード削除 ──
        result = reflow(layoutState.grid, scoredNotes, columnCount, heightMap);
      }
    }

    // delayMap 変換: chainOrder × DOMINO_DELAY
    // シナリオC（reflow）では chainOrder が空なので、前回の delayMap を維持する
    let delayMap: Map<string, number>;
    if (result.chain.chainOrder.size > 0) {
      delayMap = new Map<string, number>();
      for (const [id, order] of result.chain.chainOrder) {
        delayMap.set(id, order * DOMINO_DELAY);
      }
    } else if (
      columnCount !== layoutState.prevColumnCount ||
      layoutState.grid.size === 0
    ) {
      // シナリオA: 初期配置 / カラム数変更 → delayMap リセット
      delayMap = new Map<string, number>();
    } else {
      // シナリオC: 高さ変更 / カード削除 → 前回の delayMap を維持
      delayMap = layoutState.delayMap;
    }

    // grid から削除済みカードを除去
    const cleanGrid = new Map<string, Placement>();
    for (const [id, p] of result.grid) {
      if (currentNoteIds.has(id)) cleanGrid.set(id, p);
    }

    setLayoutState({
      grid: cleanGrid,
      delayMap,
      prevNoteIds: currentNoteIds,
      prevColumnCount: columnCount,
      prevHeightMap: heightMap,
    });
  }

  const cardLayout = layoutState.grid;
  const delayMap = layoutState.delayMap;

  function computeColumnHeight(colIdx: number): number {
    let maxBottom = 0;
    for (const [id, placement] of cardLayout) {
      if (placement.col !== colIdx) continue;
      const h = heightMap.get(id) ?? DEFAULT_CARD_HEIGHT;
      const bottom = placement.y + h;
      if (bottom > maxBottom) maxBottom = bottom;
    }
    return maxBottom;
  }

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
        <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">
          Nostr Live Canvas
        </h1>
        {statusIndicator()}
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

        {notes.length > 0 && (() => {
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
                  {scoredNotes
                    .filter((n) => cardLayout.has(n.id))
                    .map((note, idx, arr) => {
                      const placement = cardLayout.get(note.id)!;
                      const x = placement.col * (COLUMN_WIDTH + COLUMN_GAP);
                      const y = placement.y;
                      const delay = delayMap.get(note.id) ?? 0;
                      const zIndex = arr.length - idx;
                      return (
                        <motion.div
                          key={note.id}
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
                          <NoteCard
                            note={note}
                            profile={profiles.get(note.pubkey)}
                            onHeightChange={handleHeightChange}
                          />
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
