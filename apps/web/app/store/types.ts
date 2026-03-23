/**
 * Canvas Store — 型定義
 *
 * REFACTOR_DESIGN.md の CanvasStoreState / CanvasStoreActions を元に定義。
 * 既存の lib/types.ts, lib/layoutTypes.ts の型を再利用する。
 */

import type { Event } from "nostr-tools/core";
import type { SimplePool } from "nostr-tools/pool";
import type { SubCloser } from "nostr-tools/abstract-pool";
import type { Card, NostrProfile } from "../lib/types";
import type { Placement } from "../lib/layoutTypes";

// ---------------------------------------------------------------------------
// 補助型
// ---------------------------------------------------------------------------

/** サブスクリプション解除関数 */
export type Unsubscribe = () => void;

/** リアクション1件の集計情報（絵文字キーごと） */
export interface ReactionEntry {
  count: number;
  imageUrl?: string;
  /** リアクション送信者の pubkey 集合 */
  pubkeys: Set<string>;
}

/**
 * リポストメタ情報。
 * eventId → 「誰が最後にリポストしたか」を管理する。
 */
export interface RepostMeta {
  /** 最後にリポストした人の pubkey */
  reposterPubkey: string;
  /** 最終リポスト時刻（Unix timestamp、秒） */
  repostedAt: number;
}

/** 接続フェーズ */
export type Phase = "connecting" | "loading" | "ready" | "error";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface CanvasStoreState {
  // --- 接続 ---
  phase: Phase;
  relayUrls: string[];
  followPubkeys: string[];
  pubkey: string | null;

  // --- Nostr データキャッシュ ---
  events: Map<string, Event>;
  profiles: Map<string, NostrProfile>;
  /** eventId → (emoji → ReactionEntry) */
  reactions: Map<string, Map<string, ReactionEntry>>;
  /** eventId → リポスト情報 */
  repostMeta: Map<string, RepostMeta>;

  // --- Canvas ドメイン ---
  /** タイムラインに並ぶ eventId（挿入順） */
  timelineIds: string[];
  /** rootEventId → [eventId, ...] */
  threadGroups: Map<string, string[]>;
  /** 最終的なカード配列（ソート済み） */
  cards: Card[];
  /** slotId → 配置位置 */
  layout: Map<string, Placement>;
  /** slotId → DOM 測定高さ */
  heights: Map<string, number>;
  /** slotId → アニメーション遅延 */
  delays: Map<string, number>;
  columnCount: number;
  holdSet: Set<string>;

  // --- 内部変数（selector から使わないこと） ---
  /** @internal SimplePool インスタンス。コンポーネントから直接参照しない */
  _pool: SimplePool | null;
  /** @internal フィード購読の SubCloser */
  _feedSub: SubCloser | null;
  /** @internal リアクション購読の SubCloser */
  _reactionSub: SubCloser | null;
  /** @internal 進行中の非同期リクエスト追跡用 Set */
  _inflight: Set<string>;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface CanvasStoreActions {
  // --- Nostr 接続・購読（副作用あり） ---

  /** pool を作成し kind:10002/3 を取得、relayUrls/followPubkeys を確定 → subscribeFeed() を呼ぶ */
  connect: (pubkey: string) => Promise<void>;
  /** kind:1/6 の subscribe を開始する */
  subscribeFeed: () => Unsubscribe;
  /** kind:7 の subscribe を開始する（定期 re-subscribe 含む） */
  subscribeReactions: (eventIds: string[]) => Unsubscribe;
  /** kind:6 リポストイベントから元ノートを解決する */
  resolveRepost: (repostEvent: Event) => Promise<void>;
  /** 複数リポストイベントを一括解決 */
  resolveReposts: (repostEvents: Event[]) => Promise<void>;
  /** スレッド祖先ノートを取得する */
  fetchAncestors: (eventIds: string[]) => Promise<void>;
  /** 不足しているプロフィールを一括取得する */
  ensureProfiles: (pubkeys: string[]) => Promise<void>;
  /** 引用先イベント（+ プロフィール）を取得する */
  fetchQuoted: (
    eventId: string,
    relayHints?: string[],
  ) => Promise<Event | null>;
  /** NIP-07 署名済みイベントをリレーに送信する */
  publishEvent: (event: Event, slotId?: string) => Promise<void>;
  /** リアクション（kind:7）を送信する */
  sendReaction: (
    targetEventId: string,
    targetPubkey: string,
    emoji: string,
    imageUrl?: string,
  ) => Promise<void>;

  // --- Canvas 操作（同期、set のみ） ---

  /** カードの DOM 測定高さを記録し、レイアウトを再計算する */
  setHeight: (slotId: string, height: number) => void;
  /** カラム数を変更し、レイアウトを再計算する */
  setColumnCount: (count: number) => void;
  /** カードをホールド状態にする（フェードアウト抑止） */
  holdCard: (slotId: string) => void;
  /** カードのホールドを解除する */
  releaseCard: (slotId: string) => void;
  /** スコア再計算・フェードアウト判定を行う定期 tick */
  tick: (now: number) => void;

  // --- クリーンアップ ---

  /** 全購読を閉じ、pool を破棄する */
  disconnect: () => void;
}

// ---------------------------------------------------------------------------
// Store 統合型
// ---------------------------------------------------------------------------

/** zustand store のフル型（State + Actions） */
export type CanvasStore = CanvasStoreState & CanvasStoreActions;
