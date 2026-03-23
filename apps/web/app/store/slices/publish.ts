/**
 * store/slices/publish.ts
 *
 * NIP-07 署名 → リレー配信、リアクション送信。
 * hooks/useNostrRelay.ts の publishEvent / sendReaction から移植。
 */

import type { Event } from "nostr-tools/core";
import type { StateCreator } from "zustand";
import type { CanvasStore, ReactionEntry } from "../types";
import type { NostrEvent } from "../../types/nostr";

// ---------------------------------------------------------------------------
// Slice 型
// ---------------------------------------------------------------------------

export interface PublishSlice {
  // actions
  publishEvent: (event: Event, slotId?: string) => Promise<void>;
  sendReaction: (
    targetEventId: string,
    targetPubkey: string,
    emoji: string,
    imageUrl?: string,
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// 内部: slotId → eventId マッピング
// ---------------------------------------------------------------------------

/**
 * publishedSlotMap: ComposeCard の一時 slotId を実際の eventId に紐付ける。
 * hook 版では useRef<Map> だったが、store 版ではモジュールスコープの Map として管理。
 * （state に入れると不要な再レンダリングが発生するため）
 */
const publishedSlotMap = new Map<string, string>();

/** slotId → eventId のマッピングを取得する（外部から参照用） */
export function getPublishedSlotMap(): ReadonlyMap<string, string> {
  return publishedSlotMap;
}

// ---------------------------------------------------------------------------
// Slice 実装
// ---------------------------------------------------------------------------

export const createPublishSlice: StateCreator<
  CanvasStore,
  [],
  [],
  PublishSlice
> = (set, get) => ({
  // --- actions ---

  /**
   * 署名済みイベントを全リレーに publish する。
   *
   * - pool / relayUrls が未設定なら例外
   * - 1つ以上のリレーに成功すれば OK（Promise.allSettled）
   * - slotId が指定されていれば publishedSlotMap に登録
   *
   * @param event  署名済みの Nostr イベント
   * @param slotId ComposeCard の一時識別子（任意）
   */
  publishEvent: async (event: Event, slotId?: string) => {
    const { _pool, relayUrls } = get();

    if (!_pool || relayUrls.length === 0) {
      throw new Error("リレーに接続されていません");
    }

    // pool.publish は各リレーへの Promise 配列を返す
    const results = await Promise.allSettled(
      _pool.publish(relayUrls, event),
    );

    const hasSuccess = results.some((r) => r.status === "fulfilled");
    if (!hasSuccess) {
      throw new Error("すべてのリレーへの送信に失敗しました");
    }

    // slotId → eventId マッピングを記録
    if (slotId && event.id) {
      publishedSlotMap.set(slotId, event.id);
    }

    // events キャッシュにも追加（自分の投稿を即座に参照可能にする）
    if (event.id) {
      const currentEvents = get().events;
      if (!currentEvents.has(event.id)) {
        const nextEvents = new Map(currentEvents);
        nextEvents.set(event.id, event);
        set({ events: nextEvents });
      }
    }
  },

  /**
   * NIP-25 準拠のリアクション（kind:7）を構築・署名・送信し、
   * 楽観的に reactions state を更新する。
   *
   * @param targetEventId  リアクション対象のイベント ID
   * @param targetPubkey   リアクション対象のイベント作成者 pubkey
   * @param emoji          リアクション文字列（"+" / カスタム絵文字 ":shortcode:" 等）
   * @param imageUrl       カスタム絵文字の画像 URL（emoji タグ用）
   */
  sendReaction: async (
    targetEventId: string,
    targetPubkey: string,
    emoji: string,
    imageUrl?: string,
  ) => {
    // NIP-07 拡張の存在チェック
    const nostrExt = window.nostr;
    if (!nostrExt) {
      throw new Error("NIP-07拡張（window.nostr）が見つかりません");
    }

    // NIP-25 準拠の kind:7 イベントを構築
    const tags: string[][] = [
      ["e", targetEventId, "", targetPubkey],
      ["p", targetPubkey],
      ["k", "1"],
    ];

    // カスタム絵文字（:shortcode: 形式）の場合は emoji タグを追加
    let content = emoji;
    if (
      emoji.startsWith(":") &&
      emoji.endsWith(":") &&
      emoji.length > 2 &&
      imageUrl
    ) {
      const shortcode = emoji.slice(1, -1);
      tags.push(["emoji", shortcode, imageUrl]);
      content = emoji;
    }

    const unsignedEvent: NostrEvent = {
      kind: 7,
      content,
      tags,
      created_at: Math.floor(Date.now() / 1000),
    };

    // NIP-07 拡張で署名
    const signedEvent = await nostrExt.signEvent(unsignedEvent);

    // リレーに送信（publishEvent を再利用）
    await get().publishEvent(signedEvent as unknown as Event);

    // 楽観的にローカルの reactions state を更新
    const currentReactions = get().reactions;
    const nextReactions = new Map(currentReactions);

    const eventReactions =
      nextReactions.get(targetEventId) ?? new Map<string, ReactionEntry>();
    const nextEventReactions = new Map(eventReactions);

    const existing = nextEventReactions.get(emoji);
    if (existing) {
      const nextPubkeys = new Set(existing.pubkeys);
      nextPubkeys.add(signedEvent.pubkey);
      nextEventReactions.set(emoji, {
        count: existing.count + 1,
        imageUrl: existing.imageUrl ?? imageUrl,
        pubkeys: nextPubkeys,
      });
    } else {
      nextEventReactions.set(emoji, {
        count: 1,
        imageUrl,
        pubkeys: new Set([signedEvent.pubkey]),
      });
    }

    nextReactions.set(targetEventId, nextEventReactions);
    set({ reactions: nextReactions });
  },
});
