/**
 * Canvas Store — zustand ストア（全 slice 統合）
 *
 * 各 slice の実装は store/slices/ 以下。
 * ここでは zustand create() で全 slice を統合する。
 */

import { create } from "zustand";
import type { CanvasStore } from "./types";
import { createConnectionSlice } from "./slices/connection";
import { createProfilesSlice } from "./slices/profiles";
import { createCanvasSlice } from "./slices/canvas";
import { createFeedSlice } from "./slices/feed";
import { createThreadsSlice } from "./slices/threads";
import { createReactionsSlice } from "./slices/reactions";
import { createQuotesSlice } from "./slices/quotes";
import { createPublishSlice } from "./slices/publish";

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

export default useCanvasStore;
