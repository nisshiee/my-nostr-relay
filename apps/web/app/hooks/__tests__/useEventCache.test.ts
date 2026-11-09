// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Event } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import type { SimplePool } from "nostr-tools/pool";
import { doFetch, useEventCache } from "../useEventCache";

const origin = { kind: "nevent" } as const;

function poolWithQuery(querySync: ReturnType<typeof vi.fn>): SimplePool {
  return { querySync } as unknown as SimplePool;
}

describe("doFetch", () => {
  it("passes only public wss hints to SimplePool and preserves fallback relays", async () => {
    const querySync = vi.fn().mockResolvedValue([]);
    const pool = poolWithQuery(querySync);

    await doFetch(
      pool,
      ["wss://default.example/"],
      { ids: ["a".repeat(64)] },
      1500,
      [
        { rawUrl: "wss://127.0.0.1/", origin },
        { rawUrl: "wss://relay.example.com/", origin },
        { rawUrl: "not a URL", origin },
      ],
    );

    expect(querySync).toHaveBeenCalledOnce();
    expect(querySync).toHaveBeenCalledWith(
      ["wss://default.example/", "wss://relay.example.com/"],
      { ids: ["a".repeat(64)] },
      { maxWait: 1500 },
    );
  });

  it("queries configured relays when every external hint is rejected", async () => {
    const querySync = vi.fn().mockResolvedValue([]);
    const pool = poolWithQuery(querySync);

    await doFetch(
      pool,
      ["ws://127.0.0.1:8080/", "wss://default.example/"],
      { kinds: [1] },
      2000,
      [
        { rawUrl: "ws://relay.example.com/", origin },
        { rawUrl: "wss://[::1]/", origin },
        { rawUrl: "wss://user:secret@relay.example.com/", origin },
      ],
    );

    expect(querySync).toHaveBeenCalledWith(
      ["ws://127.0.0.1:8080/", "wss://default.example/"],
      { kinds: [1] },
      { maxWait: 2000 },
    );
  });

  it("does not let one malformed hint abort the request", async () => {
    const expected = [{ id: "event" }];
    const querySync = vi.fn().mockResolvedValue(expected);

    await expect(
      doFetch(
        poolWithQuery(querySync),
        ["wss://default.example/"],
        { ids: ["b".repeat(64)] },
        1000,
        [{ rawUrl: "wss://[:::1]/", origin }],
      ),
    ).resolves.toBe(expected);

    expect(querySync).toHaveBeenCalledWith(
      ["wss://default.example/"],
      { ids: ["b".repeat(64)] },
      { maxWait: 1000 },
    );
  });
});


