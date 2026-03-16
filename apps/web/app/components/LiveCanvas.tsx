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

/**
 * 中央列から外側に向かってインデックスを生成する
 * 例: 列数5 → [2, 3, 1, 4, 0]（中央から外側へ）
 */
function centerOutOrder(columnCount: number): number[] {
  const order: number[] = [];
  const center = Math.floor(columnCount / 2);
  order.push(center);

  for (let offset = 1; offset < columnCount; offset++) {
    if (center + offset < columnCount) {
      order.push(center + offset);
    }
    if (center - offset >= 0) {
      order.push(center - offset);
    }
  }

  return order;
}

/** 横移動を許可する上位行数 */
const MOBILE_ROWS = 4;

/**
 * 目標列に向かって±1列ずつ移動する（隣の列までしか動かない）
 */
function moveToward(current: number, target: number): number {
  if (target > current) return current + 1;
  if (target < current) return current - 1;
  return current;
}

/**
 * 最も短い列のインデックスを返す
 */
function shortestColumn(columns: CanvasNote[][]): number {
  let minIdx = 0;
  let minLen = columns[0].length;
  for (let c = 1; c < columns.length; c++) {
    if (columns[c].length < minLen) {
      minLen = columns[c].length;
      minIdx = c;
    }
  }
  return minIdx;
}

/**
 * スコア降順のノートを列に割り当てる
 *
 * - 上位ノート（MOBILE_ROWS 行分）は中央優先の理想列に向かって±1列ずつ移動
 *   ただし、移動する側のカードより高さが大きいカードを押し出してしまう場合は移動しない
 * - それ以降のノートは前回の列を維持（横移動なし）
 * - 前回の列情報がないノート（新規）は最も短い列に配置
 */
function distributeToColumns(
  sortedNotes: CanvasNote[],
  columnCount: number,
  prevAssignment: Map<string, number>,
  heightMap: Map<string, number>
): { columns: CanvasNote[][]; assignment: Map<string, number> } {
  const columns: CanvasNote[][] = Array.from(
    { length: columnCount },
    () => []
  );
  const assignment = new Map<string, number>();
  const order = centerOutOrder(columnCount);

  const getHeight = (id: string) => heightMap.get(id) ?? DEFAULT_CARD_HEIGHT;

  // 横移動可能な上位ノート数（MOBILE_ROWS 行 × 列数）
  const mobileCount = Math.min(
    MOBILE_ROWS * columnCount,
    sortedNotes.length
  );

  // 上位ノート: 理想列に向かって±1列ずつ移動
  for (let i = 0; i < mobileCount; i++) {
    const note = sortedNotes[i];
    const idealCol = order[i % columnCount];
    const prevCol = prevAssignment.get(note.id);

    let col: number;
    if (prevCol === undefined || prevCol >= columnCount) {
      // 新規ノート → 理想列にそのまま配置
      col = idealCol;
    } else if (prevCol === idealCol) {
      // 既に理想列にいる
      col = prevCol;
    } else {
      // 既存ノート → 前回の列から理想列へ±1列移動を試みる
      const candidateCol = moveToward(prevCol, idealCol);
      const myHeight = getHeight(note.id);

      // 移動先の列にいるカードのうち、自分より高さが大きいカードがあるか確認
      // そのカードが自分の移動によって押し出される（下にずれる）ことになる
      const wouldDisplaceTaller = columns[candidateCol].some(
        (existing) => getHeight(existing.id) > myHeight
      );

      col = wouldDisplaceTaller ? prevCol : candidateCol;
    }
    columns[col].push(note);
    assignment.set(note.id, col);
  }

  // 下位ノート: 前回の列を維持
  for (let i = mobileCount; i < sortedNotes.length; i++) {
    const note = sortedNotes[i];
    const prevCol = prevAssignment.get(note.id);

    if (prevCol !== undefined && prevCol < columnCount) {
      columns[prevCol].push(note);
      assignment.set(note.id, prevCol);
    } else {
      // 新規 or 列数変更 → 最も短い列に
      const col = shortestColumn(columns);
      columns[col].push(note);
      assignment.set(note.id, col);
    }
  }

  // 各列内をスコア降順でソート（古いノートが上に残るのを防ぐ）
  for (const col of columns) {
    col.sort((a, b) => b.score - a.score);
  }

  return { columns, assignment };
}

export function LiveCanvas({ notes, profiles, status }: LiveCanvasProps) {
  const [columnCount, setColumnCount] = useState(1);
  // スコア再計算用の基準時刻（タイマーで定期更新）
  const [nowEpoch, setNowEpoch] = useState(() => Math.floor(Date.now() / 1000));

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
    () => new Map()
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
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [columnState, setColumnState] = useState<{
    columns: CanvasNote[][];
    assignment: Map<string, number>;
    prevScoredNotes: CanvasNote[];
    prevColumnCount: number;
    prevHeightMap: Map<string, number>;
  }>({
    columns: [],
    assignment: new Map(),
    prevScoredNotes: [],
    prevColumnCount: 0,
    prevHeightMap: new Map(),
  });

  if (
    scoredNotes !== columnState.prevScoredNotes ||
    columnCount !== columnState.prevColumnCount ||
    heightMap !== columnState.prevHeightMap
  ) {
    const result = distributeToColumns(
      scoredNotes,
      columnCount,
      columnState.assignment,
      heightMap
    );
    setColumnState({
      columns: result.columns,
      assignment: result.assignment,
      prevScoredNotes: scoredNotes,
      prevColumnCount: columnCount,
      prevHeightMap: heightMap,
    });
  }

  const columns = columnState.columns;

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

        {/* Masonry グリッド */}
        {notes.length > 0 && (
          <div className="flex justify-center gap-4">
            {columns.map((colNotes, colIdx) => (
              <div
                key={colIdx}
                className="flex flex-col"
                style={{ width: `${COLUMN_WIDTH}px`, maxWidth: `${COLUMN_WIDTH}px` }}
              >
                <AnimatePresence mode="popLayout">
                  {colNotes.map((note) => (
                    <motion.div
                      key={note.id}
                      layoutId={note.id}
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{
                        opacity: note.fadingOut ? 0 : 1,
                        scale: note.fadingOut ? 0.95 : 1,
                      }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      transition={{
                        layout: { type: "spring", stiffness: 300, damping: 30 },
                        opacity: { duration: note.fadingOut ? 1 : 0.4 },
                        scale: { duration: note.fadingOut ? 1 : 0.3 },
                      }}
                    >
                      <NoteCard
                        note={note}
                        profile={profiles.get(note.pubkey)}
                        onHeightChange={handleHeightChange}
                      />
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
