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
import { buildInitialLayout } from "./pure/layoutEngine";

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
// cards → layout 自動同期
//
// cards 配列の参照が変わったら layout をフルリビルドする。
// setHeight / setColumnCount は canvas slice 側で reflow するので、
// ここでは cards 変更に限定して反応する。
// ---------------------------------------------------------------------------
let prevCards = useCanvasStore.getState().cards;

useCanvasStore.subscribe((state) => {
  if (state.cards === prevCards) return;
  prevCards = state.cards;

  // cards が空なら layout もクリア
  if (state.cards.length === 0) {
    if (state.layout.size > 0) {
      useCanvasStore.setState({ layout: new Map(), delays: new Map() });
    }
    return;
  }

  // フルリビルド
  const result = buildInitialLayout(state.cards, state.columnCount, state.heights);
  useCanvasStore.setState({
    layout: result.grid as Map<string, Placement>,
    delays: new Map(),
  });
});

export default useCanvasStore;
