import { describe, test, expect } from "vitest";
import {
  extractReplyEventIds,
  isReply,
  getDirectReplyTarget,
  eventToThreadNote,
  resolveReplyAuthors,
  buildThreadCard,
  findOverlappingThreads,
  mergeThreadCards,
  collectMissingEventIds,
  MAX_THREAD_DEPTH,
} from "../threadBuilder";
import type { ThreadNote, ThreadCard } from "../types";

// ヘルパー: 最小限の ThreadNote を作成
function makeNote(overrides: Partial<ThreadNote> & { eventId: string }): ThreadNote {
  return {
    pubkey: "pub_default",
    content: "hello",
    created_at: 1000,
    tags: [],
    ...overrides,
  };
}

// ヘルパー: 最小限の ThreadCard を作成
function makeThreadCard(
  notes: ThreadNote[],
  eventIds: string[],
  slotId = "slot-1",
): ThreadCard {
  return {
    type: "thread",
    slotId,
    pubkey: notes[0]?.pubkey ?? "",
    score: 0,
    fadingOut: false,
    created_at: Math.max(...notes.map(n => n.created_at), 0),
    notes,
    eventIds: new Set(eventIds),
  };
}

describe("extractReplyEventIds", () => {
  test("e タグから eventId を抽出する", () => {
    const tags = [
      ["e", "abc123", "wss://relay"],
      ["p", "pubkey1"],
      ["e", "def456"],
    ];
    expect(extractReplyEventIds(tags)).toEqual(["abc123", "def456"]);
  });

  test("e タグがない場合は空配列", () => {
    const tags = [["p", "pubkey1"], ["t", "nostr"]];
    expect(extractReplyEventIds(tags)).toEqual([]);
  });

  test("空タグ配列", () => {
    expect(extractReplyEventIds([])).toEqual([]);
  });

  test("e タグに値がない場合はスキップ", () => {
    const tags = [["e"], ["e", "valid"]];
    expect(extractReplyEventIds(tags)).toEqual(["valid"]);
  });
});

describe("isReply", () => {
  test("e タグがあればリプライ", () => {
    expect(isReply([["e", "abc123"]])).toBe(true);
  });

  test("e タグがなければリプライではない", () => {
    expect(isReply([["p", "pubkey1"]])).toBe(false);
  });

  test("空タグ配列はリプライではない", () => {
    expect(isReply([])).toBe(false);
  });

  test("値なし e タグはリプライではない", () => {
    expect(isReply([["e"]])).toBe(false);
  });
});

describe("getDirectReplyTarget", () => {
  test("最後の e タグの eventId を返す", () => {
    const tags = [
      ["e", "root"],
      ["e", "parent"],
      ["e", "direct"],
    ];
    expect(getDirectReplyTarget(tags)).toBe("direct");
  });

  test("e タグが1つだけ", () => {
    expect(getDirectReplyTarget([["e", "only"]])).toBe("only");
  });

  test("e タグがなければ undefined", () => {
    expect(getDirectReplyTarget([["p", "pub"]])).toBeUndefined();
  });
});

describe("eventToThreadNote", () => {
  test("イベントを ThreadNote に変換する", () => {
    const event = {
      id: "evt1",
      pubkey: "pub1",
      content: "hello nostr",
      created_at: 1700000000,
      tags: [["e", "parent_evt"]],
    };
    const note = eventToThreadNote(event);
    expect(note).toEqual({
      eventId: "evt1",
      pubkey: "pub1",
      content: "hello nostr",
      created_at: 1700000000,
      tags: [["e", "parent_evt"]],
      replyTo: { eventId: "parent_evt" },
    });
  });

  test("e タグがないイベントは replyTo なし", () => {
    const event = {
      id: "evt2",
      pubkey: "pub2",
      content: "root post",
      created_at: 1700000000,
      tags: [["p", "someone"]],
    };
    const note = eventToThreadNote(event);
    expect(note.replyTo).toBeUndefined();
  });
});

describe("resolveReplyAuthors", () => {
  test("スレッド内ノートから replyTo.pubkey を解決する", () => {
    const notes: ThreadNote[] = [
      makeNote({ eventId: "a", pubkey: "alice", created_at: 1 }),
      makeNote({
        eventId: "b",
        pubkey: "bob",
        created_at: 2,
        replyTo: { eventId: "a" },
      }),
    ];
    const resolved = resolveReplyAuthors(notes);
    expect(resolved[1]!.replyTo).toEqual({ eventId: "a", pubkey: "alice" });
  });

  test("参照先がスレッド外の場合は pubkey を解決しない", () => {
    const notes: ThreadNote[] = [
      makeNote({
        eventId: "b",
        pubkey: "bob",
        created_at: 2,
        replyTo: { eventId: "unknown" },
      }),
    ];
    const resolved = resolveReplyAuthors(notes);
    expect(resolved[0]!.replyTo).toEqual({ eventId: "unknown" });
  });

  test("replyTo がないノートはそのまま返す", () => {
    const notes: ThreadNote[] = [
      makeNote({ eventId: "a", pubkey: "alice" }),
    ];
    const resolved = resolveReplyAuthors(notes);
    expect(resolved[0]!.replyTo).toBeUndefined();
  });
});

