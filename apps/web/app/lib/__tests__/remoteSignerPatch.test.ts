import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { originalConnect, patchedConnect, patchRemoteSigner } from "../../../scripts/patch-remote-signer.mjs";

const require = createRequire(import.meta.url);
const bundle = readFileSync(require.resolve("window.nostr.js"), "utf8");

function harness(code: string) {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const signer = new Promise((res, rej) => { resolve = res; reject = rej; });
  // This harness executes the audited upstream closure with its minified bindings.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env: Record<string, any> = {
    P: undefined, hr: {}, I: undefined, N: {}, pf: {},
    n: () => undefined, m: false, R: false, L: "closed", b: false,
    B: signer, $: resolve, q: reject, K: [], Q: [],
    setTimeout: () => 1, clearTimeout: () => undefined,
    Kn: vi.fn(), Date: { now: () => 20 },
    localStorage: { setItem: vi.fn() }, f: { BUNKER_POINTER: "test" },
    tt: vi.fn(async () => {
      for (const call of env.Q.splice(0)) call.resolve(await (await env.B).getPublicKey());
    }),
    x: null, k: null, C: null, M: false, w: false, yn: vi.fn(),
  };
  const run = (provider: unknown) => new Function("env", "provider", "with(env){" + code + ";return gc(provider)}")(env, provider) as Promise<void>;
  function keyRequest() {
    return new Promise((res, rej) => {
      env.K.push(rej);
      env.Q.push({ resolve: res, reject: rej });
    });
  }
  return { env, run, keyRequest };
}

describe("window.nostr.js fixed-version connection patch", () => {
  it("validates the full pinned bundle and is idempotent", () => {
    const patched = patchRemoteSigner(bundle);
    expect(patched).toContain(patchedConnect);
    expect(patchRemoteSigner(patched)).toBe(patched);
    expect(() => patchRemoteSigner(bundle + "unexpected")).toThrow();
    expect(() => patchRemoteSigner(patched + "unexpected")).toThrow();
  });

  it("reproduces the upstream successful-connect stall before applying the patch", async () => {
    const h = harness(originalConnect);
    const p = { connect: vi.fn(async () => {}), switchRelays: vi.fn(() => new Promise(() => {})) };
    void h.run(p);
    await Promise.resolve();
    await Promise.resolve();
    expect(p.connect).toHaveBeenCalledOnce();
    expect(p.switchRelays).toHaveBeenCalledOnce();
    expect(h.env.tt).not.toHaveBeenCalled();
  });

  it("finishes the public-key request even if optional switch_relays never answers", async () => {
    const h = harness(patchedConnect);
    const key = h.keyRequest();
    const p = { connect: vi.fn(async () => {}), getPublicKey: vi.fn(async () => "public-key"),
      switchRelays: vi.fn(() => new Promise(() => {})) };
    await h.run(p);
    await expect(key).resolves.toBe("public-key");
    expect(p.switchRelays).toHaveBeenCalledOnce();
    expect(h.env.b).toBe(true);
    expect(h.env.m).toBe(false);
  });

  it("rejects queued callers on failure and allows a new attempt to resolve a fresh signer", async () => {
    const h = harness(patchedConnect);
    const first = h.keyRequest();
    const firstOutcome = expect(first).rejects.toBe("declined");
    await h.run({ connect: async () => { throw new Error("declined"); } });
    await firstOutcome;
    expect(h.env.K).toHaveLength(0);
    expect(h.env.Q).toHaveLength(0);
    expect(h.env.b).toBe(false);
    const retry = h.keyRequest();
    await h.run({ connect: async () => {}, getPublicKey: async () => "public-key", switchRelays: async () => false });
    await expect(retry).resolves.toBe("public-key");
  });

  it("does not let an abandoned connection failure reject or clear a newer attempt", async () => {
    const h = harness(patchedConnect);
    let failOld!: (reason: Error) => void;
    const old = h.run({ connect: () => new Promise((_, reject) => { failOld = reject; }) });
    const newReject = vi.fn();
    const newQueue = [{ resolve: vi.fn(), reject: newReject }];
    h.env.B = new Promise(() => {});
    h.env.q = newReject;
    h.env.K = [newReject];
    h.env.Q = newQueue;
    h.env.m = true;
    failOld(new Error("late failure"));
    await old;
    expect(newReject).not.toHaveBeenCalled();
    expect(h.env.Q).toBe(newQueue);
    expect(h.env.m).toBe(true);
  });

  it("ignores optional relay-switch rejection after completing login", async () => {
    const h = harness(patchedConnect);
    const key = h.keyRequest();
    await h.run({ connect: async () => {}, getPublicKey: async () => "public-key",
      switchRelays: async () => { throw new Error("unsupported"); } });
    await expect(key).resolves.toBe("public-key");
    expect(h.env.b).toBe(true);
  });
});
