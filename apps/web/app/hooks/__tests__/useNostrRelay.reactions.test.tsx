// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "nostr-tools/core";
import { useNostrRelay } from "../useNostrRelay";
import { signEventWithActiveSigner } from "../../lib/nostrSigner";
import { reactionKey } from "../../lib/reactions";

const mock = vi.hoisted(() => ({
  pool: { publish: vi.fn(), subscribeMany: vi.fn() },
  relayUrls: ["wss://relay.example"],
  notes: [], notesRef: { current: [] }, minimum: { current: undefined },
  profiles: new Map(), cache: { addEvents: vi.fn() },
}));
vi.mock("../useNostrConnection", () => ({ useNostrConnection: () => ({
  pool: mock.pool, timelinePool: mock.pool, relayUrls: mock.relayUrls,
  followPubkeys: [], status: "connected", setStatus: vi.fn(), updateFollowList: vi.fn(),
}) }));
vi.mock("../useNostrProfiles", () => ({ useNostrProfiles: () => ({
  profiles: mock.profiles, profilesRef: { current: mock.profiles }, fetchProfiles: vi.fn(),
}) }));
vi.mock("../useEventCache", () => ({ useEventCache: () => mock.cache }));
vi.mock("../useCustomEmojis", () => ({ useCustomEmojis: () => ({ emojiSets: [], looseEmojis: [] }) }));
vi.mock("../useNostrNotes", () => ({ useNostrNotes: () => ({
  notes: mock.notes, notesRef: mock.notesRef, newNotesMinCreatedAtRef: mock.minimum,
}) }));
vi.mock("../../lib/nostrSigner", () => ({ signEventWithActiveSigner: vi.fn() }));
beforeEach(() => { vi.clearAllMocks(); mock.pool.publish.mockImplementation(() => [Promise.resolve()]); });
afterEach(cleanup);
const signed: Event = { id: "signed", kind: 7, pubkey: "me", content: ":wave:", tags: [["e", "old"], ["emoji", "wave", "https://example.test/wave.png"]], sig: "mock", created_at: 1 };

describe("プロフィールでも共通のリアクション送信", () => {
  it("署名待ちを共有しkind7を一度だけpublishして同じ集計へ反映する", async () => {
    let resolve!: (event: Event) => void;
    vi.mocked(signEventWithActiveSigner).mockImplementation(() => new Promise(r => { resolve = r; }));
    const { result } = renderHook(() => useNostrRelay("me", { current: new Map() }));
    let first!: Promise<void>;
    act(() => {
      first = result.current.sendReaction("old", "author", ":wave:", "https://example.test/wave.png");
      expect(result.current.sendReaction("old", "author", ":wave:", "https://example.test/wave.png")).toBe(first);
    });
    await expect(result.current.sendReaction("old", "author", "❤️")).rejects.toThrow("送信中");
    expect(signEventWithActiveSigner).toHaveBeenCalledOnce();
    expect(signEventWithActiveSigner).toHaveBeenCalledWith(expect.objectContaining({
      kind: 7, content: ":wave:", tags: expect.arrayContaining([["e", "old", "", "author"], ["p", "author"], ["emoji", "wave", "https://example.test/wave.png"]]),
    }));
    await act(async () => { resolve(signed); await first; });
    expect(mock.pool.publish).toHaveBeenCalledOnce();
    expect(mock.pool.publish).toHaveBeenCalledWith(mock.relayUrls, signed);
    expect(result.current.reactions.get("old")?.get(reactionKey(":wave:", "https://example.test/wave.png"))?.count).toBe(1);
  });

  it("publish失敗では加算せずロックを解除して再試行できる", async () => {
    vi.mocked(signEventWithActiveSigner).mockResolvedValue(signed);
    mock.pool.publish.mockImplementationOnce(() => [Promise.reject(new Error("mock failure"))]);
    const { result } = renderHook(() => useNostrRelay("me", { current: new Map() }));
    await act(async () => {
      await expect(result.current.sendReaction("old", "author", ":wave:")).rejects.toThrow("すべてのリレー");
    });
    expect(result.current.reactions.size).toBe(0);
    await act(async () => { await result.current.sendReaction("old", "author", ":wave:"); });
    expect(signEventWithActiveSigner).toHaveBeenCalledTimes(2);
    expect(result.current.reactions.get("old")?.size).toBe(1);
  });
});
