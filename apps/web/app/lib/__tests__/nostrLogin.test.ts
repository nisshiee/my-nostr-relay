import { describe, expect, it, vi } from "vitest";
import type { Nostr } from "../../types/nostr";
import {
  LoginCancelledError,
  LoginCoordinator,
  requestPublicKey,
  resolveNostrProvider,
} from "../nostrLogin";

function provider(overrides: Partial<Nostr> = {}): Nostr {
  return {
    getPublicKey: vi.fn(async () => "a".repeat(64)),
    signEvent: vi.fn(),
    ...overrides,
  };
}

describe("resolveNostrProvider", () => {
  it("NIP-07拡張が存在するときはremoteを読み込まず拡張を優先する", async () => {
    const extension = provider();
    const loadRemote = vi.fn(async () => undefined);

    const result = await resolveNostrProvider({
      getProvider: () => extension,
      loadRemote,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ method: "extension", provider: extension });
    expect(loadRemote).not.toHaveBeenCalled();
  });

  it("拡張がないときはwindow.nostr.jsの署名器を返す", async () => {
    const remote = provider({ isWnj: true });
    let current: Nostr | undefined;

    const result = await resolveNostrProvider({
      getProvider: () => current,
      loadRemote: async () => {
        current = remote;
      },
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ method: "remote", provider: remote });
  });
});

describe("LoginCoordinator", () => {
  it("繰り返しログインでは古い試行の遅延結果を破棄する", async () => {
    const coordinator = new LoginCoordinator();
    let finishFirst: (value: string) => void = () => undefined;
    const first = coordinator.run(
      () => new Promise<string>((resolve) => {
        finishFirst = resolve;
      }),
    );
    const second = coordinator.run(async () => "second");
    finishFirst("first");

    await expect(first).rejects.toBeInstanceOf(LoginCancelledError);
    await expect(second).resolves.toBe("second");
  });

  it("接続キャンセル後の結果を受け入れない", async () => {
    const coordinator = new LoginCoordinator();
    let finish: (value: string) => void = () => undefined;
    const attempt = coordinator.run(
      () => new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );

    coordinator.cancel();
    finish("late");

    await expect(attempt).rejects.toBeInstanceOf(LoginCancelledError);
  });
});

describe("requestPublicKey", () => {
  it("QR接続でpointerが保存されたら再要求して0.8.1の待機要求をflushする", async () => {
    let resolveFirst: (value: string) => void = () => undefined;
    let calls = 0;
    let pointer: string | null = null;
    const remote = provider({
      isWnj: true,
      getPublicKey: vi.fn(() => {
        calls += 1;
        if (calls === 1) {
          return new Promise<string>((resolve) => {
            resolveFirst = resolve;
          });
        }
        resolveFirst("b".repeat(64));
        return Promise.resolve("b".repeat(64));
      }),
    });

    const result = requestPublicKey(remote, {
      signal: new AbortController().signal,
      readRemotePointer: () => pointer,
      pollIntervalMs: 1,
    });
    pointer = JSON.stringify({ pubkey: "test" });

    await expect(result).resolves.toBe("b".repeat(64));
    expect(remote.getPublicKey).toHaveBeenCalledTimes(2);
  });

  it("キャンセル時はupstreamの未完了要求を待たない", async () => {
    const controller = new AbortController();
    const remote = provider({
      isWnj: true,
      getPublicKey: vi.fn(() => new Promise<string>(() => undefined)),
    });
    const result = requestPublicKey(remote, {
      signal: controller.signal,
      readRemotePointer: () => null,
      pollIntervalMs: 1,
    });

    controller.abort();

    await expect(result).rejects.toBeInstanceOf(LoginCancelledError);
  });
});

