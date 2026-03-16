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

/** カードの配置情報 */
interface CardPlacement {
  col: number;
  y: number;
}

/**
 * カスケード押し出しでカードを配置する
 *
 * 制約:
 * 1. 上には押し出されない（押し出し先の y >= 現在の y）
 * 2. 横に押し出す場合、自分より高さが大きいカードは押し出せない
 * 3. 同じ連鎖内で既に移動したカードは押し出し対象外（循環防止）
 */
function displaceCard(
  layout: Map<string, CardPlacement>,
  columns: Map<string, number>[],  // columns[colIdx] = Map<noteId, y>
  displacedId: string,
  targetCol: number,
  targetY: number,
  heightMap: Map<string, number>,
  columnCount: number,
  movedInChain: Set<string>,
): void {
  const displacedHeight = heightMap.get(displacedId) ?? DEFAULT_CARD_HEIGHT;

  // まず自分を配置（元の列から削除して新位置に）
  for (let c = 0; c < columnCount; c++) {
    columns[c].delete(displacedId);
  }
  columns[targetCol].set(displacedId, targetY);
  layout.set(displacedId, { col: targetCol, y: targetY });
  movedInChain.add(displacedId);

  // 自分と衝突する全カードを収集
  const colCards = columns[targetCol];
  const collisions: { id: string; y: number }[] = [];

  for (const [id, y] of colCards) {
    if (id === displacedId) continue;
    if (movedInChain.has(id)) continue;
    const h = heightMap.get(id) ?? DEFAULT_CARD_HEIGHT;
    if (targetY < y + h + GAP && targetY + displacedHeight + GAP > y) {
      collisions.push({ id, y });
    }
  }

  if (collisions.length === 0) return;

  // 衝突するカードをy座標順に処理（上にあるものから）
  collisions.sort((a, b) => a.y - b.y);

  const pushDownY = targetY + displacedHeight + GAP;

  for (const { id: collidingId, y: collidingY } of collisions) {
    // 既に別の衝突処理で移動済みならスキップ
    if (movedInChain.has(collidingId)) continue;

    const collidingHeight = heightMap.get(collidingId) ?? DEFAULT_CARD_HEIGHT;

    // 横への押し出しを試みる
    // 制約: 自分(displaced)より高さが大きいカードは横に押し出せない
    let displaced = false;
    if (collidingHeight <= displacedHeight) {
      const candidates: { col: number; y: number }[] = [];

      for (const nextCol of [targetCol - 1, targetCol + 1]) {
        if (nextCol < 0 || nextCol >= columnCount) continue;
        // 押し出し先のy は現在のy以上でなければならない（上には押し出されない）
        candidates.push({ col: nextCol, y: collidingY });
      }

      if (candidates.length > 0) {
        const best = candidates[0];
        displaceCard(layout, columns, collidingId, best.col, best.y, heightMap, columnCount, movedInChain);
        displaced = true;
      }
    }

    if (!displaced) {
      // 横に出せない → 下に押し出す
      displaceCard(layout, columns, collidingId, targetCol, pushDownY, heightMap, columnCount, movedInChain);
    }
  }
}

/**
 * 初期配置: スコア昇順で「先頭スコアが最低の列」に配置（単純積み上げ）
 */
function buildInitialLayout(
  sortedNotes: CanvasNote[],
  columnCount: number,
  heightMap: Map<string, number>,
): Map<string, CardPlacement> {
  const layout = new Map<string, CardPlacement>();

  // 各列に割り当てられたノートIDリスト（スコア降順を維持）
  const colNotes: string[][] = Array.from({ length: columnCount }, () => []);

  // スコア昇順で処理して「先頭スコアが最低の列」に配置
  const notesAsc = [...sortedNotes].reverse();
  const topScore = new Array<number>(columnCount).fill(-Infinity);

  for (const note of notesAsc) {
    let bestCol = 0;
    for (let c = 1; c < columnCount; c++) {
      if (topScore[c] < topScore[bestCol]) {
        bestCol = c;
      }
    }
    colNotes[bestCol].push(note.id);
    topScore[bestCol] = note.score;
  }

  // 各列内をスコア降順でソートしてy座標を積み上げ
  const scoreMap = new Map(sortedNotes.map((n) => [n.id, n.score]));
  for (let col = 0; col < columnCount; col++) {
    colNotes[col].sort((a, b) => (scoreMap.get(b) ?? 0) - (scoreMap.get(a) ?? 0));
    let y = 0;
    for (const id of colNotes[col]) {
      layout.set(id, { col, y });
      y += (heightMap.get(id) ?? DEFAULT_CARD_HEIGHT) + GAP;
    }
  }

  return layout;
}

/**
 * 新規カード1枚を既存レイアウトに挿入
 */
function insertIntoLayout(
  prevLayout: Map<string, CardPlacement>,
  note: CanvasNote,
  allNotes: CanvasNote[],
  columnCount: number,
  heightMap: Map<string, number>,
): Map<string, CardPlacement> {
  const layout = new Map(prevLayout);
  const columns: Map<string, number>[] = Array.from(
    { length: columnCount },
    () => new Map(),
  );

  // 既存レイアウトからcolumns を復元
  for (const [id, placement] of layout) {
    if (placement.col < columnCount) {
      columns[placement.col].set(id, placement.y);
    }
  }

  // 先頭スコアが最低の列を探す
  const topScore = new Array<number>(columnCount).fill(-Infinity);
  for (const n of allNotes) {
    const p = layout.get(n.id);
    if (!p) continue;
    if (n.score > topScore[p.col]) {
      topScore[p.col] = n.score;
    }
  }

  let bestCol = 0;
  for (let c = 1; c < columnCount; c++) {
    if (topScore[c] < topScore[bestCol]) {
      bestCol = c;
    }
  }

  // 列のトップ（y=0）に挿入してカスケード押し出し
  const movedInChain = new Set<string>();
  displaceCard(layout, columns, note.id, bestCol, 0, heightMap, columnCount, movedInChain);

  return layout;
}

