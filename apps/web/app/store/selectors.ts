/**
 * store/selectors.ts
 *
 * よく使われるセレクターパターン。
 * コンポーネントから useCanvasStore(selector) で利用する。
 *
 * 使用例:
 *   const profile = useCanvasStore(useProfile(pubkey));
 *   const cards = useCanvasStore(useCards);
 *   const phase = useCanvasStore(usePhase);
 */

import type { CanvasStore, Phase, ReactionEntry } from "./types";
import type { Card, NostrProfile, NoteCard, ThreadCard } from "../lib/types";
import type { Placement } from "../lib/layoutTypes";
import type { Event } from "nostr-tools/core";

// ---------------------------------------------------------------------------
// プロフィール
// ---------------------------------------------------------------------------

/**
 * 指定 pubkey のプロフィールを返すセレクターを生成する。
 * @example const profile = useCanvasStore(useProfile(pubkey));
 */
export const useProfile =
  (pubkey: string) =>
  (state: CanvasStore): NostrProfile | undefined =>
    state.profiles.get(pubkey);

/**
 * 全プロフィール Map を返す。
 */
export const useProfiles = (state: CanvasStore): Map<string, NostrProfile> =>
  state.profiles;

// ---------------------------------------------------------------------------
// リアクション
// ---------------------------------------------------------------------------

/**
 * 指定 eventId のリアクション集計を返すセレクターを生成する。
 * @example const reactions = useCanvasStore(useReactionsFor(eventId));
 */
export const useReactionsFor =
  (eventId: string) =>
  (state: CanvasStore): Map<string, ReactionEntry> | undefined =>
    state.reactions.get(eventId);

/**
 * 全リアクション Map を返す。
 */
export const useAllReactions = (
  state: CanvasStore,
): Map<string, Map<string, ReactionEntry>> => state.reactions;

// ---------------------------------------------------------------------------
// カード
// ---------------------------------------------------------------------------

/**
 * カード配列を返す（ソート済み）。
 */
export const useCards = (state: CanvasStore): Card[] => state.cards;

/**
 * NoteCard のみをフィルタして返す。
 */
export const useNoteCards = (state: CanvasStore): NoteCard[] =>
  state.cards.filter((c): c is NoteCard => c.type === "note");

/**
 * ThreadCard のみをフィルタして返す。
 */
export const useThreadCards = (state: CanvasStore): ThreadCard[] =>
  state.cards.filter((c): c is ThreadCard => c.type === "thread");

// ---------------------------------------------------------------------------
// Canvas 状態
// ---------------------------------------------------------------------------

/**
 * 接続フェーズを返す。
 */
export const usePhase = (state: CanvasStore): Phase => state.phase;

/**
 * カラム数を返す。
 */
export const useColumnCount = (state: CanvasStore): number =>
  state.columnCount;

/**
 * レイアウト Map を返す。
 */
export const useLayout = (state: CanvasStore): Map<string, Placement> =>
  state.layout;

/**
 * 指定 slotId の配置位置を返すセレクターを生成する。
 */
export const usePlacement =
  (slotId: string) =>
  (state: CanvasStore): Placement | undefined =>
    state.layout.get(slotId);

/**
 * 指定 slotId のアニメーション遅延を返すセレクターを生成する。
 */
export const useDelay =
  (slotId: string) =>
  (state: CanvasStore): number =>
    state.delays.get(slotId) ?? 0;

/**
 * 指定 slotId の DOM 測定高さを返すセレクターを生成する。
 */
export const useHeight =
  (slotId: string) =>
  (state: CanvasStore): number | undefined =>
    state.heights.get(slotId);

/**
 * ホールド中の slotId Set を返す。
 */
export const useHoldSet = (state: CanvasStore): Set<string> =>
  state.holdSet;

/**
 * 指定 slotId がホールド中かどうか返すセレクターを生成する。
 */
export const useIsHeld =
  (slotId: string) =>
  (state: CanvasStore): boolean =>
    state.holdSet.has(slotId);

// ---------------------------------------------------------------------------
// 接続情報
// ---------------------------------------------------------------------------

/**
 * 自分の pubkey を返す。
 */
export const usePubkey = (state: CanvasStore): string | null => state.pubkey;

/**
 * リレー URL 配列を返す。
 */
export const useRelayUrls = (state: CanvasStore): string[] => state.relayUrls;

/**
 * フォロー中の pubkey 配列を返す。
 */
export const useFollowPubkeys = (state: CanvasStore): string[] =>
  state.followPubkeys;

// ---------------------------------------------------------------------------
// イベント
// ---------------------------------------------------------------------------

/**
 * 指定 eventId のイベントを返すセレクターを生成する。
 */
export const useEvent =
  (eventId: string) =>
  (state: CanvasStore): Event | undefined =>
    state.events.get(eventId);

/**
 * 全イベント Map を返す。
 */
export const useEvents = (state: CanvasStore): Map<string, Event> =>
  state.events;

// ---------------------------------------------------------------------------
// スレッド
// ---------------------------------------------------------------------------

/**
 * 全スレッドグループ Map を返す。
 */
export const useThreadGroups = (
  state: CanvasStore,
): Map<string, string[]> => state.threadGroups;

// ---------------------------------------------------------------------------
// アクション（便宜上、直接アクセスパターン）
// ---------------------------------------------------------------------------

/**
 * アクション群をまとめて返す。
 *
 * ⚠️ useShallow と組み合わせて使うこと。素の useCanvasStore(useActions) は
 * 毎回新しいオブジェクトを返すため無限再レンダリングを引き起こす。
 *
 * @example
 *   import { useShallow } from "zustand/react/shallow";
 *   const actions = useCanvasStore(useShallow(useActions));
 */
export const useActions = (state: CanvasStore) => ({
  connect: state.connect,
  disconnect: state.disconnect,
  subscribeFeed: state.subscribeFeed,
  subscribeReactions: state.subscribeReactions,
  resolveRepost: state.resolveRepost,
  resolveReposts: state.resolveReposts,
  fetchAncestors: state.fetchAncestors,
  ensureProfiles: state.ensureProfiles,
  fetchQuoted: state.fetchQuoted,
  publishEvent: state.publishEvent,
  sendReaction: state.sendReaction,
  setHeight: state.setHeight,
  setColumnCount: state.setColumnCount,
  holdCard: state.holdCard,
  releaseCard: state.releaseCard,
  tick: state.tick,
});
