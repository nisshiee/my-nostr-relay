"use client";

import { useState, useCallback, useMemo } from "react";
import type { Card } from "../lib/types";
import type { Grid, Placement } from "../lib/layoutTypes";
import { DEFAULT_CARD_HEIGHT, DOMINO_DELAY } from "../lib/constants";
import {
  buildInitialLayout,
  insertCard,
  reflow,
} from "../lib/layoutEngine";

interface UseCardLayoutResult {
  heightMap: Map<string, number>;
  handleHeightChange: (slotId: string, height: number) => void;
  cardLayout: Grid;
  delayMap: Map<string, number>;
  computeColumnHeight: (colIdx: number) => number;
}

/**
 * カードのレイアウト計算hook。
 *
 * heightMap を内部管理し、scoredCards と columnCount に応じて
 * グリッド配置とアニメーション遅延を計算する。
 *
 * render-time state update パターンを使用しているため、
 * useEffect ではなくレンダリング中に同期的にレイアウトを更新する。
 */
export function useCardLayout(
  scoredCards: Card[],
  columnCount: number,
): UseCardLayoutResult {
  const [heightMap, setHeightMap] = useState<Map<string, number>>(
    () => new Map(),
  );

  const handleHeightChange = useCallback((slotId: string, height: number) => {
    setHeightMap((prev) => {
      if (prev.get(slotId) === height) return prev;
      const next = new Map(prev);
      next.set(slotId, height);
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
    () => new Set(scoredCards.map((n) => n.slotId)),
    [scoredCards],
  );

  // render-time state update: レイアウト再計算
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
      result = buildInitialLayout(scoredCards, columnCount, heightMap);
    } else {
      const newNotes = scoredCards.filter(
        (n) => !layoutState.prevNoteIds.has(n.slotId) && !layoutState.grid.has(n.slotId),
      );

      if (newNotes.length > 0) {
        // ── シナリオB: 新規カード挿入 ──
        let grid = layoutState.grid;
        const mergedChainOrder = new Map<string, number>();
        for (const note of newNotes) {
          const r = insertCard(grid, note, scoredCards, columnCount, heightMap);
          grid = r.grid;
          for (const [id, order] of r.chain.chainOrder) {
            mergedChainOrder.set(id, order);
          }
        }
        result = { grid, chain: { chainOrder: mergedChainOrder } };
      } else {
        // ── シナリオC: 高さ変更 / カード削除 ──
        result = reflow(layoutState.grid, scoredCards, columnCount, heightMap);
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

  const computeColumnHeight = useCallback(
    (colIdx: number): number => {
      let maxBottom = 0;
      for (const [id, placement] of cardLayout) {
        if (placement.col !== colIdx) continue;
        const h = heightMap.get(id) ?? DEFAULT_CARD_HEIGHT;
        const bottom = placement.y + h;
        if (bottom > maxBottom) maxBottom = bottom;
      }
      return maxBottom;
    },
    [cardLayout, heightMap],
  );

  return {
    heightMap,
    handleHeightChange,
    cardLayout,
    delayMap,
    computeColumnHeight,
  };
}