interface LiveCanvasProps {
  notes: CanvasNote[];
  profiles: Map<string, NostrProfile>;
  status: "connecting" | "loading" | "connected" | "error";
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

  // カスケード押し出しベースのレイアウト状態
  const [layoutState, setLayoutState] = useState<{
    layout: Map<string, CardPlacement>;
    prevNoteIds: Set<string>;
    prevColumnCount: number;
    prevHeightMap: Map<string, number>;
  }>({
    layout: new Map(),
    prevNoteIds: new Set(),
    prevColumnCount: 0,
    prevHeightMap: new Map(),
  });

  // デバッグ: レイアウト結果を出力
  const debugLayout = useCallback((label: string, layout: Map<string, CardPlacement>, _notes: CanvasNote[]) => {
    const colSummary: Record<number, { count: number; cards: { id: string; y: number; h: number }[] }> = {};
    for (const [id, p] of layout) {
      if (!colSummary[p.col]) colSummary[p.col] = { count: 0, cards: [] };
      colSummary[p.col].count++;
      colSummary[p.col].cards.push({ id: id.slice(0, 8), y: Math.round(p.y), h: heightMap.get(id) ?? -1 });
    }
    // 重なりチェック
    for (const [col, data] of Object.entries(colSummary)) {
      const sorted = [...data.cards].sort((a, b) => a.y - b.y);
      for (let i = 0; i < sorted.length - 1; i++) {
        const cur = sorted[i];
        const next = sorted[i + 1];
        const curH = cur.h === -1 ? DEFAULT_CARD_HEIGHT : cur.h;
        if (cur.y + curH + GAP > next.y) {
          console.warn(`[${label}] OVERLAP col${col}: ${cur.id}(y=${cur.y},h=${curH}) <-> ${next.id}(y=${next.y}) gap=${next.y - cur.y - curH}`);
        }
      }
    }
    console.log(`[${label}] total=${layout.size} cols=${JSON.stringify(Object.fromEntries(Object.entries(colSummary).map(([k, v]) => [k, v.count])))}`);
  }, [heightMap]);

  // ノートの追加・列数変更・高さ変更を検知してレイアウトを更新
  const currentNoteIds = useMemo(
    () => new Set(scoredNotes.map((n) => n.id)),
    [scoredNotes],
  );

  if (
    currentNoteIds !== layoutState.prevNoteIds ||
    columnCount !== layoutState.prevColumnCount ||
    heightMap !== layoutState.prevHeightMap
  ) {
    let newLayout: Map<string, CardPlacement>;

    // 列数が変わった or 初回 → 全体を再配置
    if (
      columnCount !== layoutState.prevColumnCount ||
      layoutState.layout.size === 0
    ) {
      newLayout = buildInitialLayout(scoredNotes, columnCount, heightMap);
    } else {
      // 新規カードだけ挿入
      const newNotes = scoredNotes.filter(
        (n) => !layoutState.prevNoteIds.has(n.id),
      );

      if (newNotes.length > 0) {
        newLayout = new Map(layoutState.layout);
        for (const note of newNotes) {
          newLayout = insertIntoLayout(
            newLayout,
            note,
            scoredNotes,
            columnCount,
            heightMap,
          );
        }
      } else {
        // 新規なし（高さ変更 or カード削除のみ）
        // 列割り当てはそのまま維持、y座標だけ再計算
        newLayout = new Map<string, CardPlacement>();
        for (let col = 0; col < columnCount; col++) {
          // この列のカードをスコア降順で取得（scoredNotes の順番を使う）
          const colCards = scoredNotes.filter((n) => {
            const p = layoutState.layout.get(n.id);
            return p !== undefined && p.col === col;
          });
          let y = 0;
          for (const note of colCards) {
            newLayout.set(note.id, { col, y });
            y += (heightMap.get(note.id) ?? DEFAULT_CARD_HEIGHT) + GAP;
          }
        }
      }

      // 削除されたカードをレイアウトから除去
      for (const id of newLayout.keys()) {
        if (!currentNoteIds.has(id)) {
          newLayout.delete(id);
        }
      }
    }

    const isInitial = columnCount !== layoutState.prevColumnCount || layoutState.layout.size === 0;
    const addedCount = newLayout.size - layoutState.layout.size;
    debugLayout(
      isInitial ? "initial" : addedCount > 0 ? `insert(${addedCount})` : "heightChange",
      newLayout,
      scoredNotes,
    );

    setLayoutState({
      layout: newLayout,
      prevNoteIds: currentNoteIds,
      prevColumnCount: columnCount,
      prevHeightMap: heightMap,
    });
  }

  const cardLayout = layoutState.layout;

  /**
   * 列の高さを cardLayout ベースで計算する
   */
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

        {/* 初期ロード中の表示 */}
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

        {/* Masonry グリッド（absolute positioning + カスケード押し出し） */}
        {notes.length > 0 && (
          <div className="flex justify-center gap-4">
            {Array.from({ length: columnCount }, (_, colIdx) => {
              const colNotes = scoredNotes.filter((n) => {
                const p = cardLayout.get(n.id);
                return p !== undefined && p.col === colIdx;
              });
              const columnHeight = computeColumnHeight(colIdx);

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
                      const placement = cardLayout.get(note.id);
                      const y = placement?.y ?? 0;
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
