/**
 * Canvas Store — zustand ストア（全 slice 統合）
 *
 * 各 slice の実装は store/slices/ 以下。
 * ここでは zustand create() で全 slice を統合する。
 *
 * cards → layout の自動同期:
 *   cards が変更されると subscribe でレイアウトを再計算する。
 *   これにより feed / threads 等の slice が layout を直接管理する必要がない。
 */

import { create } from "zustand";
import type { CanvasStore } from "./types";
import type { Placement } from "../lib/layoutTypes";
import { createConnectionSlice } from "./slices/connection";
import { createProfilesSlice } from "./slices/profiles";
import { createCanvasSlice } from "./slices/canvas";
import { createFeedSlice } from "./slices/feed";
import { createThreadsSlice } from "./slices/threads";
import { createReactionsSlice } from "./slices/reactions";
import { createQuotesSlice } from "./slices/quotes";
import { createPublishSlice } from "./slices/publish";
import {
  buildInitialLayout,
  insertCard,
  reflow,
} from "./pure/layoutEngine";
import { DOMINO_DELAY } from "../lib/constants";

// ---------------------------------------------------------------------------
// Store 作成（全 8 slice 統合）
// ---------------------------------------------------------------------------

const useCanvasStore = create<CanvasStore>()((...args) => ({
  ...createConnectionSlice(...args),
  ...createProfilesSlice(...args),
  ...createCanvasSlice(...args),
  ...createFeedSlice(...args),
  ...createThreadsSlice(...args),
  ...createReactionsSlice(...args),
  ...createQuotesSlice(...args),
  ...createPublishSlice(...args),
}));

// ---------------------------------------------------------------------------
// cards → layout 自動同期（差分処理）
//
// 旧 useCardLayout の3シナリオを移植:
//   A: 初期配置 / カラム数変更 → buildInitialLayout（フルリビルド）
//   B: 新規カード追加 → insertCard（差分挿入、既存カードの位置は維持）
//   C: カード削除 → reflow（列割り当て維持、Y座標のみ再計算）
//
// setHeight / setColumnCount は canvas slice 側で直接 reflow するので、
// ここでは cards 変更に限定して反応する。
// ---------------------------------------------------------------------------
let prevCardIds = new Set<string>();

useCanvasStore.subscribe((state) => {
  const currentCardIds = new Set(state.cards.map((c) => c.slotId));

  // slotId 集合が同じなら何もしない（スコア更新だけの場合など）
  if (
    currentCardIds.size === prevCardIds.size &&
    [...currentCardIds].every((id) => prevCardIds.has(id))
  ) {
    prevCardIds = currentCardIds;
    return;
  }

  const prevIds = prevCardIds;
  prevCardIds = currentCardIds;

  // cards が空なら layout もクリア
  if (state.cards.length === 0) {
    if (state.layout.size > 0) {
      useCanvasStore.setState({ layout: new Map(), delays: new Map() });
    }
    return;
  }

  // layout が空 → シナリオ A: 初期配置
  if (state.layout.size === 0) {
    const result = buildInitialLayout(state.cards, state.columnCount, state.heights);
    console.log(`[layout] シナリオA: 初期配置 cards=${state.cards.length} layout=${result.grid.size}`);
    useCanvasStore.setState({
      layout: result.grid as Map<string, Placement>,
      delays: new Map(),
    });
    return;
  }

  // 新規カードを検出
  const newCards = state.cards.filter(
    (c) => !prevIds.has(c.slotId) && !state.layout.has(c.slotId),
  );

  if (newCards.length > 0) {
    // シナリオ B: 新規カード挿入（差分）
    console.log(`[layout] シナリオB: 新規${newCards.length}枚挿入 既存layout=${state.layout.size} cards=${state.cards.length}`);
    let grid = state.layout;
    const mergedChainOrder = new Map<string, number>();

    for (const card of newCards) {
      const r = insertCard(grid, card, state.cards, state.columnCount, state.heights, state.holdSet);
      grid = r.grid as Map<string, Placement>;
      for (const [id, order] of r.chain.chainOrder) {
        mergedChainOrder.set(id, order);
      }
    }

    // 削除済みカードを grid から除去
    const cleanGrid = new Map<string, Placement>();
    for (const [id, p] of grid) {
      if (currentCardIds.has(id)) cleanGrid.set(id, p);
    }

    // delayMap 変換
    const delays = new Map<string, number>();
    for (const [id, order] of mergedChainOrder) {
      delays.set(id, order * DOMINO_DELAY);
    }

    console.log(`[layout] シナリオB完了: cleanGrid=${cleanGrid.size} cards=${currentCardIds.size} 差分=${currentCardIds.size - cleanGrid.size}`);
    useCanvasStore.setState({ layout: cleanGrid, delays });
  } else {
    // シナリオ C: カード削除のみ → reflow（列割り当て維持）
    console.log(`[layout] シナリオC: reflow cards=${state.cards.length}`);
    const result = reflow(state.layout, state.cards, state.columnCount, state.heights);

    // 削除済みカードを grid から除去
    const cleanGrid = new Map<string, Placement>();
    for (const [id, p] of result.grid) {
      if (currentCardIds.has(id)) cleanGrid.set(id, p);
    }

    useCanvasStore.setState({ layout: cleanGrid });
    // delayMap は維持（reflow では連鎖なし）
  }
});

export default useCanvasStore;
