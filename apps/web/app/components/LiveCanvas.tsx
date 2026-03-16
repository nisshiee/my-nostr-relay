"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import type { CanvasNote, NostrProfile } from "../lib/types";
import {
  COLUMN_WIDTH,
  SCORE_UPDATE_INTERVAL,
  FADEOUT_THRESHOLD,
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

/**
 * スコア降順のノートを中央優先で列に割り当てる
 * 高スコアノートが中央列に、低スコアが端列に配置される
 */
function distributeToColumns(
  sortedNotes: CanvasNote[],
  columnCount: number
): CanvasNote[][] {
  const columns: CanvasNote[][] = Array.from(
    { length: columnCount },
    () => []
  );
  const order = centerOutOrder(columnCount);

  sortedNotes.forEach((note, i) => {
    const colIdx = order[i % columnCount];
    columns[colIdx].push(note);
  });

  return columns;
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

  // 列に分配
  const columns = useMemo(
    () => distributeToColumns(scoredNotes, columnCount),
    [scoredNotes, columnCount]
  );

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
                {colNotes.map((note) => (
                  <div
                    key={note.id}
                    className="animate-[fadeIn_500ms_ease-in-out]"
                  >
                    <NoteCard
                      note={note}
                      profile={profiles.get(note.pubkey)}
                      fadingOut={note.fadingOut}
                    />
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
