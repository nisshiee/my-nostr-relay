/**
 * store/slices/canvas.ts
 *
 * Canvas 操作（同期）: 高さ管理、カラム数、ホールド、tick。
 * hooks/useCardLayout.ts の同期操作部分を移植。
 *
 * レイアウト計算は store/pure/layoutEngine.ts の純粋関数に委譲する。
 * スコア再計算は store/pure/scoring.ts に委譲する。
 */

import type { StateCreator } from "zustand";
import type { CanvasStore } from "../types";
import type { Card } from "../../lib/types";
import type { Placement } from "../../lib/layoutTypes";
import {
  buildInitialLayout,

  reflow,
} from "../pure/layoutEngine";
import { calcFreshnessScore, sortByScore } from "../pure/scoring";
import {

  DOMINO_DELAY,
  FADEOUT_THRESHOLD,
  MAX_NOTES,
  SCORE_HALF_LIFE,
  OWNER_SCORE_HALF_LIFE,
} from "../../lib/constants";

// ---------------------------------------------------------------------------
// Slice 型
// ---------------------------------------------------------------------------

export interface CanvasSlice {
  // state
  heights: Map<string, number>;
  delays: Map<string, number>;
  columnCount: number;
  holdSet: Set<string>;
  layout: Map<string, Placement>;
  cards: Card[];

  // actions
  setHeight: (slotId: string, height: number) => void;
  setColumnCount: (count: number) => void;
  holdCard: (slotId: string) => void;
  releaseCard: (slotId: string) => void;
  tick: (now: number) => void;
}

// ---------------------------------------------------------------------------
// 内部ヘルパー
// ---------------------------------------------------------------------------

/**
 * delayMap を chainOrder から変換する。
 * chainOrder が空の場合は prevDelays を返す（reflow では連鎖なし）。
 */
function buildDelayMap(
  chainOrder: ReadonlyMap<string, number>,
  prevDelays: Map<string, number>,
  isReset: boolean,
): Map<string, number> {
  if (chainOrder.size > 0) {
    const delays = new Map<string, number>();
    for (const [id, order] of chainOrder) {
      delays.set(id, order * DOMINO_DELAY);
    }
    return delays;
  }
  if (isReset) {
    return new Map();
  }
  return prevDelays;
}

// ---------------------------------------------------------------------------
// Slice 実装
// ---------------------------------------------------------------------------

export const createCanvasSlice: StateCreator<
  CanvasStore,
  [],
  [],
  CanvasSlice
> = (set, get) => ({
  // --- initial state ---
  heights: new Map(),
  delays: new Map(),
  columnCount: 3,
  holdSet: new Set(),
  layout: new Map(),
  cards: [],

  // --- actions ---

  /**
   * カードの DOM 測定高さを記録し、レイアウトを再計算する（reflow）。
   */
  setHeight: (slotId: string, height: number) => {
    const { heights, layout, cards, columnCount, delays } = get();

    // 変化なしならスキップ
    if (heights.get(slotId) === height) return;

    const nextHeights = new Map(heights);
    nextHeights.set(slotId, height);

    // reflow: 列割り当て維持、y 座標のみ再計算
    const result = reflow(layout, cards, columnCount, nextHeights);

    set({
      heights: nextHeights,
      layout: result.grid as Map<string, Placement>,
      delays: buildDelayMap(result.chain.chainOrder, delays, false),
    });
  },

  /**
   * カラム数を変更し、レイアウトをフルリビルドする。
   */
  setColumnCount: (count: number) => {
    const { columnCount, cards, heights } = get();
    if (count === columnCount) return;

    // フルリビルド（buildInitialLayout）
    const result = buildInitialLayout(cards, count, heights);

    set({
      columnCount: count,
      layout: result.grid as Map<string, Placement>,
      delays: new Map(), // カラム数変更時は delayMap リセット
      holdSet: new Set(), // カラム数変更時はホールドも解除
    });
  },

  /**
   * カードをホールド状態にする（フェードアウト抑止）。
   */
  holdCard: (slotId: string) => {
    const { holdSet } = get();
    if (holdSet.has(slotId)) return;

    const nextHoldSet = new Set(holdSet);
    nextHoldSet.add(slotId);
    set({ holdSet: nextHoldSet });
  },

  /**
   * カードのホールドを解除する。
   */
  releaseCard: (slotId: string) => {
    const { holdSet } = get();
    if (!holdSet.has(slotId)) return;

    const nextHoldSet = new Set(holdSet);
    nextHoldSet.delete(slotId);
    set({ holdSet: nextHoldSet });
  },

  /**
   * 定期 tick: スコア再計算、フェードアウト判定、MAX_NOTES カリング。
   *
   * 呼び出し元: setInterval（SCORE_UPDATE_INTERVAL ごと）
   */
  tick: (now: number) => {
    const { cards, pubkey, holdSet, layout, heights, columnCount, delays } = get();

    if (cards.length === 0) return;

    // スコア再計算
    let changed = false;
    const updatedCards: Card[] = cards.map((card) => {
      if (card.type === "compose") return card;

      const halfLife = card.pubkey === pubkey ? OWNER_SCORE_HALF_LIFE : SCORE_HALF_LIFE;
      const scoreTimestamp =
        card.type === "note" && card.repostInfo
          ? card.repostInfo.repostedAt
          : card.created_at;
      const newScore = calcFreshnessScore(scoreTimestamp, now, halfLife);

      // フェードアウト判定（ホールド中のカードは除外）
      const shouldFadeOut =
        newScore < FADEOUT_THRESHOLD && !holdSet.has(card.slotId);

      if (card.score !== newScore || card.fadingOut !== shouldFadeOut) {
        changed = true;
        return { ...card, score: newScore, fadingOut: shouldFadeOut };
      }
      return card;
    });

    if (!changed) return;

    // フェードアウト済みカードを除去（fadingOut のまま一定時間経過後に除去は
    // 呼び出し側の責任。ここではスコア更新のみ）
    // MAX_NOTES 超過時は低スコアから削除
    let finalCards = updatedCards;
    if (finalCards.length > MAX_NOTES) {
      const sorted = sortByScore(finalCards);
      finalCards = sorted.slice(0, MAX_NOTES);
    }

    // カード配列が変化した場合は reflow
    const needsReflow = finalCards.length !== cards.length;
    if (needsReflow) {
      const result = reflow(layout, finalCards, columnCount, heights);
      set({
        cards: finalCards,
        layout: result.grid as Map<string, Placement>,
        delays: buildDelayMap(result.chain.chainOrder, delays, false),
      });
    } else {
      set({ cards: finalCards });
    }
  },
});
