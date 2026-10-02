import { afterEach, describe, expect, it, vi } from "vitest";
import type { Nostr } from "../../types/nostr";
import {
  LoginCancelledError,
  LoginCoordinator,
  closeRemoteSignerWidget,
  openRemoteSignerWidget,
  requestPublicKey,
  resolveNostrProvider,
  syncRemoteSignerWidget,
  type RemoteSignerWidgetSurface,
} from "../nostrLogin";

afterEach(() => vi.unstubAllGlobals());

function widgetHarness() {
  let opened = false;
  let dispatchCount = 0;
  let focusCount = 0;
  let closeCount = 0;
  const closeButton = {
    textContent: "⤫",
    click: () => {
      closeCount += 1;
      opened = false;
    },
  };
  const focusButton = { focus: () => { focusCount += 1; } };
  const mount = {
    dispatchEvent: () => {
      dispatchCount += 1;
      opened = true;
      return true;
    },
  };
  const root = {
    getElementById: (id: string) => id === "wnj" ? mount : null,
    querySelector: (selector: string) => {
      if (selector === ".animate-show") return opened ? {} : null;
      if (selector === "button") return focusButton;
      return null;
    },
    querySelectorAll: () => [closeButton],
  };
  const attributes = new Map<string, string>();
  const host = {
    shadowRoot: root,
    style: { display: "" },
    setAttribute: (name: string, value: string) => attributes.set(name, value),
  };
  const surface = { host, mount, root } as unknown as RemoteSignerWidgetSurface;

  return {
    surface,
    host,
    root,
    attributes,
    setOpened: (value: boolean) => { opened = value; },
    counts: () => ({ dispatchCount, focusCount, closeCount }),
  };
}

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

describe("remote signer widget", () => {
  it("閉じたバッジを隠し、管理画面を開いている間だけ表示する", () => {
    const harness = widgetHarness();

    syncRemoteSignerWidget(harness.surface);
    expect(harness.host.style.display).toBe("none");
    expect(harness.attributes.get("aria-hidden")).toBe("true");

    harness.setOpened(true);
    syncRemoteSignerWidget(harness.surface);
    expect(harness.host.style.display).toBe("");
    expect(harness.attributes.get("aria-hidden")).toBe("false");
  });

  it("ヘッダー操作の繰り返しで画面を再生成せず、開いている画面へfocusする", () => {
    const harness = widgetHarness();
    vi.stubGlobal("document", { body: { children: [harness.host] } });
    vi.stubGlobal("MouseEvent", class {
      constructor(public type: string, public options: unknown) {}
    });
    vi.stubGlobal("MutationObserver", class {
      observe() {}
      disconnect() {}
    });

    expect(openRemoteSignerWidget()).toBe(true);
    expect(openRemoteSignerWidget()).toBe(true);
    expect(harness.counts()).toEqual({
      dispatchCount: 1,
      focusCount: 1,
      closeCount: 0,
    });
  });

  it("キャンセル操作でupstreamの閉じるボタンも実行する", () => {
    const harness = widgetHarness();
    harness.setOpened(true);
    vi.stubGlobal("document", { body: { children: [harness.host] } });

    closeRemoteSignerWidget();

    expect(harness.counts().closeCount).toBe(1);
  });
});
