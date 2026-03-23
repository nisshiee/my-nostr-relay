/**
 * store/pure/buildCards.ts
 *
 * カード生成の純粋関数群。
 * lib/createNoteCard.ts からの移植（リファクタ）。
 *
 * リファクタ内容:
 * - store の state を引数で受け取るパターンに調整
 * - createNoteCard のパラメータ型はそのまま維持
 * - resolveSlotId も移植（store の publishedSlotMap 連携用）
 */

import { calcFreshnessScore } from "./scoring";
import { OWNER_SCORE_HALF_LIFE, SCORE_HALF_LIFE } from "../../lib/constants";
import type { NoteCard } from "../../lib/types";
import type { Event } from "nostr-tools/core";

interface CreateNoteCardParams {
  /** 元ノートのイベント */
  event: Event;
  /** ログインユーザーのpubkey（オーナー判定用） */
  ownerPubkey: string | null;
  /** スコア計算の基準時刻（Unix timestamp秒）。省略時は現在時刻 */
  now?: number;
  /** slotIdの明示指定。省略時はランダムUUID */
  slotId?: string;
  /** リポスト情報 */
  repostInfo?: {
    reposterPubkey: string;
    repostedAt: number;
  };
}

/**
 * Nostr Event から NoteCard を生成する純粋関数
 *
 * スコア計算にオーナー判定を含む（オーナーの投稿は半減期が長い）。
 */
export function createNoteCard(params: CreateNoteCardParams): NoteCard {
  const { event, ownerPubkey, repostInfo, slotId } = params;
  const now = params.now ?? Math.floor(Date.now() / 1000);
  const halfLife = event.pubkey === ownerPubkey ? OWNER_SCORE_HALF_LIFE : SCORE_HALF_LIFE;
  const scoreTimestamp = repostInfo?.repostedAt ?? event.created_at;

  return {
    type: "note",
    slotId: slotId ?? crypto.randomUUID(),
    eventId: event.id,
    pubkey: event.pubkey,
    content: event.content,
    tags: event.tags,
    created_at: event.created_at,
    score: calcFreshnessScore(scoreTimestamp, now, halfLife),
    fadingOut: false,
    ...(repostInfo ? { repostInfo } : {}),
  };
}

/**
 * slotIdを解決するヘルパー。publishedSlotMapから取得し、なければUUIDを生成。
 */
export function resolveSlotId(
  publishedSlotMap: Map<string, string> | undefined | null,
  eventId: string,
): string {
  return publishedSlotMap?.get(eventId) ?? crypto.randomUUID();
}
