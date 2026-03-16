"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { CanvasNote, NostrProfile } from "../lib/types";
import {
  COLUMN_WIDTH,
  SCORE_UPDATE_INTERVAL,
  FADEOUT_THRESHOLD,
  DEFAULT_CARD_HEIGHT,
} from "../lib/constants";
import { calcFreshnessScore, sortByScore } from "../lib/scoring";
import { NoteCard } from "./NoteCard";

/** カード間のギャップ（px）— mb-3 相当 */
const GAP = 12;

/**
 * ノート ID から決定論的に列インデックスを算出する（純粋関数）
 * FNV-1a 風の簡易ハッシュを使用
 */
function idToColumn(id: string, columnCount: number): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % columnCount);
}

interface LiveCanvasProps {
  notes: CanvasNote[];
  profiles: Map<string, NostrProfile>;
  status: "connecting" | "connected" | "error";
}

/**
 * ウィンドウ幅から列数を計算する
 */
function calcColumnCount(width: number): number {
  return Math.max(1, Math.floor(width / COLUMN_WIDTH));
}

export function LiveCanvas({ notes, profiles, status }: LiveCanvasProps) {
  const [columnCount, setColumnCount] = useState(1);
  // スコア再計算用の基準時刻（タイマーで定期更新）
  const [nowEpoch, setNowEpoch] = useState(() =>
    Math.floor(Date.now() / 1000),
  );

  // ウィンドウ幅から列数を計算
  useEffect(() => {
    const update = () => setColumnCount(calcColumnCount(window.innerWidth));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // 基準時刻を定期更新（スコア再計算トリガー）
  useEffect(() => {
    const timer = setInterval(() => {
      setNowEpoch(Math.floor(Date.now() / 1000));
    }, SCORE_UPDATE_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  // スコアを再計算してソート
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

  // カードの高さマップ（ResizeObserver から更新される）
  const [heightMap, setHeightMap] = useState<Map<string, number>>(
    () => new Map(),
  );

  // カードの高さが変わった時のコールバック
  const handleHeightChange = useCallback((id: string, height: number) => {
    setHeightMap((prev) => {
      if (prev.get(id) === height) return prev;
      const next = new Map(prev);
      next.set(id, height);
      return next;
    });
  }, []);

  // 列割り当て状態を「レンダー中の状態調整」パターンで管理
  const [colAssignState, setColAssignState] = useState<{
    assignment: Map<string, number>;
    prevScoredNotes: CanvasNote[];
    prevColumnCount: number;
  }>({
    assignment: new Map(),
    prevScoredNotes: [],
    prevColumnCount: 0,
  });

  if (
    scoredNotes !== colAssignState.prevScoredNotes ||
    columnCount !== colAssignState.prevColumnCount
  ) {
    const newAssignment = new Map<string, number>();

    for (const note of scoredNotes) {
      // ID ベースで決定論的に列を割り当て（列数が変わっても均等分配）
      newAssignment.set(note.id, idToColumn(note.id, columnCount));
    }

    setColAssignState({
      assignment: newAssignment,
      prevScoredNotes: scoredNotes,
      prevColumnCount: columnCount,
    });
  }

  const columnAssignment = colAssignState.assignment;

  // Y 座標の単調増加を保証する状態（レンダー中の状態調整パターン）
  const [yState, setYState] = useState<{
    positions: Map<string, number>;
    prevScoredNotes: CanvasNote[];
    prevColumnAssignment: Map<string, number>;
    prevHeightMap: Map<string, number>;
  }>({
    positions: new Map(),
    prevScoredNotes: [],
    prevColumnAssignment: new Map(),
    prevHeightMap: new Map(),
  });

  if (
    scoredNotes !== yState.prevScoredNotes ||
    columnAssignment !== yState.prevColumnAssignment ||
    heightMap !== yState.prevHeightMap
  ) {
    const newPositions = new Map<string, number>();

    for (let colIdx = 0; colIdx < columnCount; colIdx++) {
      const colNotes = scoredNotes.filter(
        (n) => columnAssignment.get(n.id) === colIdx,
      );
      let y = 0;
      for (const note of colNotes) {
        const prevY = yState.positions.get(note.id);
        // 単調増加: 新しい Y が以前より小さい場合は以前の値を維持
        const newY = prevY !== undefined ? Math.max(y, prevY) : y;
        newPositions.set(note.id, newY);
        y = newY + (heightMap.get(note.id) ?? DEFAULT_CARD_HEIGHT) + GAP;
      }
    }

    setYState({
      positions: newPositions,
      prevScoredNotes: scoredNotes,
      prevColumnAssignment: columnAssignment,
      prevHeightMap: heightMap,
    });
  }

  const yPositions = yState.positions;

  /**
   * 列の高さを yPositions ベースで計算する
   */
  function computeColumnHeight(
    colNotes: CanvasNote[],
  ): number {
    if (colNotes.length === 0) return 0;
    let maxBottom = 0;
    for (const note of colNotes) {
      const y = yPositions.get(note.id) ?? 0;
      const h = heightMap.get(note.id) ?? DEFAULT_CARD_HEIGHT;
      const bottom = y + h;
      if (bottom > maxBottom) maxBottom = bottom;
    }
    return maxBottom;
  }

  // 接続状態インジケーター
  const statusIndicator = useCallback(() => {
    switch (status) {
      case "connecting":
        return (
          <div className="flex items-center gap-2 text-yellow-500">
            <div className="h-2 w-2 animate-pulse rounded-full bg-yellow-500" />
            <span className="text-xs">接続中...</span>
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
      {/* ヘッダー */}
      <header className="flex shrink-0 items-center justify-between border-b border-gray-200 bg-white px-6 py-3 dark:border-gray-800 dark:bg-gray-900">
        <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">
          Nostr Live Canvas
        </h1>
        {statusIndicator()}
      </header>

      {/* メインコンテンツ */}
      <main className="flex-1 overflow-y-auto p-4">
        {/* 接続中のローディング表示 */}
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

        {/* エラー表示 */}
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

        {/* Masonry グリッド（absolute positioning） */}
        {notes.length > 0 && (
          <div className="flex justify-center gap-4">
            {Array.from({ length: columnCount }, (_, colIdx) => {
              const colNotes = scoredNotes.filter(
                (n) => columnAssignment.get(n.id) === colIdx,
              );
              const columnHeight = computeColumnHeight(colNotes);

              return (
                <div
                  key={colIdx}
                  className="relative"
                  style={{
                    width: `${COLUMN_WIDTH}px`,
                    maxWidth: `${COLUMN_WIDTH}px`,
                    height: columnHeight,
                  }}
                >
                  <AnimatePresence>
                    {colNotes.map((note) => {
                      const y = yPositions.get(note.id) ?? 0;
                      return (
                        <motion.div
                          key={note.id}
                          initial={{ opacity: 0, scale: 0.8 }}
                          animate={{
                            opacity: note.fadingOut ? 0 : 1,
                            scale: note.fadingOut ? 0.95 : 1,
                            y,
                          }}
                          exit={{ opacity: 0, scale: 0.8 }}
                          transition={{
                            y: {
                              type: "spring",
                              stiffness: 300,
                              damping: 30,
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
                            width: "100%",
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
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
