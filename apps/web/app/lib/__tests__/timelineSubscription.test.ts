import { afterEach, expect, it, vi } from "vitest";
import type { Event } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import type { SimplePool } from "nostr-tools/pool";
import { subscribeTimeline } from "../timelineSubscription";

function event(id: string, created_at: number): Event {
  return { id, created_at, kind: 1, pubkey: "author", content: "synthetic", tags: [], sig: "sig" };
}
interface Call {
  urls: string[];
  filter: Filter;
  callbacks: {
    onevent(event: Event): void;
    onclose(reasons: { url: string; reason: string }[]): void;
  };
}
function setup(urls = ["wss://a.example"]) {
  const calls: Call[] = [];
  const pool = {
    subscribeMany(urls: string[], filter: Filter, callbacks: Call["callbacks"]) {
      calls.push({ urls, filter, callbacks });
      return { close() {} };
    },
  } as unknown as SimplePool;
  const received = vi.fn();
  const subscription = subscribeTimeline(pool, urls, { kinds: [1], limit: 500 },
    { onevent: received }, { retryBaseMs: 1, retryMaxMs: 1, random: () => 0.5 });
  return { calls, subscription, received };
}
function disconnect(call: Call) {
  call.callbacks.onclose([{ url: call.urls[0]!, reason: "connection closed" }]);
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("future event preserves the earlier valid catchup watermark", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { calls, subscription } = setup();
  calls[0]!.callbacks.onevent(event("old", 1_799_996_400));
  calls[0]!.callbacks.onevent(event("future", 1_800_007_200));
  disconnect(calls[0]!);
  await vi.advanceTimersByTimeAsync(2);
  expect(calls[1]!.filter.since).toBe(1_799_996_390);
  subscription.close();
});

it("a duplicate updates its own relay watermark without duplicate delivery", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { calls, subscription, received } = setup(["wss://a.example", "wss://b.example"]);
  calls[0]!.callbacks.onevent(event("shared", 1_800_000_000));
  calls[1]!.callbacks.onevent(event("shared", 1_800_000_000));
  disconnect(calls[1]!);
  await vi.advanceTimersByTimeAsync(2);
  expect(calls[2]!.filter.since).toBe(1_799_999_990);
  expect(received).toHaveBeenCalledTimes(1);
  subscription.close();
});

it("duplicate receipt resets that relay's consecutive retry budget", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { calls, subscription } = setup(["wss://a.example", "wss://b.example"]);
  calls[0]!.callbacks.onevent(event("shared", 1_800_000_000));
  for (let attempt = 0; attempt < 7; attempt++) {
    const current = calls.at(-1)!;
    current.callbacks.onevent(event("shared", 1_800_000_000));
    disconnect(current);
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(2);
    expect(calls.length).toBe(before + 1);
  }
  subscription.close();
});
