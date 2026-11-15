import { describe, expect, it } from "vitest";
import { reconcileCardSources } from "../cardSources";
import { calculateCardScore, scoreCards } from "../scoring";
import type { Card, CardScoreSource } from "../types";

const NOW = 10_000;
const source = (pubkey: string, age: number): CardScoreSource => ({ pubkey, created_at: NOW - age });
describe("カード形式に依存しない保持元と採点", () => {
  it("単独・集約とも保持元0件なら除去し、祖先文脈は採点根拠にしない", () => {
    const sources = new Map([["current", source("other", 1800)]]);
    const retained = reconcileCardSources([
      { card: { id: "single" }, sourceIds: ["current"] },
      { card: { id: "group" }, sourceIds: ["ancestor", "current", "current"] },
      { card: { id: "old-single" }, sourceIds: ["evicted"] },
      { card: { id: "old-group" }, sourceIds: ["ancestor", "evicted"] },
    ], sources);
    expect(retained.map(card => card.id)).toEqual(["single", "group"]);
    expect(retained[0].scoreSources).toEqual(retained[1].scoreSources);
    expect(retained[1].scoreSources).toHaveLength(1);
  });
  it("本人の半減期は本人の投稿時刻にだけ適用し、件数では増幅しない", () => {
    const reply = source("other", 1800); const owner = source("owner", 7200);
    const group = { ...reply, scoreSources: [owner, reply] };
    expect(calculateCardScore(group, "owner", NOW)).toBe(0.5);
    expect(calculateCardScore({ ...reply, scoreSources: Array(68).fill(reply) }, "owner", NOW)).toBe(0.5);
    expect(calculateCardScore({ ...reply, scoreSources: [] }, "owner", NOW)).toBe(0);
  });
  it("通常投稿と集約元に同じリポスト時刻・本人判定を適用する", () => {
    const repost = { ...source("other", 7200), repostInfo: { reposterPubkey: "owner", repostedAt: NOW - 1800 } };
    expect(calculateCardScore(repost, "owner", NOW)).toBe(0.5);
    expect(calculateCardScore({ ...source("owner", 0), scoreSources: [repost] }, "owner", NOW)).toBe(0.5);
  });
  it("下書き・単独・集約を同じ時計で採点し、同点の順序を保つ", () => {
    const activity = source("owner", 3600);
    const cards: Card[] = [
      { ...activity, type: "compose", slotId: "draft", score: 99 },
      { ...activity, type: "note", slotId: "note", score: 99, eventId: "note", content: "", tags: [] },
      { ...activity, type: "thread", slotId: "group", score: 99, scoreSources: [activity], notes: [], eventIds: new Set() },
    ];
    expect(scoreCards(cards, "owner", NOW).map(card => [card.slotId, card.score])).toEqual([["draft", .5], ["note", .5], ["group", .5]]);
    expect(cards.every(card => card.score === 99)).toBe(true);
  });
});
