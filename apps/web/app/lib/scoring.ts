import { SCORE_HALF_LIFE } from "./constants";

/**
 * 新しさスコアを計算する（指数関数的減衰）
 * @param createdAt ノートの作成時刻（Unix timestamp、秒）
 * @param now 現在時刻（Unix timestamp、秒）
 * @returns 0〜1のスコア値
 */
export function calcFreshnessScore(createdAt: number, now: number): number {
  const age = now - createdAt;
  if (age <= 0) return 1;
  return Math.pow(0.5, age / SCORE_HALF_LIFE);
}

/**
 * ノート配列をスコア降順でソートする（破壊的ではない新しい配列を返す）
 */
export function sortByScore<T extends { score: number }>(notes: T[]): T[] {
  return [...notes].sort((a, b) => b.score - a.score);
}
