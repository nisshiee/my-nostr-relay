// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "nostr-tools/core";
import type { SimplePool } from "nostr-tools/pool";
import { useNostrReactions } from "../useNostrReactions";
import { REACTION_POLL_INTERVAL, REACTION_SINCE_SAFETY_MARGIN } from "../../lib/constants";
import { reactionKey } from "../../lib/reactions";
import type { NoteCard } from "../../lib/types";

function reaction(id: string, target = "note"): Event {
  return { id, kind: 7, pubkey: id, created_at: 100, content: "+", tags: [["e", target]], sig: "sig" };
}
function setup(initialEventIds = ["note"], strict = false) {
  const subscriptions: { callbacks: { onevent: (event: Event) => void; oneose: () => void }; close: ReturnType<typeof vi.fn> }[] = [];
  const subscribeMany = vi.fn((_urls, _filter, callbacks) => {
    const subscription = { callbacks, close: vi.fn() };
    subscriptions.push(subscription);
    return subscription;
  });
  const pool = { subscribeMany } as unknown as SimplePool;
  const relayUrls = ["wss://relay.example/"];
  const notesRef = { current: initialEventIds.map((eventId) => ({ eventId } as NoteCard)) };
  const minimumRef = { current: undefined as number | undefined };
  const hook = renderHook(({ ids }) => useNostrReactions(pool, relayUrls, notesRef, minimumRef, ids), {
    initialProps: { ids: initialEventIds },
    reactStrictMode: strict,
  });
  return { ...hook, subscriptions, subscribeMany, notesRef, minimumRef };
}

describe("useNostrReactions", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("buffers initial events and deduplicates initial, live, and local echoes", () => {
    const { result, subscriptions } = setup();
    const callbacks = subscriptions[0]!.callbacks;
    act(() => { callbacks.onevent(reaction("first")); callbacks.onevent(reaction("first")); });
    expect(result.current.reactions.size).toBe(0);
    act(() => callbacks.oneose());
    act(() => { callbacks.onevent(reaction("first")); result.current.addReaction(reaction("first")); callbacks.onevent(reaction("second")); });
    expect(result.current.reactions.get("note")?.get(reactionKey("👍"))?.count).toBe(2);
  });

  it.each([false, true])("merges optimistic reactions without duplicate echoes (StrictMode=%s)", (strict) => {
    const { result, subscriptions } = setup(["note"], strict);
    const callbacks = subscriptions.at(-1)!.callbacks;
    act(() => {
      result.current.addReaction(reaction("local"));
      callbacks.onevent(reaction("local"));
      callbacks.onevent(reaction("remote"));
      callbacks.oneose();
    });
    expect(result.current.reactions.get("note")?.get(reactionKey("👍"))?.count).toBe(2);
  });

  it("starts only one polling interval even if EOSE is repeated", () => {
    const { subscriptions, subscribeMany, unmount } = setup();
    act(() => { subscriptions[0]!.callbacks.oneose(); subscriptions[0]!.callbacks.oneose(); });
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(REACTION_POLL_INTERVAL));
    expect(subscribeMany).toHaveBeenCalledTimes(2);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(subscriptions[1]!.close).toHaveBeenCalledOnce();
  });

  it("ignores old callbacks after cleanup and preserves the replacement subscription", () => {
    const { subscriptions, result, rerender, unmount } = setup();
    act(() => subscriptions[0]!.callbacks.onevent(reaction("old")));
    rerender({ ids: ["replacement"] });
    expect(subscriptions[0]!.close).toHaveBeenCalledOnce();
    act(() => {
      subscriptions[1]!.callbacks.onevent(reaction("new", "replacement"));
      subscriptions[1]!.callbacks.oneose();
      subscriptions[0]!.callbacks.oneose();
      subscriptions[0]!.callbacks.onevent(reaction("late"));
    });
    expect(result.current.reactions.has("note")).toBe(false);
    expect(result.current.reactions.get("replacement")?.get(reactionKey("👍"))?.count).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    act(() => subscriptions[1]!.callbacks.oneose());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resubscribes to current notes with overlap and the oldest newly added note timestamp", () => {
    const { subscriptions, subscribeMany, notesRef, minimumRef } = setup();
    act(() => subscriptions[0]!.callbacks.oneose());
    notesRef.current = [{ eventId: "new-note" } as NoteCard];
    minimumRef.current = 50;
    act(() => vi.advanceTimersByTime(REACTION_POLL_INTERVAL));
    expect(subscriptions[0]!.close).toHaveBeenCalledOnce();
    expect(subscribeMany).toHaveBeenLastCalledWith(["wss://relay.example/"], { kinds: [7], "#e": ["new-note"], since: 50 }, expect.any(Object));
    expect(minimumRef.current).toBeUndefined();
    act(() => vi.advanceTimersByTime(REACTION_POLL_INTERVAL));
    expect(subscriptions[1]!.close).toHaveBeenCalledOnce();
    expect(subscribeMany).toHaveBeenLastCalledWith(["wss://relay.example/"], { kinds: [7], "#e": ["new-note"], since: 1030 - REACTION_SINCE_SAFETY_MARGIN }, expect.any(Object));
  });

  it("waits for nonempty initial IDs and never sends an empty target filter", () => {
    const { subscriptions, subscribeMany, notesRef, rerender } = setup([]);
    expect(subscribeMany).not.toHaveBeenCalled();
    notesRef.current = [{ eventId: "later" } as NoteCard];
    rerender({ ids: ["later"] });
    expect(subscribeMany).toHaveBeenCalledOnce();
    act(() => subscriptions[0]!.callbacks.oneose());
    notesRef.current = [];
    act(() => vi.advanceTimersByTime(REACTION_POLL_INTERVAL));
    expect(subscribeMany).toHaveBeenCalledOnce();
  });

  it("survives StrictMode cleanup without allowing stale EOSE to revive a subscription", () => {
    const { subscriptions, subscribeMany, unmount } = setup(["note"], true);
    expect(subscribeMany).toHaveBeenCalledTimes(2);
    expect(subscriptions[0]!.close).toHaveBeenCalledOnce();
    act(() => { subscriptions[0]!.callbacks.oneose(); subscriptions[1]!.callbacks.oneose(); });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
