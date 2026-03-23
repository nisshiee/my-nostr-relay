/**
 * store/slices/quotes.ts
 *
 * 引用先イベント（+ プロフィール）の取得・キャッシュ。
 * hooks/useQuotedEvent.ts からの移植。
 *
 * useQuotedEvent は React hook として URI デコード・キャッシュ参照・fetch を
 * 一体化していたが、store 版では fetchQuoted アクションのみを提供し、
 * URI デコードはコンポーネント側（or selector）で行う設計。
 */

import type { Event } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import type { StateCreator } from "zustand";
import type { CanvasStore } from "../types";
import { BOOTSTRAP_EOSE_TIMEOUT } from "../../lib/constants";

// ---------------------------------------------------------------------------
// Slice 型
// ---------------------------------------------------------------------------

export interface QuotesSlice {
  // actions
  fetchQuoted: (
    eventId: string,
    relayHints?: string[],
  ) => Promise<Event | null>;
}

// ---------------------------------------------------------------------------
// Slice 実装
// ---------------------------------------------------------------------------

export const createQuotesSlice: StateCreator<
  CanvasStore,
  [],
  [],
  QuotesSlice
> = (set, get) => ({
  // --- actions ---

  /**
   * 引用先イベントを取得し、events キャッシュに保存する。
   * 該当 pubkey のプロフィールも ensureProfiles で取得する。
   *
   * - 既に events Map にキャッシュ済みならそれを返す
   * - _inflight で重複フェッチを排除（eventId ベース）
   * - relayHints があれば優先リレーとして使う
   *
   * @param eventId    取得対象の Nostr イベント ID
   * @param relayHints nevent に含まれるリレーヒント URL 配列
   * @returns 取得したイベント、見つからなければ null
   */
  fetchQuoted: async (
    eventId: string,
    relayHints?: string[],
  ): Promise<Event | null> => {
    const { _pool, relayUrls, events, _inflight } = get();

    // キャッシュヒット
    const cached = events.get(eventId);
    if (cached) return cached;

    // pool / relayUrls が未設定なら何もしない
    if (!_pool || relayUrls.length === 0) return null;

    // 重複フェッチ排除（_inflight に eventId が含まれていればスキップ）
    // ただし結果を待つ仕組みがないため、inflight 中は null を返す
    // （コンポーネント側でリトライ or subscribe で再取得する想定）
    const inflightKey = `quote:${eventId}`;
    if (_inflight.has(inflightKey)) return null;

    // _inflight に追加
    const nextInflight = new Set(_inflight);
    nextInflight.add(inflightKey);
    set({ _inflight: nextInflight });

    try {
      // リレーヒントがあれば優先的に使い、通常のリレーも含める
      const hints = relayHints ?? [];
      const targetRelays = [...new Set([...hints, ...relayUrls])];

      // イベントをフェッチ
      const fetchedEvents = await _pool.querySync(
        targetRelays,
        { ids: [eventId] } as Filter,
        { maxWait: BOOTSTRAP_EOSE_TIMEOUT },
      );

      if (fetchedEvents.length === 0) {
        // _inflight からクリーンアップ
        const updatedInflight = new Set(get()._inflight);
        updatedInflight.delete(inflightKey);
        set({ _inflight: updatedInflight });
        return null;
      }

      const event = fetchedEvents[0]!;

      // events キャッシュに保存
      const currentEvents = get().events;
      const nextEvents = new Map(currentEvents);
      nextEvents.set(eventId, event);
      set({ events: nextEvents });

      // プロフィールも取得（非同期、失敗しても event は返す）
      get().ensureProfiles([event.pubkey]);

      // _inflight からクリーンアップ
      const updatedInflight = new Set(get()._inflight);
      updatedInflight.delete(inflightKey);
      set({ _inflight: updatedInflight });

      return event;
    } catch {
      // エラー時は _inflight のみクリーンアップ
      const updatedInflight = new Set(get()._inflight);
      updatedInflight.delete(inflightKey);
      set({ _inflight: updatedInflight });
      return null;
    }
  },
});
