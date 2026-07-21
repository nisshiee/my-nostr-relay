import { describe, expect, it } from "vitest";
import type { Event } from "nostr-tools/core";
import { aggregateReactionEvent, reactionKey } from "../reactions";
import type { Reactions } from "../types";

function event(id: string, pubkey: string, content: string, tags: string[][]): Event {
  return { id, pubkey, content, tags, kind: 7, created_at: 1, sig: "sig" };
}

function aggregate(...events: Event[]): Reactions {
  return events.reduce(aggregateReactionEvent, new Map() as Reactions);
}

describe("reaction aggregation", () => {
  it("同じshortcodeでも画像URLが異なるカスタム絵文字は別集計にする", () => {
    const reactions = aggregate(
      event("1", "alice", ":party:", [["e", "note"], ["emoji", "party", "https://a.example/party.png"]]),
      event("2", "bob", ":party:", [["e", "note"], ["emoji", "party", "https://b.example/party.png"]]),
    ).get("note")!;

    expect(reactions).toHaveLength(2);
    expect(reactions.get(reactionKey(":party:", "https://a.example/party.png"))).toMatchObject({
      emoji: ":party:", count: 1, imageUrl: "https://a.example/party.png",
    });
    expect(reactions.get(reactionKey(":party:", "https://b.example/party.png"))).toMatchObject({
      emoji: ":party:", count: 1, imageUrl: "https://b.example/party.png",
    });
  });

  it("shortcodeと画像URLが同じカスタム絵文字だけをまとめる", () => {
    const reactions = aggregate(
      event("1", "alice", ":party:", [["e", "note"], ["emoji", "party", "https://example.com/party.png"]]),
      event("2", "bob", ":party:", [["e", "note"], ["emoji", "party", "https://example.com/party.png"]]),
    ).get("note")!;

    const summary = reactions.get(reactionKey(":party:", "https://example.com/party.png"));
    expect(reactions).toHaveLength(1);
    expect(summary?.count).toBe(2);
    expect(summary?.pubkeys).toEqual(new Set(["alice", "bob"]));
  });

  it("通常絵文字と正規化された + は従来どおり絵文字単位でまとめる", () => {
    const reactions = aggregate(
      event("1", "alice", "+", [["e", "note"]]),
      event("2", "bob", "👍", [["e", "note"], ["emoji", "irrelevant", "https://example.com/x.png"]]),
    ).get("note")!;

    expect(reactions).toHaveLength(1);
    expect(reactions.get(reactionKey("👍"))?.count).toBe(2);
  });

  it("複合キーの境界が曖昧にならず衝突しない", () => {
    expect(reactionKey(":a:", "b|c")).not.toBe(reactionKey(":a:", "b",));
    expect(reactionKey(":a:", "b|c")).not.toBe(reactionKey("b|c"));
  });
});