function event(id: string, overrides: Partial<Event> = {}): Event {
  return {
    id: id.repeat(64), pubkey: "f".repeat(64), kind: 1,
    created_at: 100, tags: [["t", "nostr"]], content: "hello", sig: "0".repeat(128),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const relays = ["wss://default.example/"];

afterEach(cleanup);

describe("useEventCache", () => {
  it("returns matching cached IDs and fetches only missing IDs", async () => {
    const a = event("a");
    const b = event("b");
    const query = vi.fn().mockResolvedValue([b]);
    const { result } = renderHook(() => useEventCache(poolWithQuery(query), relays, vi.fn()));
    result.current.addEvents([a]);
    await expect(result.current.fetchEvents({ ids: [a.id, b.id], kinds: [1] }))
      .resolves.toEqual([a, b]);
    expect(query).toHaveBeenCalledWith(relays, { ids: [b.id], kinds: [1] }, expect.anything());
    expect(result.current.getEvent(b.id)).toEqual(b);
    await result.current.fetchEvents({ ids: [a.id, b.id] });
    expect(query).toHaveBeenCalledOnce();
  });

  it.each<Filter>([
    { kinds: [6] }, { authors: ["e".repeat(64)] }, { "#t": ["other"] },
    { since: 101 }, { until: 99 }, { until: 0 },
  ])("does not return cached IDs that violate %j", async (constraint) => {
    const a = event("a");
    const query = vi.fn().mockResolvedValue([]);
    const { result } = renderHook(() => useEventCache(poolWithQuery(query), relays, vi.fn()));
    result.current.addEvents([a]);
    await expect(result.current.fetchEvents({ ids: [a.id], ...constraint })).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("does not duplicate repeated cached IDs", async () => {
    const a = event("a");
    const { result } = renderHook(() => useEventCache(poolWithQuery(vi.fn()), relays, vi.fn()));
    result.current.addEvents([a]);
    await expect(result.current.fetchEvents({ ids: [a.id, a.id] })).resolves.toEqual([a]);
  });

  it.each<Filter>([{ limit: 1 }, { search: "absent" }])(
    "delegates full constrained ID queries to the relay for %j", async (constraint) => {
      const a = event("a");
      const b = event("b");
      const query = vi.fn().mockResolvedValue([b]);
      const { result } = renderHook(() => useEventCache(poolWithQuery(query), relays, vi.fn()));
      result.current.addEvents([a]);
      const filter = { ids: [a.id, b.id], ...constraint };
      await expect(result.current.fetchEvents(filter)).resolves.toEqual([b]);
      expect(query).toHaveBeenCalledWith(relays, filter, expect.anything());
    },
  );

  it.each([true, false])("deduplicates simultaneous requests, IDs=%s", async (byIds) => {
    const a = event("a");
    const pending = deferred<Event[]>();
    const query = vi.fn().mockReturnValue(pending.promise);
    const { result } = renderHook(() => useEventCache(poolWithQuery(query), relays, vi.fn()));
    const filter = byIds ? { ids: [a.id] } : { kinds: [1] };
    const first = result.current.fetchEvents(filter);
    const second = result.current.fetchEvents(filter);
    expect(query).toHaveBeenCalledOnce();
    pending.resolve([a]);
    await expect(first).resolves.toEqual([a]);
    await expect(second).resolves.toEqual([a]);
  });

  it("shares missing-ID requests while preserving each caller's cached subset", async () => {
    const a = event("a");
    const b = event("b");
    const pending = deferred<Event[]>();
    const query = vi.fn().mockReturnValue(pending.promise);
    const { result } = renderHook(() => useEventCache(poolWithQuery(query), relays, vi.fn()));
    result.current.addEvents([a]);
    const first = result.current.fetchEvents({ ids: [a.id, b.id] });
    const second = result.current.fetchEvents({ ids: [b.id] });
    expect(query).toHaveBeenCalledOnce();
    pending.resolve([b]);
    await expect(first).resolves.toEqual([a, b]);
    await expect(second).resolves.toEqual([b]);
  });

  it("does not treat partially overlapping ID requests as interchangeable", async () => {
    const a = event("a"), b = event("b"), c = event("c");
    const pending = deferred<Event[]>();
    const query = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce([b, c]);
    const { result } = renderHook(() => useEventCache(poolWithQuery(query), relays, vi.fn()));
    const first = result.current.fetchEvents({ ids: [a.id, b.id] });
    await expect(result.current.fetchEvents({ ids: [b.id, c.id] })).resolves.toEqual([b, c]);
    expect(query).toHaveBeenCalledTimes(2);
    pending.resolve([a, b]);
    await expect(first).resolves.toEqual([a, b]);
  });

  it.each([true, false])("retries after rejection without poisoning inflight, IDs=%s", async (byIds) => {
    const a = event("a");
    const query = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([a]);
    const { result } = renderHook(() => useEventCache(poolWithQuery(query), relays, vi.fn()));
    const filter = byIds ? { ids: [a.id] } : { kinds: [1] };
    await expect(result.current.fetchEvents(filter)).rejects.toThrow("offline");
    await expect(result.current.fetchEvents(filter)).resolves.toEqual([a]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("keeps inflight requests separate by filter, relay targets and timeout", async () => {
    const pending = deferred<Event[]>();
    const query = vi.fn().mockReturnValue(pending.promise);
    const pool = poolWithQuery(query);
    const { result, rerender } = renderHook(({ urls }) => useEventCache(pool, urls, vi.fn()), {
      initialProps: { urls: relays },
    });
    const calls = [
      result.current.fetchEvents({ kinds: [1] }, { maxWait: 100 }),
      result.current.fetchEvents({ kinds: [6] }, { maxWait: 100 }),
      result.current.fetchEvents({ kinds: [1] }, { maxWait: 200 }),
      result.current.fetchEvents({ kinds: [1] }, { maxWait: 100,
        relayCandidates: [{ rawUrl: "wss://hint.example/", origin }] }),
    ];
    rerender({ urls: ["wss://other.example/"] });
    calls.push(result.current.fetchEvents({ kinds: [1] }, { maxWait: 100 }));
    expect(query).toHaveBeenCalledTimes(5);
    pending.resolve([]);
    await Promise.all(calls);
  });

  it.each([true, false])("does not reuse a retired pool's inflight request, IDs=%s", async (byIds) => {
    const a = event("a");
    const oldPending = deferred<Event[]>();
    const newPending = deferred<Event[]>();
    const oldQuery = vi.fn().mockReturnValue(oldPending.promise);
    const newQuery = vi.fn().mockReturnValue(newPending.promise);
    const { result, rerender } = renderHook(({ pool }) => useEventCache(pool, relays, vi.fn()), {
      initialProps: { pool: poolWithQuery(oldQuery) },
    });
    const filter = byIds ? { ids: [a.id] } : { kinds: [1] };
    const oldRequest = result.current.fetchEvents(filter);
    rerender({ pool: poolWithQuery(newQuery) });
    const newRequest = result.current.fetchEvents(filter);
    expect(newQuery).toHaveBeenCalledOnce();
    oldPending.resolve([]);
    await oldRequest;
    const sharedNewRequest = result.current.fetchEvents(filter);
    expect(newQuery).toHaveBeenCalledOnce();
    newPending.resolve([a]);
    await expect(newRequest).resolves.toEqual([a]);
    await expect(sharedNewRequest).resolves.toEqual([a]);
  });

  it("does not cache empty responses or synchronous failures as completed requests", async () => {
    const a = event("a");
    const query = vi.fn().mockImplementationOnce(() => { throw new Error("closed"); })
      .mockResolvedValueOnce([]).mockResolvedValueOnce([a]);
    const { result } = renderHook(() => useEventCache(poolWithQuery(query), relays, vi.fn()));
    const filter = { ids: [a.id] };
    await expect(result.current.fetchEvents(filter)).rejects.toThrow("closed");
    await expect(result.current.fetchEvents(filter)).resolves.toEqual([]);
    await expect(result.current.fetchEvents(filter)).resolves.toEqual([a]);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("does not share different constraints for the same missing ID", async () => {
    const a = event("a");
    const pending = deferred<Event[]>();
    const query = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce([]);
    const { result } = renderHook(() => useEventCache(poolWithQuery(query), relays, vi.fn()));
    const first = result.current.fetchEvents({ ids: [a.id], kinds: [1] });
    await expect(result.current.fetchEvents({ ids: [a.id], kinds: [6] })).resolves.toEqual([]);
    expect(query).toHaveBeenCalledTimes(2);
    pending.resolve([a]);
    await expect(first).resolves.toEqual([a]);
  });

  it("does not infer that a prefix query is complete from a cached event", async () => {
    const a = event("a");
    const query = vi.fn().mockResolvedValue([a]);
    const { result } = renderHook(() => useEventCache(poolWithQuery(query), relays, vi.fn()));
    result.current.addEvents([a]);
    await expect(result.current.fetchEvents({ ids: [a.id.slice(0, 8)] })).resolves.toEqual([a]);
    expect(query).toHaveBeenCalledOnce();
  });

  it("keeps cached immutable events when the pool changes and skips queries without a connection", async () => {
    const a = event("a");
    const query = vi.fn().mockResolvedValue([]);
    const pool = poolWithQuery(query);
    const { result, rerender } = renderHook(
      ({ pool, urls }: { pool: SimplePool | null; urls: string[] }) => useEventCache(pool, urls, vi.fn()),
      { initialProps: { pool: null as SimplePool | null, urls: relays } },
    );
    result.current.addEvents([a]);
    await expect(result.current.fetchEvents({ ids: [a.id] })).resolves.toEqual([]);
    rerender({ pool, urls: [] });
    await expect(result.current.fetchEvents({ ids: [a.id] })).resolves.toEqual([]);
    rerender({ pool, urls: relays });
    await expect(result.current.fetchEvents({ ids: [a.id] })).resolves.toEqual([a]);
    expect(query).not.toHaveBeenCalled();
  });

  it("keeps methods stable and forwards profile requests to the latest callback", () => {
    const initial = vi.fn(), latest = vi.fn();
    const { result, rerender } = renderHook(({ profiles }) => useEventCache(null, [], profiles), {
      initialProps: { profiles: initial },
    });
    const cache = result.current;
    rerender({ profiles: latest });
    expect(result.current).toBe(cache);
    cache.ensureProfiles(["a"]);
    expect(initial).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith(["a"]);
  });
});
