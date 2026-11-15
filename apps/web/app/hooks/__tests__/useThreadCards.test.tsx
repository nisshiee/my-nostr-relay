// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Event } from "nostr-tools/core";
import type { SimplePool } from "nostr-tools/pool";
import type { NoteCard } from "../../lib/types";
import type { EventCache } from "../useEventCache";
import { useNostrNotes } from "../useNostrNotes";
import { useThreadCards } from "../useThreadCards";
import { calculateCardScore } from "../../lib/scoring";

const NOW = 1_800_000_000;
function event(id: string, age = 0, tags: string[][] = []): Event {
  return { id, created_at: NOW - age, tags, kind: 1, sig: "", pubkey: `author-${id}`, content: id };
}
function note(id: string, age = 0, parent?: string): NoteCard {
  const e = event(id, age, parent ? [["e", parent, "", "root"]] : []);
  return { ...e, type: "note", eventId: id, slotId: `slot-${id}`, score: 1 };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function setup(initial: NoteCard[] = [], live = false) {
  vi.useFakeTimers(); vi.setSystemTime(NOW * 1000);
  let sub!: { onevent(e: Event): void; oneose(): Promise<void> };
  const pool = { subscribeMany: vi.fn((_urls, _filter, callbacks) => { sub = callbacks; return { close: vi.fn() }; }) } as unknown as SimplePool;
  const events = new Map<string, Event>();
  const fetchEvents = vi.fn<EventCache["fetchEvents"]>().mockResolvedValue([]);
  const cache: EventCache = { addEvents: es => es.forEach(e => events.set(e.id, e)), getEvent: id => events.get(id), fetchEvents, ensureProfiles: vi.fn() };
  const slots = { current: new Map<string, string>() }; const profiles = { current: new Map() };
  const noop = vi.fn(); const follows = ["author"];
  const props = { notes: initial, pubkey: "owner", pool, relays: ["wss://example.invalid"] };
  const hook = renderHook(p => {
    const feed = useNostrNotes(live ? p.pool : null, p.relays, follows, p.pubkey, slots, noop, profiles, noop, noop, cache);
    const input = live ? feed.notes : p.notes;
    return { feedNotes: input, ...useThreadCards(input, p.pubkey, p.relays, p.pool, "connected", cache, slots) };
  }, { initialProps: props });
  return { ...hook, props, cache, fetchEvents, events, slots, get sub() { return sub; } };
}
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(201); }); };
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("保持元を共有する単独・スレッドカード", () => {
  it.each([2, 5, 68])("%i件スレッドも元投稿が100件枠から外れれば単独投稿とともに消える", async count => {
    const h = setup([], true); await act(async () => { await h.sub.oneose(); });
    act(() => {
      h.sub.onevent(event("root", 7200));
      for (let i = 1; i < count; i++) h.sub.onevent(event(`reply-${i}`, 7200 - i, [["e", "root", "", "root"]]));
      h.sub.onevent(event("old-single", 7200));
    }); await tick();
    expect(h.result.current.threadCards[0].notes).toHaveLength(count);
    act(() => { for (let i = 0; i < 100; i++) h.sub.onevent(event(`fresh-${i}`)); }); await tick();
    expect(h.result.current.feedNotes).toHaveLength(100);
    expect(h.result.current.filteredNotes.every(n => n.eventId.startsWith("fresh-"))).toBe(true);
    expect(h.result.current.threadCards).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(7_200_000); });
    expect(h.result.current.threadCards).toEqual([]);
  });
  it("105組受信しても100投稿に対応する50組だけが残る", async () => {
    const h = setup([], true); await act(async () => { await h.sub.oneose(); });
    for (let i = 0; i < 105; i++) {
      vi.setSystemTime((NOW + i * 2 + 1) * 1000);
      act(() => { h.sub.onevent(event(`root-${i}`, -i * 2)); h.sub.onevent(event(`reply-${i}`, -i * 2 - 1, [["e", `root-${i}`]])); });
      await tick();
    }
    expect(h.result.current.feedNotes).toHaveLength(100);
    expect(h.result.current.threadCards).toHaveLength(50);
    expect(h.result.current.threadCards.reduce((sum, card) => sum + card.scoreSources.length, 0)).toBe(100);
  });
  it("最新返信が剪定されたら文脈とslotを維持しつつ残った投稿だけで採点する", async () => {
    const root = note("root", 7200); const reply = note("reply", 10, "root");
    const h = setup([root, reply]); await tick();
    const before = h.result.current.threadCards[0];
    h.rerender({ ...h.props, notes: [root] }); await tick();
    const after = h.result.current.threadCards[0];
    expect(after.slotId).toBe(before.slotId);
    expect(after.notes).toHaveLength(2);
    expect(after.created_at).toBe(reply.created_at);
    expect(after.scoreSources).toEqual([root]);
    expect(calculateCardScore(after, "owner", NOW)).toBe(calculateCardScore(root, "owner", NOW));
  });
  it("保持中のリポスト情報更新を新規返信なしでも採点元へ反映する", async () => {
    const root = note("root", 7200); const reply = note("reply", 3600, "root");
    const h = setup([root, reply]); await tick();
    const slot = h.result.current.threadCards[0].slotId;
    const repost = { ...root, repostInfo: { reposterPubkey: "owner", repostedAt: NOW } };
    h.rerender({ ...h.props, notes: [repost, reply] }); await tick();
    expect(h.result.current.threadCards[0].slotId).toBe(slot);
    expect(calculateCardScore(h.result.current.threadCards[0], "owner", NOW)).toBe(1);
  });
  it("空入力で消えた返信IDも再受信時に再構築できる", async () => {
    const inputs = [note("root"), note("reply", 0, "root")];
    const h = setup(inputs); await tick();
    h.rerender({ ...h.props, notes: [] }); await tick();
    expect(h.result.current.threadCards).toEqual([]);
    h.rerender({ ...h.props, notes: inputs }); await tick();
    expect(h.result.current.threadCards[0].notes).toHaveLength(2);
  });
  it("最後の保持元を失った後の祖先取得完了で復活しない", async () => {
    const pending = deferred<Event[]>(); const h = setup([note("reply", 10, "root")]);
    h.fetchEvents.mockReturnValueOnce(pending.promise); await tick();
    h.rerender({ ...h.props, notes: [] }); await tick();
    await act(async () => { pending.resolve([event("root", 7200)]); });
    expect(h.result.current.threadCards).toEqual([]);
    expect(h.result.current.filteredNotes).toEqual([]);
  });
  it("別の投稿が増えても継続中の祖先取得を破棄せず、本人祖先で加点しない", async () => {
    const pending = deferred<Event[]>(); const reply = note("reply", 1800, "root");
    const h = setup([reply]); h.fetchEvents.mockReturnValueOnce(pending.promise); await tick();
    const slot = h.result.current.threadCards[0].slotId;
    h.rerender({ ...h.props, notes: [reply, note("unrelated")] }); await tick();
    await act(async () => { pending.resolve([{ ...event("root", 7200), pubkey: "owner" }]); });
    const card = h.result.current.threadCards[0];
    expect(card.slotId).toBe(slot); expect(card.notes).toHaveLength(2);
    expect(card.scoreSources).toEqual([reply]);
    expect(calculateCardScore(card, "owner", NOW)).toBe(0.5);
  });
  it.each(["account", "pool", "unmount"])("%s切替後の祖先応答で文脈や追加REQを持ち越さない", async boundary => {
    const pending = deferred<Event[]>(); const h = setup([note("reply", 10, "root")]);
    h.fetchEvents.mockReturnValueOnce(pending.promise); await tick();
    if (boundary === "unmount") h.unmount();
    else h.rerender({ ...h.props, notes: [], ...(boundary === "account" ? { pubkey: "next-owner" } : { pool: {} as SimplePool }) });
    await act(async () => { pending.resolve([event("root", 7200, [["e", "deeper"]])]); });
    expect(h.fetchEvents).toHaveBeenCalledTimes(1);
    expect(h.cache.ensureProfiles).not.toHaveBeenCalled();
    if (boundary !== "unmount") expect(h.result.current.threadCards).toEqual([]);
  });
  it("二つのスレッドを結ぶ返信で重複なくマージし、既存slotを引き継ぐ", async () => {
    const inputs = [note("a", 100), note("ar", 80, "a"), note("b", 90), note("br", 70, "b")];
    const h = setup(inputs); await tick();
    const slot = h.result.current.threadCards[0].slotId;
    const bridge = { ...note("bridge"), tags: [["e", "a", "", "root"], ["e", "b", "", "reply"]] };
    h.rerender({ ...h.props, notes: [...inputs, bridge] }); await tick();
    expect(h.result.current.threadCards).toHaveLength(1);
    expect(h.result.current.threadCards[0]).toMatchObject({ slotId: slot, created_at: NOW });
    expect(h.result.current.threadCards[0].scoreSources).toHaveLength(5);
    expect(h.result.current.filteredNotes).toEqual([]);
  });
  it("循環する祖先タグを再取得しない", async () => {
    const h = setup([note("reply", 10, "root")]);
    h.fetchEvents.mockResolvedValue([event("root", 20, [["e", "root"]])]); await tick();
    expect(h.fetchEvents).toHaveBeenCalledTimes(1);
    expect(h.result.current.threadCards[0].notes).toHaveLength(2);
  });
});

it("祖先チェーンを10段で打ち切り、祖先を採点元に加えない", async () => {
  const h = setup([note("reply", 0, "ancestor-0")]);
  h.fetchEvents.mockImplementation(async filter => {
    const id = filter.ids![0]; const depth = Number(id.split("-")[1]);
    return [event(id, depth + 1, [["e", `ancestor-${depth + 1}`]])];
  });
  await tick();
  expect(h.fetchEvents).toHaveBeenCalledTimes(10);
  expect(h.result.current.threadCards[0].notes).toHaveLength(11);
  expect(h.result.current.threadCards[0].scoreSources).toHaveLength(1);
});
