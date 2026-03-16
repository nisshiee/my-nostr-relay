"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import type { CanvasNote, NostrProfile } from "../lib/types";
import {
  COLUMN_WIDTH,
  SCORE_UPDATE_INTERVAL,
  FADEOUT_THRESHOLD,
  FADEOUT_DURATION,
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
    // 右側
    if (center + offset < columnCount) {
      order.push(center + offset);
    }
    // 左側
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

  // ラウンドロビンで中央列から順に割り当て
  sortedNotes.forEach((note, i) => {
    const colIdx = order[i % columnCount];
    columns[colIdx].push(note);
  });

  return columns;
}

export function LiveCanvas({ notes, profiles, status }: LiveCanvasProps) {
  const [columnCount, setColumnCount] = useState(1);
  // スコア再計算トリガー用のカウンター
  const [scoreTick, setScoreTick] = useState(0);
  // フェードイン管理: 表示済みノートIDを追跡
  const [knownIds, setKnownIds] = useState<Set<string>>(new Set());
  // フェードイン中のノートID
  const [fadingInIds, setFadingInIds] = useState<Set<string>>(new Set());

  // ウィンドウ幅から列数を計算
  useEffect(() => {
    const update = () => setColumnCount(calcColumnCount(window.innerWidth));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // スコア定期再計算
  useEffect(() => {
    const timer = setInterval(() => {
      setScoreTick((t) => t + 1);
    }, SCORE_UPDATE_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  // 新規ノートのフェードイン検出
  useEffect(() => {
    const newIds = new Set<string>();
    for (const note of notes) {
      if (!knownIds.has(note.id)) {
        newIds.add(note.id);
      }
    }

    if (newIds.size > 0) {
      setFadingInIds((prev) => new Set([...prev, ...newIds]));
      setKnownIds((prev) => new Set([...prev, ...newIds]));

      // フェードイン完了後にフラグを外す
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setFadingInIds((prev) => {
            const next = new Set(prev);
            newIds.forEach((id) => next.delete(id));
            return next;
          });
        });
      });
    }
  }, [notes, knownIds]);

  // knownIds の同期: notes から除去されたIDを knownIds からも削除（Set肥大化防止）
  useEffect(() => {
    const currentIds = new Set(notes.map((n) => n.id));
    setKnownIds((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        if (currentIds.has(id)) {
          next.add(id);
        }
      }
      // サイズが変わらなければ更新不要
      if (next.size === prev.size) return prev;
      return next;
    });
  }, [notes]);

  // スコアを再計算してソート（scoreTickの変更で再計算が走る）
  const scoredNotes = useMemo(() => {
    // scoreTick を参照して依存関係を作る（lint用）
    void scoreTick;
    const now = Math.floor(Date.now() / 1000);
    const updated = notes.map((note) => ({
      ...note,
      score: calcFreshnessScore(note.created_at, now),
      fadingOut: note.fadingOut || calcFreshnessScore(note.created_at, now) <= FADEOUT_THRESHOLD,
    }));
    return sortByScore(updated);
  }, [notes, scoreTick]);

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
            <div className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
            <span className="text-xs">接続中...</span>
          </div>
        );
      case "connected":
        return (
          <div className="flex items-center gap-2 text-green-500">
            <div className="w-2 h-2 rounded-full bg-green-500" />
            <span className="text-xs">接続済み</span>
          </div>
        );
      case "error":
        return (
          <div className="flex items-center gap-2 text-red-500">
            <div className="w-2 h-2 rounded-full bg-red-500" />
            <span className="text-xs">接続エラー</span>
          </div>
        );
    }
  }, [status]);

  return (
    <div className="flex flex-col h-screen bg-gray-50 dark:bg-gray-950">
      {/* ヘッダー */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex-shrink-0">
        <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">
          Nostr Live Canvas
        </h1>
        {statusIndicator()}
      </header>

      {/* メインコンテンツ */}
      <main className="flex-1 overflow-y-auto p-4">
        {/* 接続中のローディング表示 */}
        {status === "connecting" && notes.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div className="w-10 h-10 border-4 border-purple-400 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
              <p className="text-gray-500 dark:text-gray-400">
                リレーに接続中...
              </p>
            </div>
          </div>
        )}

        {/* エラー表示 */}
        {status === "error" && notes.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <p className="text-red-500 text-lg mb-2">⚠️ 接続エラー</p>
              <p className="text-gray-500 dark:text-gray-400 text-sm">
                リレーへの接続に失敗しました。再接続を試みています...
              </p>
            </div>
          </div>
        )}

        {/* Masonry グリッド */}
        {notes.length > 0 && (
          <div className="flex gap-4 justify-center">
            {columns.map((colNotes, colIdx) => (
              <div
                key={colIdx}
                className="flex flex-col"
                style={{ width: `${COLUMN_WIDTH}px`, maxWidth: `${COLUMN_WIDTH}px` }}
              >
                {colNotes.map((note) => (
                  <div
                    key={note.id}
                    className="transition-opacity duration-500 ease-in-out"
                    style={{
                      opacity: fadingInIds.has(note.id) ? 0 : 1,
                    }}
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
