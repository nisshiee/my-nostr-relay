import { OWNER_SCORE_HALF_LIFE, SCORE_HALF_LIFE } from "./constants";
import type { Card, CardScoreSource } from "./types";

/**
 * 新しさスコアを計算する（指数関数的減衰）
 * @param createdAt ノートの作成時刻（Unix timestamp、秒）
 * @param now 現在時刻（Unix timestamp、秒）
 * @param halfLife 半減期（秒）。デフォルトは SCORE_HALF_LIFE
 * @returns 0〜1のスコア値
 */
export function calcFreshnessScore(createdAt: number, now: number, halfLife: number = SCORE_HALF_LIFE): number {
  const age = now - createdAt;
  if (age <= 0) return 1;
  return Math.pow(0.5, age / halfLife);
}

/**
 * ノート配列をスコア降順でソートする（破壊的ではない新しい配列を返す）
 */
export function sortByScore<T extends { score: number }>(notes: T[]): T[] {
  return [...notes].sort((a, b) => b.score - a.score);
}

/** 投稿・下書き・集約カードを同じ投稿単位の規則で採点する。 */
export function calculateCardScore(
  card: CardScoreSource & { scoreSources?: readonly CardScoreSource[] },
  ownerPubkey: string | null,
  now: number,
): number {
  return (card.scoreSources ?? [card]).reduce((best, source) => {
    const halfLife = source.pubkey === ownerPubkey ? OWNER_SCORE_HALF_LIFE : SCORE_HALF_LIFE;
    return Math.max(best, calcFreshnessScore(source.repostInfo?.repostedAt ?? source.created_at, now, halfLife));
  }, 0);
}

/** 全候補を同じ時計で採点し、同点時の順序を保って返す。 */
export function scoreCards<T extends Card>(cards: readonly T[], ownerPubkey: string | null, now: number): T[] {
  return sortByScore(cards.map(card => ({ ...card, score: calculateCardScore(card, ownerPubkey, now) })));
}
