// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Event } from "nostr-tools/core";
import type { SimplePool } from "nostr-tools/pool";
import { useNostrNotes } from "../useNostrNotes";
import type { EventCache } from "../useEventCache";
import type { NostrProfile } from "../../lib/types";
import { MAX_NOTES } from "../../lib/constants";

interface Subscription {
  onevent(event: Event): void;
  oneose(): Promise<void>;
  close: ReturnType<typeof vi.fn>;
}
function note(id: string, created_at = 100): Event {
  return { id, kind: 1, pubkey: "author", content: id, tags: [], sig: "sig", created_at };
}
function repost(id: string, target: string, created_at = 200): Event {
  return { ...note(id, created_at), kind: 6, tags: [["e", target]] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function setup() {
  const subscriptions: Subscription[] = [];
  const subscribeMany = vi.fn((_urls, _filter, callbacks) => {
    const subscription = { ...callbacks, close: vi.fn() } as Subscription;
    subscriptions.push(subscription);
    return subscription;
  });
  const pool = { subscribeMany } as unknown as SimplePool;
  const slots = { current: new Map<string, string>() };
  const profiles = { current: new Map<string, NostrProfile>() };
  const setStatus = vi.fn();
  const fetchProfiles = vi.fn();
  const onReady = vi.fn();
  const fetchEvents = vi.fn<EventCache["fetchEvents"]>().mockResolvedValue([]);
  const cache: EventCache = { fetchEvents, addEvents: vi.fn(), getEvent: vi.fn(), ensureProfiles: vi.fn() };
  const props = { pool: pool as SimplePool | null, relays: ["wss://relay.example"], follows: ["author"], pubkey: "owner" as string | null };
  const hook = renderHook((p: typeof props) => useNostrNotes(
    p.pool, p.relays, p.follows, p.pubkey, slots, setStatus, profiles, fetchProfiles, onReady, cache,
  ), { initialProps: props });
  return { ...hook, props, subscriptions, subscribeMany, slots, setStatus, fetchProfiles, onReady, fetchEvents, cache };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("useNostrNotes subscription lifecycle", () => {
  it("deduplicates initial notes, respects published slots and bounds the displayed batch", async () => {
    expect(MAX_NOTES).toBe(100);
    const h = setup();
    h.slots.current.set("0", "published-slot");
    const sub = h.subscriptions[0]!;
    act(() => {
      sub.onevent(note("0"));
      for (let i = 0; i <= MAX_NOTES; i++) sub.onevent(note(String(i)));
    });
    expect(h.result.current.notes).toEqual([]);
    await act(async () => { await sub.oneose(); });
    expect(h.result.current.notes).toHaveLength(MAX_NOTES);
    expect(new Set(h.result.current.notes.map(n => n.eventId)).size).toBe(MAX_NOTES);
    expect(h.result.current.notes.find(n => n.eventId === "0")?.slotId).toBe("published-slot");
    expect(h.result.current.notesRef.current).toBe(h.result.current.notes);
    expect(h.onReady).toHaveBeenLastCalledWith(h.result.current.notes.map(n => n.eventId));
    expect(h.setStatus).toHaveBeenLastCalledWith("connected");
  });
  it("keeps the 100 highest-scored notes after live arrivals", async () => {
    const h = setup();
    const sub = h.subscriptions[0]!;
    await act(async () => { await sub.oneose(); });
    const now = Math.floor(Date.now() / 1000);
    act(() => {
      for (let i = 0; i < 101; i++) sub.onevent(note(`live-${i}`, now - 101 + i));
    });
    expect(h.result.current.notes).toHaveLength(100);
    expect(h.result.current.notes.some(n => n.eventId === "live-0")).toBe(false);
    expect(h.result.current.notes.some(n => n.eventId === "live-100")).toBe(true);
  });
  it("preserves live notes and newer repost metadata while initial reposts are fetched", async () => {
    const h = setup();
    const pending = deferred<Event[]>();
    h.fetchEvents.mockReturnValueOnce(pending.promise).mockResolvedValueOnce([note("original")]);
    const sub = h.subscriptions[0]!;
    act(() => { sub.onevent(note("initial")); sub.onevent(repost("old-repost", "original", 200)); });
    let initial!: Promise<void>;
    act(() => { initial = sub.oneose(); });
    act(() => { sub.onevent(note("live")); });
    await act(async () => { sub.onevent(repost("new-repost", "original", 300)); });
    const originalSlot = h.result.current.notes.find(n => n.eventId === "original")?.slotId;
    const beforeCompletion = h.result.current.notes;
    const beforeIds = beforeCompletion.map(n => n.eventId);
    const initialSlot = beforeCompletion.find(n => n.eventId === "initial")?.slotId;
    await act(async () => { pending.resolve([note("original")]); await initial; });
    expect(beforeCompletion.map(n => n.eventId)).toEqual(beforeIds);
    expect(h.result.current.notes.map(n => n.eventId).sort()).toEqual(["initial", "live", "original"]);
    expect(h.result.current.notes.find(n => n.eventId === "initial")?.slotId).toBe(initialSlot);
    expect(h.result.current.notes.find(n => n.eventId === "original")).toMatchObject({
      slotId: originalSlot, repostInfo: { repostedAt: 300 },
    });
  });
  it("processes EOSE only once, including while the first callback is awaiting originals", async () => {
    const h = setup();
    const pending = deferred<Event[]>();
    h.fetchEvents.mockReturnValue(pending.promise);
    const sub = h.subscriptions[0]!;
    act(() => { sub.onevent(repost("repost", "original")); });
    h.onReady.mockClear();
    let initial!: Promise<void>;
    act(() => { initial = sub.oneose(); });
    // 同じ未解決Promiseを再度待たずに、重複呼び出しの副作用を確認する。
    let duplicate!: Promise<void>;
    act(() => { duplicate = sub.oneose(); });
    expect(h.fetchEvents).toHaveBeenCalledOnce();
    await act(async () => { pending.resolve([note("original")]); await initial; await duplicate; await sub.oneose(); });
    expect(h.onReady).toHaveBeenCalledOnce();
  });
  it.each([false, true])("ignores pending initial completion after cleanup (reject=%s)", async (reject) => {
    const h = setup();
    const pending = deferred<Event[]>();
    h.fetchEvents.mockReturnValue(pending.promise);
    const sub = h.subscriptions[0]!;
    act(() => { sub.onevent(repost("repost", "original")); });
    let initial!: Promise<void>;
    act(() => { initial = sub.oneose(); });
    h.unmount();
    h.onReady.mockClear(); h.setStatus.mockClear(); h.fetchProfiles.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      if (reject) pending.reject(new Error("offline")); else pending.resolve([note("original")]);
      await initial;
      sub.onevent(note("late")); await sub.oneose();
    });
    expect(sub.close).toHaveBeenCalledOnce();
    expect(h.onReady).not.toHaveBeenCalled();
    expect(h.setStatus).not.toHaveBeenCalled();
    expect(h.fetchProfiles).not.toHaveBeenCalled();
  });
  it("clears notes, reaction targets and timestamps when the account changes or logs out", async () => {
    const h = setup();
    const old = h.subscriptions[0]!;
    await act(async () => { await old.oneose(); old.onevent(note("old")); });
    expect(h.result.current.newNotesMinCreatedAtRef.current).toBe(100);
    h.rerender({ ...h.props, pubkey: "other" });
    expect(h.result.current.notes).toEqual([]);
    expect(h.result.current.notesRef.current).toEqual([]);
    expect(h.result.current.newNotesMinCreatedAtRef.current).toBeUndefined();
    expect(h.onReady).toHaveBeenLastCalledWith([]);
    await act(async () => { old.onevent(note("late")); await old.oneose(); });
    expect(h.result.current.notes).toEqual([]);
    const current = h.subscriptions[1]!;
    await act(async () => { current.onevent(note("new")); await current.oneose(); });
    h.rerender({ ...h.props, pubkey: null, pool: null });
    expect(h.result.current.notes).toEqual([]);
    expect(h.onReady).toHaveBeenLastCalledWith([]);
  });
  it("finishes an empty following feed without subscribing or retaining earlier notes", async () => {
    const h = setup();
    const sub = h.subscriptions[0]!;
    await act(async () => { sub.onevent(note("old")); await sub.oneose(); });
    h.rerender({ ...h.props, follows: [] });
    expect(h.subscribeMany).toHaveBeenCalledOnce();
    expect(sub.close).toHaveBeenCalledOnce();
    expect(h.result.current.notes).toEqual([]);
    expect(h.onReady).toHaveBeenLastCalledWith([]);
    expect(h.setStatus).toHaveBeenLastCalledWith("connected");
  });
  it("tracks a live repost original timestamp and starts reactions after an empty initial feed", async () => {
    const h = setup();
    h.fetchEvents.mockResolvedValue([note("old-original", 10)]);
    const sub = h.subscriptions[0]!;
    await act(async () => { await sub.oneose(); });
    h.onReady.mockClear();
    await act(async () => { sub.onevent(repost("repost", "old-original")); });
    expect(h.result.current.newNotesMinCreatedAtRef.current).toBe(10);
    expect(h.onReady).toHaveBeenCalledExactlyOnceWith(["old-original"]);
    act(() => { sub.onevent(note("another")); });
    expect(h.onReady).toHaveBeenCalledOnce();
  });
  it("does not notify stale IDs when note updates and a subscription change are batched", async () => {
    const h = setup();
    const old = h.subscriptions[0]!;
    await act(async () => { await old.oneose(); });
    h.onReady.mockClear();
    act(() => {
      old.onevent(note("old-live"));
      h.rerender({ ...h.props, follows: ["other-author"] });
    });
    expect(h.onReady.mock.calls).toEqual([[[]]]);
    expect(h.result.current.notes).toEqual([]);
  });

  it("ignores an obsolete repost lookup after a new subscription has finished", async () => {
    const h = setup();
    const pending = deferred<Event[]>();
    h.fetchEvents.mockReturnValueOnce(pending.promise);
    const old = h.subscriptions[0]!;
    act(() => { old.onevent(repost("old-repost", "old-original")); });
    let oldReady!: Promise<void>;
    act(() => { oldReady = old.oneose(); });
    h.rerender({ ...h.props, follows: ["new-author"] });
    const current = h.subscriptions[1]!;
    await act(async () => { current.onevent(note("new")); await current.oneose(); });
    h.onReady.mockClear(); h.setStatus.mockClear(); h.fetchProfiles.mockClear();
    await act(async () => { pending.resolve([note("old-original")]); await oldReady; });
    expect(h.result.current.notes.map(n => n.eventId)).toEqual(["new"]);
    expect(h.onReady).not.toHaveBeenCalled();
    expect(h.setStatus).not.toHaveBeenCalled();
    expect(h.fetchProfiles).not.toHaveBeenCalled();
  });

  it("releases even a throwing closer and ignores late realtime repost completion", async () => {
    const h = setup();
    const pending = deferred<Event[]>();
    h.fetchEvents.mockReturnValueOnce(pending.promise);
    const sub = h.subscriptions[0]!;
    await act(async () => { await sub.oneose(); });
    act(() => { sub.onevent(repost("repost", "original")); });
    sub.close.mockImplementation(() => { throw new Error("already closed"); });
    h.unmount();
    h.fetchProfiles.mockClear(); h.onReady.mockClear();
    await act(async () => { pending.resolve([note("original")]); });
    expect(sub.close).toHaveBeenCalledOnce();
    expect(h.fetchProfiles).not.toHaveBeenCalled();
    expect(h.onReady).not.toHaveBeenCalled();
  });

});
