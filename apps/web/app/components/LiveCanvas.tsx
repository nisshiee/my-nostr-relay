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
 * カードを指定位置に配置し、押し出されるカードをドミノ式に処理する
 *
 * 押し出しルール:
 * 0. 押し出されるカードが列の一番下 → その列の最後尾に配置して終了
 * 1. 押し出し先候補のリストアップ:
 *    - 同じ列の、元位置の直下のカード
 *    - 左右の列で、元位置とy座標が1pxでも重なるカード（複数可）
 * 2. 別列の候補から除外:
 *    - 押し出されるカードより高さが大きいもの（同じ高さはOK）
 *    - topのy座標が押し出されるカードの元位置のtopより小さい（上にある）もの
 *    - 既にこの連鎖で押し出されたもの
 * 3. 残った候補のうちスコアが最も低いものの位置に移動 → 連鎖
 */
/** ドミノアニメーションの1ステップあたりの遅延（秒） */
const DOMINO_DELAY = 0.5;

function placeCard(
  layout: Map<string, CardPlacement>,
  columns: { id: string; y: number }[][],
  cardId: string,
  targetCol: number,
  targetY: number,
  heightMap: Map<string, number>,
  scoreMap: Map<string, number>,
  columnCount: number,
  movedInChain: Set<string>,
  /** 各カードの連鎖順序を記録（アニメーション遅延に使用） */
  chainOrder?: Map<string, number>,
): void {
  const cardHeight = heightMap.get(cardId) ?? DEFAULT_CARD_HEIGHT;

  // この位置にいるカードを探す
  const colCards = columns[targetCol];
  const victimIdx = colCards.findIndex(
    (c) => c.id !== cardId && !movedInChain.has(c.id) && c.y === targetY,
  );

  // 自分を配置（元の列から削除して新位置に）
  for (let c = 0; c < columnCount; c++) {
    columns[c] = columns[c].filter((card) => card.id !== cardId);
  }
  columns[targetCol].push({ id: cardId, y: targetY });
  layout.set(cardId, { col: targetCol, y: targetY });
  movedInChain.add(cardId);
  if (chainOrder) {
    chainOrder.set(cardId, chainOrder.size);
  }

  // 押し出す相手がいない → 終了
  if (victimIdx === -1) return;

  // victimIdx は filter 前の colCards を参照しているので、
  // filter 後の columns[targetCol] から victim を探し直す
  const victim = columns[targetCol].find(
    (c) => c.id !== cardId && c.y === targetY && !movedInChain.has(c.id),
  );
  if (!victim) return;

  const victimId = victim.id;
  const victimY = victim.y;
  const victimHeight = heightMap.get(victimId) ?? DEFAULT_CARD_HEIGHT;

  // --- ステップ0: 列の一番下のカードなら最後尾に配置して終了 ---
  const sameColOthers = columns[targetCol].filter((c) => c.id !== victimId);
  const isBottomOfColumn = sameColOthers.every((c) => c.y <= victimY);

  if (isBottomOfColumn) {
    const newY = targetY + cardHeight + GAP;
    columns[targetCol] = columns[targetCol].filter((c) => c.id !== victimId);
    columns[targetCol].push({ id: victimId, y: newY });
    layout.set(victimId, { col: targetCol, y: newY });
    movedInChain.add(victimId);
    return;
  }

  // --- ステップ1: 押し出し先候補のリストアップ ---
  interface Candidate {
    id: string;
    col: number;
    y: number;
    score: number;
  }
  const candidates: Candidate[] = [];

  // 1a. 同じ列の、元位置の直下のカード
  const belowInCol = columns[targetCol]
    .filter((c) => c.id !== victimId && c.y > victimY)
    .sort((a, b) => a.y - b.y);
  if (belowInCol.length > 0) {
    const below = belowInCol[0];
    candidates.push({
      id: below.id,
      col: targetCol,
      y: below.y,
      score: scoreMap.get(below.id) ?? 0,
    });
  }

  // 1b. 左右の列で、元位置とy座標が1pxでも重なるカード
  const victimBottom = victimY + victimHeight;
  for (const adjCol of [targetCol - 1, targetCol + 1]) {
    if (adjCol < 0 || adjCol >= columnCount) continue;
    for (const card of columns[adjCol]) {
      const cardH = heightMap.get(card.id) ?? DEFAULT_CARD_HEIGHT;
      const cardBottom = card.y + cardH;
      if (victimY < cardBottom && victimBottom > card.y) {
        candidates.push({
          id: card.id,
          col: adjCol,
          y: card.y,
          score: scoreMap.get(card.id) ?? 0,
        });
      }
    }
  }

  // --- ステップ2: 別列の候補から除外 ---
  const filtered = candidates.filter((c) => {
    // 同じ列の候補は除外対象外（常に残る）
    if (c.col === targetCol) return true;

    // topのy座標が押し出されるカードの元位置のtopより小さい（上にある）もの
    if (c.y < victimY) return false;

    // 既にこの連鎖で押し出されたもの
    if (movedInChain.has(c.id)) return false;

    return true;
  });

  // --- ステップ3: 最もスコアが低いものを押し出し先とする ---
  if (filtered.length === 0) {
    // 候補がない → 下に配置して終了
    const newY = targetY + cardHeight + GAP;
    columns[targetCol] = columns[targetCol].filter((c) => c.id !== victimId);
    columns[targetCol].push({ id: victimId, y: newY });
    layout.set(victimId, { col: targetCol, y: newY });
    movedInChain.add(victimId);
    return;
  }

  const best = filtered.reduce((a, b) => (a.score <= b.score ? a : b));

  // 押し出されるカードを best の位置に配置 → best が次に押し出される
  placeCard(layout, columns, victimId, best.col, best.y, heightMap, scoreMap, columnCount, movedInChain, chainOrder);
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

  const colNotes: string[][] = Array.from({ length: columnCount }, () => []);

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
): { layout: Map<string, CardPlacement>; chainOrder: Map<string, number> } {
  const layout = new Map(prevLayout);

  const columns: { id: string; y: number }[][] = Array.from(
    { length: columnCount },
    () => [],
  );
  for (const [id, placement] of layout) {
    if (placement.col < columnCount) {
      columns[placement.col].push({ id, y: placement.y });
    }
  }

  // スコアマップ
  const scoreMap = new Map(allNotes.map((n) => [n.id, n.score]));

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

  const movedInChain = new Set<string>();
  const chainOrder = new Map<string, number>();
  placeCard(layout, columns, note.id, bestCol, 0, heightMap, scoreMap, columnCount, movedInChain, chainOrder);

  return { layout, chainOrder };
}

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
    layout: Map<string, CardPlacement>;
    delayMap: Map<string, number>;
    prevNoteIds: Set<string>;
    prevColumnCount: number;
    prevHeightMap: Map<string, number>;
  }>({
    layout: new Map(),
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
    let newLayout: Map<string, CardPlacement>;
    const newDelayMap = new Map<string, number>();

    if (
      columnCount !== layoutState.prevColumnCount ||
      layoutState.layout.size === 0
    ) {
      newLayout = buildInitialLayout(scoredNotes, columnCount, heightMap);
      // 初期配置はアニメーション遅延なし
    } else {
      const newNotes = scoredNotes.filter(
        (n) => !layoutState.prevNoteIds.has(n.id),
      );

      if (newNotes.length > 0) {
        newLayout = new Map(layoutState.layout);
        for (const note of newNotes) {
          const result = insertIntoLayout(
            newLayout,
            note,
            scoredNotes,
            columnCount,
            heightMap,
          );
          newLayout = result.layout;
          // chainOrder をアニメーション遅延に変換
          for (const [id, order] of result.chainOrder) {
            newDelayMap.set(id, order * DOMINO_DELAY);
          }
        }
      } else {
        // 高さ変更 or カード削除のみ → 列割り当て維持、y座標再計算
        newLayout = new Map<string, CardPlacement>();
        for (let col = 0; col < columnCount; col++) {
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

      for (const id of newLayout.keys()) {
        if (!currentNoteIds.has(id)) {
          newLayout.delete(id);
        }
      }
    }

    setLayoutState({
      layout: newLayout,
      delayMap: newDelayMap,
      prevNoteIds: currentNoteIds,
      prevColumnCount: columnCount,
      prevHeightMap: heightMap,
    });
  }

  const cardLayout = layoutState.layout;
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
                      const delay = delayMap.get(note.id) ?? 0;
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