describe("buildThreadCard", () => {
  test("ノートを created_at 順にソートする", () => {
    const notes: ThreadNote[] = [
      makeNote({ eventId: "c", created_at: 300 }),
      makeNote({ eventId: "a", created_at: 100 }),
      makeNote({ eventId: "b", created_at: 200 }),
    ];
    const card = buildThreadCard(notes, "owner");
    expect(card.notes.map(n => n.eventId)).toEqual(["a", "b", "c"]);
  });

  test("eventIds に全ノートの eventId が含まれる", () => {
    const notes: ThreadNote[] = [
      makeNote({ eventId: "x" }),
      makeNote({ eventId: "y" }),
    ];
    const card = buildThreadCard(notes, "owner");
    expect(card.eventIds).toEqual(new Set(["x", "y"]));
  });

  test("created_at は最新ノートのタイムスタンプ", () => {
    const notes: ThreadNote[] = [
      makeNote({ eventId: "a", created_at: 100 }),
      makeNote({ eventId: "b", created_at: 500 }),
      makeNote({ eventId: "c", created_at: 300 }),
    ];
    const card = buildThreadCard(notes, "owner");
    expect(card.created_at).toBe(500);
  });

  test("空ノート配列の場合", () => {
    const card = buildThreadCard([], "owner");
    expect(card.notes).toEqual([]);
    expect(card.eventIds.size).toBe(0);
    expect(card.created_at).toBe(0);
    expect(card.pubkey).toBe("");
  });

  test("type は thread", () => {
    const card = buildThreadCard([makeNote({ eventId: "a" })], "owner");
    expect(card.type).toBe("thread");
  });
});

describe("findOverlappingThreads", () => {
  test("オーバーラップするスレッドを検出する", () => {
    const threads: ThreadCard[] = [
      makeThreadCard(
        [makeNote({ eventId: "a" }), makeNote({ eventId: "b" })],
        ["a", "b"],
        "slot-1",
      ),
      makeThreadCard(
        [makeNote({ eventId: "c" })],
        ["c"],
        "slot-2",
      ),
    ];
    const result = findOverlappingThreads(threads, ["b", "d"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.slotId).toBe("slot-1");
  });

  test("オーバーラップなし", () => {
    const threads: ThreadCard[] = [
      makeThreadCard([makeNote({ eventId: "a" })], ["a"]),
    ];
    const result = findOverlappingThreads(threads, ["x", "y"]);
    expect(result).toHaveLength(0);
  });

  test("複数スレッドがマッチ", () => {
    const threads: ThreadCard[] = [
      makeThreadCard([makeNote({ eventId: "a" })], ["a"], "slot-1"),
      makeThreadCard([makeNote({ eventId: "b" })], ["b"], "slot-2"),
    ];
    const result = findOverlappingThreads(threads, ["a", "b"]);
    expect(result).toHaveLength(2);
  });
});

describe("mergeThreadCards", () => {
  test("既存スレッドと新ノートをマージする", () => {
    const existing: ThreadCard[] = [
      makeThreadCard(
        [makeNote({ eventId: "a", created_at: 100 })],
        ["a"],
        "keep-this-slot",
      ),
    ];
    const newNotes: ThreadNote[] = [
      makeNote({ eventId: "b", created_at: 200 }),
    ];
    const merged = mergeThreadCards(existing, newNotes, "owner");
    expect(merged.notes).toHaveLength(2);
    expect(merged.eventIds).toEqual(new Set(["a", "b"]));
  });

  test("重複 eventId は排除される", () => {
    const existing: ThreadCard[] = [
      makeThreadCard(
        [makeNote({ eventId: "a", content: "original" })],
        ["a"],
      ),
    ];
    const newNotes: ThreadNote[] = [
      makeNote({ eventId: "a", content: "duplicate" }),
      makeNote({ eventId: "b" }),
    ];
    const merged = mergeThreadCards(existing, newNotes, "owner");
    // 新しい方で上書きされる（Map の後勝ち）
    expect(merged.notes).toHaveLength(2);
    expect(merged.eventIds.size).toBe(2);
  });

  test("slotId は最初の既存スレッドから引き継ぐ", () => {
    const existing: ThreadCard[] = [
      makeThreadCard([makeNote({ eventId: "a" })], ["a"], "original-slot"),
      makeThreadCard([makeNote({ eventId: "b" })], ["b"], "other-slot"),
    ];
    const merged = mergeThreadCards(existing, [], "owner");
    expect(merged.slotId).toBe("original-slot");
  });

  test("既存スレッドが空の場合は新しい slotId", () => {
    const newNotes: ThreadNote[] = [makeNote({ eventId: "a" })];
    const merged = mergeThreadCards([], newNotes, "owner");
    expect(merged.slotId).toBeTruthy();
    expect(merged.notes).toHaveLength(1);
  });
});

describe("collectMissingEventIds", () => {
  test("未取得の eventId を収集する", () => {
    const known = new Set(["a", "b"]);
    const newNotes = [
      { id: "c", tags: [["e", "a"], ["e", "d"]] },
      { id: "e", tags: [["e", "f"]] },
    ];
    const missing = collectMissingEventIds(known, newNotes);
    expect(missing.sort()).toEqual(["d", "f"]);
  });

  test("全て既知の場合は空配列", () => {
    const known = new Set(["a", "b"]);
    const newNotes = [{ id: "c", tags: [["e", "a"], ["e", "b"]] }];
    expect(collectMissingEventIds(known, newNotes)).toEqual([]);
  });

  test("e タグがない場合は空配列", () => {
    const known = new Set<string>();
    const newNotes = [{ id: "a", tags: [["p", "pub1"]] }];
    expect(collectMissingEventIds(known, newNotes)).toEqual([]);
  });

  test("重複する未取得 eventId は1つにまとめる", () => {
    const known = new Set<string>();
    const newNotes = [
      { id: "a", tags: [["e", "x"]] },
      { id: "b", tags: [["e", "x"]] },
    ];
    expect(collectMissingEventIds(known, newNotes)).toEqual(["x"]);
  });
});

describe("MAX_THREAD_DEPTH", () => {
  test("定数が10", () => {
    expect(MAX_THREAD_DEPTH).toBe(10);
  });
});
