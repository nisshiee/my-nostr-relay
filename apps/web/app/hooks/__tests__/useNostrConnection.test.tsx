// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "nostr-tools/core";
import { BOOTSTRAP_RELAYS } from "../../lib/constants";
import { useNostrConnection } from "../useNostrConnection";

const mocks = vi.hoisted(() => ({
  pools: [] as Array<{ querySync: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }>,
  queries: [] as Promise<Event[]>[],
}));

vi.mock("nostr-tools/pool", () => ({
  SimplePool: class {
    querySync = vi.fn(() => mocks.queries.shift() ?? Promise.resolve([]));
    destroy = vi.fn();
    constructor() { mocks.pools.push(this); }
  },
}));

function event(kind: number, tags: string[][], created_at = 10): Event {
  return { kind, tags, created_at, id: `${kind}-${created_at}`, pubkey: "owner", content: "", sig: "" };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => { mocks.pools.length = 0; mocks.queries.length = 0; });
afterEach(cleanup);

describe("useNostrConnection", () => {
  it("未ログインならpoolを生成しない", () => {
    const { result } = renderHook(() => useNostrConnection(null));
    expect(mocks.pools).toHaveLength(0);
    expect(result.current.pool).toBeNull();
    expect(result.current.relayUrls).toEqual([]);
  });

  it("フォローがないアカウントも接続を完了し、投稿用のリレーを保持する", async () => {
    mocks.queries.push(Promise.resolve([event(3, []), event(10002, [["r", "wss://owner.example"]])]));
    const { result } = renderHook(() => useNostrConnection("owner"));
    await waitFor(() => expect(result.current.status).toBe("connected"));
    expect(result.current.followPubkeys).toEqual([]);
    expect(result.current.relayUrls).toEqual([...BOOTSTRAP_RELAYS, "wss://owner.example"]);
    expect(result.current.pool).toBe(mocks.pools[0]);
  });

  it("bootstrapイベントが空でも既定リレーで空feedの初期化を完了する", async () => {
    const { result } = renderHook(() => useNostrConnection("owner"));
    await waitFor(() => expect(result.current.status).toBe("connected"));
    expect(result.current.relayUrls).toEqual(BOOTSTRAP_RELAYS);
    expect(result.current.followPubkeys).toEqual([]);
  });

  it("最新のリレー・フォロー設定を選び、ノート取得へ引き継ぐ", async () => {
    mocks.queries.push(Promise.resolve([
      event(3, [["p", "old"]], 1),
      event(3, [["p", "new"], ["p", "new"], ["p", ""]], 2),
      event(10002, [["r", "wss://old.example"]], 1),
      event(10002, [["r", "wss://new.example"], ["r", BOOTSTRAP_RELAYS[0]!]], 2),
    ]));
    const { result } = renderHook(() => useNostrConnection("owner"));
    await waitFor(() => expect(result.current.status).toBe("loading"));
    expect(result.current.followPubkeys).toEqual(["new"]);
    expect(result.current.relayUrls).toEqual([...BOOTSTRAP_RELAYS, "wss://new.example"]);
    expect(mocks.pools[0].querySync).toHaveBeenCalledWith(
      BOOTSTRAP_RELAYS,
      { kinds: [10002, 3], authors: ["owner"], limit: 2 },
      expect.objectContaining({ maxWait: expect.any(Number) }),
    );
  });

  it("bootstrapの失敗をerrorにする", async () => {
    mocks.queries.push(Promise.reject(new Error("offline")));
    const { result } = renderHook(() => useNostrConnection("owner"));
    await waitFor(() => expect(result.current.status).toBe("error"));
  });

  it("アカウント切替時に古いpoolを破棄し、遅れて返った設定を採用しない", async () => {
    const old = deferred<Event[]>();
    mocks.queries.push(old.promise, Promise.resolve([event(3, [["p", "new-follow"]])]));
    const { result, rerender } = renderHook(({ key }) => useNostrConnection(key), { initialProps: { key: "old" } });
    const oldPool = mocks.pools[0];
    rerender({ key: "new" });
    await waitFor(() => expect(result.current.followPubkeys).toEqual(["new-follow"]));
    await act(async () => old.resolve([event(3, [["p", "old-follow"]])]));
    expect(oldPool.destroy).toHaveBeenCalledOnce();
    expect(result.current.pool).toBe(mocks.pools[1]);
    expect(result.current.followPubkeys).toEqual(["new-follow"]);
  });

  it("古いbootstrapの失敗は新しい接続状態を上書きしない", async () => {
    const old = deferred<Event[]>();
    mocks.queries.push(old.promise, Promise.resolve([event(3, [["p", "new-follow"]])]));
    const { result, rerender } = renderHook(({ key }) => useNostrConnection(key), { initialProps: { key: "old" } });
    rerender({ key: "new" });
    await waitFor(() => expect(result.current.status).toBe("loading"));
    await act(async () => old.reject(new Error("old connection failed")));
    expect(result.current.status).toBe("loading");
  });

  it("ログアウト時にpoolと接続設定を破棄する", async () => {
    mocks.queries.push(Promise.resolve([event(3, [["p", "follow"]])]));
    const { result, rerender } = renderHook(({ key }: { key: string | null }) => useNostrConnection(key), { initialProps: { key: "owner" as string | null } });
    await waitFor(() => expect(result.current.status).toBe("loading"));
    rerender({ key: null });
    expect(mocks.pools[0].destroy).toHaveBeenCalledOnce();
    expect(result.current.pool).toBeNull();
    expect(result.current.followPubkeys).toEqual([]);
    expect(result.current.relayUrls).toEqual([]);
  });
});
