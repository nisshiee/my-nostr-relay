import type { Card } from "./types";
import { COLUMN_WIDTH, GRAVITY_CUTOFF } from "./constants";

/**
 * カード間の引力を返す（0〜1）。
 * MVPでは同一pubkeyなら1、それ以外は0。
 */
export function gravity(cardA: Card, cardB: Card): number {
  return cardA.pubkey === cardB.pubkey ? 1 : 0;
}

/** 2つの配置位置間の距離を計算する（+1でゼロ除算防止） */
export function gravityDistance(
  posA: { col: number; y: number },
  posB: { col: number; y: number },
): number {
  const dx = (posA.col - posB.col) * COLUMN_WIDTH;
  const dy = posA.y - posB.y;
  return Math.sqrt(dx * dx + dy * dy) + 1;
}

/** カードペア間の実効引力（= gravity / distance）を計算する */
export function gravityPull(
  cardA: Card,
  cardB: Card,
  posA: { col: number; y: number },
  posB: { col: number; y: number },
): number {
  // 距離チェックを先に行い、遠いペアはgravity計算をスキップ
  const dist = gravityDistance(posA, posB);
  if (dist > GRAVITY_CUTOFF) return 0;
  const g = gravity(cardA, cardB);
  if (g === 0) return 0;
  return g / dist;
}

/**
 * ある位置に移動したときのキャンバス全体からの引力コストを計算する。
 * 引力が強いカードが近くにあるほど負の値（＝コストが低い＝良い位置）を返す。
 */
export function gravityCost(
  card: Card,
  targetPos: { col: number; y: number },
  allCards: readonly Card[],
  grid: ReadonlyMap<string, { col: number; y: number }>,
  excludeSlotIds?: ReadonlySet<string>,
): number {
  let cost = 0;
  for (const otherCard of allCards) {
    if (otherCard.slotId === card.slotId) continue;
    if (excludeSlotIds?.has(otherCard.slotId)) continue;
    // 距離チェックを先に行い、遠いカードはgravity計算をスキップ
    const otherPos = grid.get(otherCard.slotId);
    if (!otherPos) continue;
    const dist = gravityDistance(targetPos, otherPos);
    if (dist > GRAVITY_CUTOFF) continue;
    const g = gravity(card, otherCard);
    if (g === 0) continue;
    cost -= g / dist;
  }
  return cost;
}

/** 全カードペアの引力情報を返す（デバッグ可視化用。エンジンと同じ計算を使う） */
export interface GravityPair {
  aSlotId: string;
  bSlotId: string;
  pull: number;
}

export function computeAllGravityPairs(
  cards: readonly Card[],
  grid: ReadonlyMap<string, { col: number; y: number }>,
): GravityPair[] {
  const pairs: GravityPair[] = [];
  for (let i = 0; i < cards.length; i++) {
    const a = cards[i]!;
    const posA = grid.get(a.slotId);
    if (!posA) continue;
    for (let j = i + 1; j < cards.length; j++) {
      const b = cards[j]!;
      const posB = grid.get(b.slotId);
      if (!posB) continue;
      const pull = gravityPull(a, b, posA, posB);
      if (pull === 0) continue;
      pairs.push({ aSlotId: a.slotId, bSlotId: b.slotId, pull });
    }
  }
  return pairs;
}
