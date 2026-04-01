import { describe, test, expect } from "vitest";
import { gravity, gravityCost, gravityPull, gravityDistance, computeAllGravityPairs } from "../gravity";
import type { Card, NoteCard } from "../types";

/** テスト用のNoteCardを生成するヘルパー */
function makeCard(slotId: string, pubkey: string): NoteCard {
  return {
    type: "note",
    slotId,
    pubkey,
    score: 0,
    created_at: 0,
    eventId: slotId,
    content: "",
    tags: [],
  };
}

describe("gravity", () => {
  test("同一pubkeyなら1を返す", () => {
    const a = makeCard("a", "pk1");
    const b = makeCard("b", "pk1");
    expect(gravity(a, b)).toBe(1);
  });

  test("異なるpubkeyなら0を返す", () => {
    const a = makeCard("a", "pk1");
    const b = makeCard("b", "pk2");
    expect(gravity(a, b)).toBe(0);
  });
});

describe("gravityCost", () => {
  test("関連カードが近い位置にあるほどコストが低い（負の値が大きい）", () => {
    const card = makeCard("target", "pk1");
    const nearby = makeCard("near", "pk1");
    const faraway = makeCard("far", "pk1");

    const allCards: Card[] = [card, nearby, faraway];
    const grid = new Map<string, { col: number; y: number }>([
      ["near", { col: 1, y: 100 }],
      ["far", { col: 5, y: 500 }],
    ]);

    // 近い位置に置いた場合のコスト
    const costNear = gravityCost(card, { col: 1, y: 100 }, allCards, grid);
    // 遠い位置に置いた場合のコスト
    const costFar = gravityCost(card, { col: 10, y: 1000 }, allCards, grid);

    // 近い位置のほうが負の値が大きい（コストが低い）
    expect(costNear).toBeLessThan(costFar);
  });

  test("関連カードがいない場合は0を返す", () => {
    const card = makeCard("target", "pk1");
    const unrelated = makeCard("other", "pk2");

    const allCards: Card[] = [card, unrelated];
    const grid = new Map<string, { col: number; y: number }>([
      ["other", { col: 0, y: 0 }],
    ]);

    const cost = gravityCost(card, { col: 0, y: 0 }, allCards, grid);
    expect(cost).toBe(0);
  });
});

describe("gravityPull", () => {
  test("同一pubkeyのカード間でpull > 0を返す", () => {
    const a = makeCard("a", "pk1");
    const b = makeCard("b", "pk1");
    const pull = gravityPull(a, b, { col: 0, y: 0 }, { col: 0, y: 100 });
    expect(pull).toBeGreaterThan(0);
  });

  test("異なるpubkeyのカード間で0を返す", () => {
    const a = makeCard("a", "pk1");
    const b = makeCard("b", "pk2");
    const pull = gravityPull(a, b, { col: 0, y: 0 }, { col: 0, y: 100 });
    expect(pull).toBe(0);
  });

  test("近いほどpullが大きい", () => {
    const a = makeCard("a", "pk1");
    const b = makeCard("b", "pk1");
    const pullNear = gravityPull(a, b, { col: 0, y: 0 }, { col: 0, y: 50 });
    const pullFar = gravityPull(a, b, { col: 0, y: 0 }, { col: 0, y: 500 });
    expect(pullNear).toBeGreaterThan(pullFar);
  });
});

describe("gravityDistance", () => {
  test("同じ位置で距離1（ゼロ除算防止の+1）", () => {
    expect(gravityDistance({ col: 0, y: 0 }, { col: 0, y: 0 })).toBe(1);
  });
});

describe("computeAllGravityPairs", () => {
  test("関連ペアのみを返す", () => {
    const a = makeCard("a", "pk1");
    const b = makeCard("b", "pk1");
    const c = makeCard("c", "pk2");
    const grid = new Map([
      ["a", { col: 0, y: 0 }],
      ["b", { col: 0, y: 100 }],
      ["c", { col: 1, y: 0 }],
    ]);
    const pairs = computeAllGravityPairs([a, b, c], grid);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.aSlotId).toBe("a");
    expect(pairs[0]!.bSlotId).toBe("b");
    expect(pairs[0]!.pull).toBeGreaterThan(0);
  });

  test("gravityCostと一貫した値を返す", () => {
    const a = makeCard("a", "pk1");
    const b = makeCard("b", "pk1");
    const grid = new Map([
      ["a", { col: 0, y: 0 }],
      ["b", { col: 1, y: 200 }],
    ]);
    const pairs = computeAllGravityPairs([a, b], grid);
    // gravityCostはpullの合計の負値なので、ペアが1つなら -pull = cost
    const cost = gravityCost(a, { col: 0, y: 0 }, [a, b], grid);
    expect(-cost).toBeCloseTo(pairs[0]!.pull, 10);
  });
});
