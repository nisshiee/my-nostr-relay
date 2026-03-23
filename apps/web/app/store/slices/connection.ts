/**
 * store/slices/connection.ts
 *
 * SimplePool 接続管理、リレーリスト解決（kind:10002）、フォローリスト取得（kind:3）。
 * hooks/useNostrConnection.ts からの移植。
 */

import { SimplePool } from "nostr-tools/pool";
import type { Event } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import type { StateCreator } from "zustand";
import type { CanvasStore, Phase } from "../types";
import {
  BOOTSTRAP_RELAYS,
  BOOTSTRAP_EOSE_TIMEOUT,
  MAX_WAIT_FOR_CONNECTION,
} from "../../lib/constants";

// ---------------------------------------------------------------------------
// Slice 型（ConnectionSlice が提供する state + actions）
// ---------------------------------------------------------------------------

export interface ConnectionSlice {
  // state
  phase: Phase;
  relayUrls: string[];
  followPubkeys: string[];
  pubkey: string | null;
  _pool: SimplePool | null;

  // actions
  connect: (pubkey: string) => Promise<void>;
  disconnect: () => void;
}

// ---------------------------------------------------------------------------
// Slice 実装
// ---------------------------------------------------------------------------

export const createConnectionSlice: StateCreator<
  CanvasStore,
  [],
  [],
  ConnectionSlice
> = (set, get) => ({
  // --- initial state ---
  phase: "connecting",
  relayUrls: [],
  followPubkeys: [],
  pubkey: null,
  _pool: null,

  // --- actions ---

  /**
   * SimplePool を作成し、kind:10002（リレーリスト）と kind:3（フォローリスト）を取得。
   * relayUrls / followPubkeys を確定した後、phase を "loading" にする。
   *
   * 連鎖: connect → (caller が subscribeFeed を呼ぶ)
   */
  connect: async (pubkey: string) => {
    set({ phase: "connecting", pubkey });

    try {
      // 既存の pool があれば破棄
      const oldPool = get()._pool;
      if (oldPool) {
        try {
          oldPool.destroy();
        } catch {
          // already closed
        }
      }

      // SimplePool 作成
      const pool = new SimplePool({
        enableReconnect: true,
        enablePing: true,
      });
      pool.maxWaitForConnection = MAX_WAIT_FOR_CONNECTION;

      set({ _pool: pool });

      // kind:10002（リレーリスト）+ kind:3（フォローリスト）を1リクエストで取得
      const bootstrapEvents = await pool.querySync(
        BOOTSTRAP_RELAYS,
        { kinds: [10002, 3], authors: [pubkey], limit: 2 } as Filter,
        { maxWait: BOOTSTRAP_EOSE_TIMEOUT },
      );

      // 最新の kind:10002 イベントを取得
      const relayListEvent = bootstrapEvents
        .filter((e: Event) => e.kind === 10002)
        .reduce<Event | null>(
          (a, b) => (!a || b.created_at > a.created_at ? b : a),
          null,
        );

      // "r" タグからリレー URL を抽出
      const resolvedRelayUrls = relayListEvent
        ? relayListEvent.tags
            .filter((tag) => tag[0] === "r" && tag[1])
            .map((tag) => tag[1]!)
        : [];

      // 最新の kind:3 イベントを取得
      const contactEvent = bootstrapEvents
        .filter((e: Event) => e.kind === 3)
        .reduce<Event | null>(
          (a, b) => (!a || b.created_at > a.created_at ? b : a),
          null,
        );

      // "p" タグからフォロー中の pubkey を抽出
      const resolvedFollowPubkeys = contactEvent
        ? contactEvent.tags
            .filter((tag) => tag[0] === "p" && tag[1])
            .map((tag) => tag[1]!)
        : [];

      if (resolvedFollowPubkeys.length === 0) {
        // フォローリストが空 → loading にはするが feed subscribe はスキップされる
        set({ phase: "loading", relayUrls: [...BOOTSTRAP_RELAYS], followPubkeys: [] });
        return;
      }

      // リレーリスト決定: kind:10002 から取得 or BOOTSTRAP_RELAYS フォールバック
      const allRelays =
        resolvedRelayUrls.length > 0
          ? [...new Set([...BOOTSTRAP_RELAYS, ...resolvedRelayUrls])]
          : [...BOOTSTRAP_RELAYS];

      set({
        relayUrls: allRelays,
        followPubkeys: resolvedFollowPubkeys,
        phase: "loading",
      });

      // --- 連鎖: subscribeFeed → (onEose) → subscribeReactions ---
      // プロフィール購読も開始
      get().subscribeProfiles();
      get().subscribeFeed();
    } catch {
      set({ phase: "error" });
    }
  },

  /**
   * 全購読を閉じ、pool を破棄し、接続関連 state をリセットする。
   */
  disconnect: () => {
    const { _pool, _feedSub, _reactionSub } = get();

    // 購読を閉じる
    if (_feedSub) {
      try {
        _feedSub.close();
      } catch {
        // already closed
      }
    }
    if (_reactionSub) {
      try {
        _reactionSub.close();
      } catch {
        // already closed
      }
    }

    // pool を破棄
    if (_pool) {
      try {
        _pool.destroy();
      } catch {
        // already closed
      }
    }

    set({
      phase: "connecting",
      relayUrls: [],
      followPubkeys: [],
      pubkey: null,
      _pool: null,
      _feedSub: null,
      _reactionSub: null,
      _inflight: new Set(),

      // データキャッシュもクリア
      events: new Map(),
      profiles: new Map(),
      reactions: new Map(),
      repostMeta: new Map(),
      timelineIds: [],
      threadGroups: new Map(),
      cards: [],
      layout: new Map(),
      heights: new Map(),
      delays: new Map(),
      holdSet: new Set(),
    });
  },
});
