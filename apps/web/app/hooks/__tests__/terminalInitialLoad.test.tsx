// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Event } from "nostr-tools/core";
import type { SimplePool } from "nostr-tools/pool";
import { useNostrNotes } from "../useNostrNotes";
import type { EventCache } from "../useEventCache";
import type { NostrProfile } from "../../lib/types";

interface Subscription {
  onevent(event: Event): void;
  oneose(): Promise<void>;
  onclose(reasons: { url: string; reason: string }[]): void;
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
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("pending initial repost fetch preserves terminal error",async()=>{
 vi.spyOn(console,"warn").mockImplementation(()=>{});
 const h=setup();const pending=deferred<Event[]>();h.fetchEvents.mockReturnValue(pending.promise);
 const sub=h.subscriptions[0]!;act(()=>sub.onevent(repost("r","original")));
 let initial!:Promise<void>;act(()=>{initial=sub.oneose();});
 act(()=>sub.onclose([{url:"wss://relay.example",reason:"blocked: policy"}]));
 expect(h.setStatus).toHaveBeenLastCalledWith("error");
 await act(async()=>{pending.resolve([]);await initial;});
 expect(h.setStatus).toHaveBeenLastCalledWith("error");
});