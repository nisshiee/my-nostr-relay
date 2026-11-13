// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTO_LOGIN_TIMEOUT_MS } from "../../lib/nostrLogin";
import { clearActiveSigner } from "../../lib/nostrSigner";
import type { Nostr } from "../../types/nostr";
import { AuthProvider, useAuth } from "../AuthContext";

const STORED_PUBKEY = "a".repeat(64);
const REMOTE_PUBKEY = "b".repeat(64);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function provider(
  getPublicKey: Nostr["getPublicKey"],
  { remote = false }: { remote?: boolean } = {},
): Nostr {
  return {
    isWnj: remote,
    getPublicKey,
    signEvent: vi.fn(),
  };
}

function AuthProbe() {
  const auth = useAuth();
  return (
    <>
      <span data-testid="auto-loading">{String(auth.autoLoading)}</span>
      <span data-testid="error">{auth.loginError}</span>
      <span data-testid="availability">
        {auth.nip07Available === null
          ? "pending"
          : String(auth.nip07Available)}
      </span>
      <span data-testid="remote-loading">{String(auth.remoteLoading)}</span>
      <span data-testid="method">{auth.loginMethod ?? "none"}</span>
      <span data-testid="pubkey">{auth.pubkey ?? "none"}</span>
      <button type="button" onClick={() => void auth.loginRemote()}>
        remote login
      </button>
      <button type="button" onClick={auth.cancelLogin}>
        cancel
      </button>
    </>
  );
}

function setWindowNostr(value: Nostr | undefined): void {
  Object.defineProperty(window, "nostr", {
    configurable: true,
    writable: true,
    value,
  });
}

afterEach(() => {
  cleanup();
  clearActiveSigner();
  localStorage.clear();
  setWindowNostr(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AuthProvider interactions", () => {
  it("応答のない自動復元を期限で終了し、古い応答を無視して手動再試行できる", async () => {
    vi.useFakeTimers();
    const stale = deferred<string>();
    const getPublicKey = vi.fn<Nostr["getPublicKey"]>()
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce(REMOTE_PUBKEY);
    setWindowNostr(provider(getPublicKey, { remote: true }));
    localStorage.setItem("nostr-relay:pubkey", STORED_PUBKEY);
    localStorage.setItem("nostr-relay:login-method", "remote");
    localStorage.setItem("wnj:bunkerPointer", "test-pointer");
    render(<AuthProvider><AuthProbe /></AuthProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByTestId("auto-loading").textContent).toBe("true");
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_LOGIN_TIMEOUT_MS); });
    expect(screen.getByTestId("auto-loading").textContent).toBe("false");
    expect(screen.getByTestId("error").textContent).toContain("署名器から応答がありません");
    expect(localStorage.getItem("wnj:bunkerPointer")).toBe("test-pointer");
    await act(async () => { stale.resolve(STORED_PUBKEY); });
    expect(screen.getByTestId("pubkey").textContent).toBe("none");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "remote login" })); });
    expect(screen.getByTestId("pubkey").textContent).toBe(REMOTE_PUBKEY);
  });

  it("自動復元もキャンセルでき、遅れて届いた公開鍵でログインしない", async () => {
    const stale = deferred<string>();
    setWindowNostr(provider(() => stale.promise, { remote: true }));
    localStorage.setItem("nostr-relay:pubkey", STORED_PUBKEY);
    localStorage.setItem("nostr-relay:login-method", "remote");
    render(<AuthProvider><AuthProbe /></AuthProvider>);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    await act(async () => { stale.resolve(STORED_PUBKEY); });
    expect(screen.getByTestId("auto-loading").textContent).toBe("false");
    expect(screen.getByTestId("pubkey").textContent).toBe("none");
  });

  it("mount直後に既存のNIP-07拡張を検出する", async () => {
    setWindowNostr(provider(vi.fn(async () => STORED_PUBKEY)));

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("availability").textContent).toBe("true");
    });
  });

  it("遅延注入された拡張をpollで検出する", async () => {
    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
    expect(screen.getByTestId("availability").textContent).toBe("pending");

    setWindowNostr(provider(vi.fn(async () => STORED_PUBKEY)));

    await waitFor(
      () => {
        expect(screen.getByTestId("availability").textContent).toBe("true");
      },
      { timeout: 1_500 },
    );
  });

  it("手動remoteログイン中は遅延検出した拡張の自動復元を開始しない", async () => {
    const remoteKey = deferred<string>();
    const remoteProvider = provider(() => remoteKey.promise, { remote: true });
    const extensionGetPublicKey = vi.fn(async () => STORED_PUBKEY);
    const extensionProvider = provider(extensionGetPublicKey);
    setWindowNostr(remoteProvider);
    localStorage.setItem("nostr-relay:pubkey", STORED_PUBKEY);
    localStorage.setItem("nostr-relay:login-method", "extension");

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "remote login" }));
    expect(screen.getByTestId("remote-loading").textContent).toBe("true");

    // remote固定後のsetterは、遅れて現れた拡張を明示選択用として退避する。
    window.nostr = extensionProvider;
    await waitFor(
      () => {
        expect(screen.getByTestId("availability").textContent).toBe("true");
      },
      { timeout: 1_500 },
    );
    expect(extensionGetPublicKey).not.toHaveBeenCalled();
    expect(screen.getByTestId("remote-loading").textContent).toBe("true");

    remoteKey.resolve(REMOTE_PUBKEY);
    await waitFor(() => {
      expect(screen.getByTestId("method").textContent).toBe("remote");
      expect(screen.getByTestId("pubkey").textContent).toBe(REMOTE_PUBKEY);
    });
    expect(extensionGetPublicKey).not.toHaveBeenCalled();
  });

  it("手動ログインをキャンセルした後に再試行できる", async () => {
    const firstKey = deferred<string>();
    const getPublicKey = vi
      .fn<Nostr["getPublicKey"]>()
      .mockImplementationOnce(() => firstKey.promise)
      .mockResolvedValueOnce(REMOTE_PUBKEY);
    setWindowNostr(provider(getPublicKey, { remote: true }));

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "remote login" }));
    expect(screen.getByTestId("remote-loading").textContent).toBe("true");
    await waitFor(() => expect(getPublicKey).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    await waitFor(() => {
      expect(screen.getByTestId("remote-loading").textContent).toBe("false");
      expect(screen.getByTestId("method").textContent).toBe("none");
    });

    fireEvent.click(screen.getByRole("button", { name: "remote login" }));
    await waitFor(() => {
      expect(screen.getByTestId("method").textContent).toBe("remote");
      expect(screen.getByTestId("pubkey").textContent).toBe(REMOTE_PUBKEY);
    });
    expect(getPublicKey).toHaveBeenCalledTimes(2);
  });
});
