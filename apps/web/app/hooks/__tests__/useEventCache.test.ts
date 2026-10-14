import { describe, expect, it, vi } from "vitest";
import type { SimplePool } from "nostr-tools/pool";
import { doFetch } from "../useEventCache";

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
