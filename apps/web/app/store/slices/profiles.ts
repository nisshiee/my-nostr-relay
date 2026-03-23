/**
 * store/slices/profiles.ts
 *
 * kind:0 プロフィール取得・キャッシュ管理。
 * hooks/useNostrProfiles.ts からの移植。
 */

import type { Event } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import type { StateCreator } from "zustand";
import type { CanvasStore } from "../types";
import type { NostrProfile } from "../../lib/types";
import { BOOTSTRAP_EOSE_TIMEOUT } from "../../lib/constants";

// ---------------------------------------------------------------------------
// Slice 型
// ---------------------------------------------------------------------------

export interface ProfilesSlice {
  // state
  profiles: Map<string, NostrProfile>;
  _inflight: Set<string>;

  // actions
  ensureProfiles: (pubkeys: string[]) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Slice 実装
// ---------------------------------------------------------------------------

export const createProfilesSlice: StateCreator<
  CanvasStore,
  [],
  [],
  ProfilesSlice
> = (set, get) => ({
  // --- initial state ---
  profiles: new Map(),
  _inflight: new Set(),

  // --- actions ---

  /**
   * 不足しているプロフィールを一括取得する。
   *
   * - 既にキャッシュ済み、または取得中（_inflight）の pubkey はスキップ
   * - pool / relayUrls が未設定の場合は何もしない
   */
  ensureProfiles: async (pubkeys: string[]) => {
    const { _pool, relayUrls, profiles, _inflight } = get();
    if (!_pool || relayUrls.length === 0 || pubkeys.length === 0) return;

    // 未取得かつ未リクエストの pubkey のみフィルタ
    const unknownPubkeys = pubkeys.filter(
      (pk) => !profiles.has(pk) && !_inflight.has(pk),
    );
    if (unknownPubkeys.length === 0) return;

    // _inflight に追加（重複リクエスト防止）
    const nextInflight = new Set(_inflight);
    for (const pk of unknownPubkeys) {
      nextInflight.add(pk);
    }
    set({ _inflight: nextInflight });

    try {
      const profileEvents = await _pool.querySync(
        relayUrls,
        { kinds: [0], authors: unknownPubkeys } as Filter,
        { maxWait: BOOTSTRAP_EOSE_TIMEOUT },
      );

      // 取得したプロフィールを upsert
      const currentProfiles = get().profiles;
      const nextProfiles = new Map(currentProfiles);

      for (const event of profileEvents) {
        try {
          const data = JSON.parse(event.content) as NostrProfile;
          nextProfiles.set(event.pubkey, data);
        } catch {
          // JSON パース失敗は無視
        }
      }

      // _inflight から除去
      const updatedInflight = new Set(get()._inflight);
      for (const pk of unknownPubkeys) {
        updatedInflight.delete(pk);
      }

      set({ profiles: nextProfiles, _inflight: updatedInflight });
    } catch {
      // プロフィール取得失敗は無視、_inflight のみクリーンアップ
      const updatedInflight = new Set(get()._inflight);
      for (const pk of unknownPubkeys) {
        updatedInflight.delete(pk);
      }
      set({ _inflight: updatedInflight });
    }
  },
});
