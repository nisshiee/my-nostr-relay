import { calcFreshnessScore } from "./scoring";
import { OWNER_SCORE_HALF_LIFE, SCORE_HALF_LIFE } from "./constants";
import type { NoteCard } from "./types";
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

export function createNoteCard(params: CreateNoteCardParams): NoteCard {
  const { event, ownerPubkey, repostInfo, slotId } = params;
  const now = params.now ?? Math.floor(Date.now() / 1000);
  const halfLife = event.pubkey === ownerPubkey ? OWNER_SCORE_HALF_LIFE : SCORE_HALF_LIFE;
  const scoreTimestamp = repostInfo?.repostedAt ?? event.created_at;

  return {
    type: "note",
    slotId: slotId ?? crypto.randomUUID(),
    eventId: event.id,
    sig: event.sig,
    pubkey: event.pubkey,
    content: event.content,
    tags: event.tags,
    created_at: event.created_at,
    score: calcFreshnessScore(scoreTimestamp, now, halfLife),
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
