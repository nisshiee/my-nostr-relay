/**
 * store/pure/scoring.ts
 *
 * スコア計算の純粋関数群。
 * lib/scoring.ts からの移植（そのまま）。
 */

import { SCORE_HALF_LIFE } from "../../lib/constants";

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
