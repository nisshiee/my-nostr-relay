import type { Nostr } from "../types/nostr";
import type { NostrLoginMethod } from "./nostrSigner";

const REMOTE_POINTER_KEY = "wnj:bunkerPointer";
const WIDGET_MOUNT_ID = "wnj";

export interface RemoteSignerWidgetSurface {
  host: HTMLElement;
  mount: HTMLElement;
  root: ShadowRoot;
}

let managedWidgetHost: HTMLElement | null = null;
let widgetObserver: MutationObserver | null = null;

function findRemoteSignerWidget(): RemoteSignerWidgetSurface | null {
  for (const child of Array.from(document.body.children)) {
    const host = child as HTMLElement;
    const root = host.shadowRoot;
    const mount = root?.getElementById(WIDGET_MOUNT_ID);
    if (root && mount) return { host, mount, root };
  }
  return null;
}

function isWidgetOpen(root: ShadowRoot): boolean {
  return root.querySelector(".animate-show") !== null;
}

/** 開いている間だけ upstream UI を表示し、閉じたフローティングバッジは隠す。 */
export function syncRemoteSignerWidget(
  surface: RemoteSignerWidgetSurface,
): void {
  const opened = isWidgetOpen(surface.root);
  surface.host.style.display = opened ? "" : "none";
  surface.host.setAttribute("aria-hidden", opened ? "false" : "true");
}

export function manageRemoteSignerWidget(): boolean {
  const surface = findRemoteSignerWidget();
  if (!surface) return false;

  if (managedWidgetHost !== surface.host) {
    widgetObserver?.disconnect();
    managedWidgetHost = surface.host;
    widgetObserver = new MutationObserver(() => syncRemoteSignerWidget(surface));
    widgetObserver.observe(surface.mount, {
      attributes: true,
      childList: true,
      subtree: true,
    });
  }
  syncRemoteSignerWidget(surface);
  return true;
}

/** ヘッダーのボタンから NIP-46 の接続・アカウント管理画面を開く。 */
export function openRemoteSignerWidget(): boolean {
  const surface = findRemoteSignerWidget();
  if (!surface) return false;
  manageRemoteSignerWidget();

  if (isWidgetOpen(surface.root)) {
    (surface.root.querySelector("button") as HTMLButtonElement | null)?.focus();
    return true;
  }

  surface.mount.dispatchEvent(
    new MouseEvent("click", { bubbles: true, composed: true }),
  );
  return true;
}

/** アプリ側のキャンセル操作を upstream UI の接続中断にも反映する。 */
export function closeRemoteSignerWidget(): void {
  const surface = findRemoteSignerWidget();
  if (!surface) return;
  const closeButton = Array.from(surface.root.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === "⤫",
  ) as HTMLButtonElement | undefined;
  closeButton?.click();
}

export class LoginCancelledError extends Error {
  constructor() {
    super("ログインをキャンセルしました");
    this.name = "LoginCancelledError";
  }
}

export interface ResolvedNostrProvider {
  method: NostrLoginMethod;
  provider: Nostr;
}

interface ResolveProviderOptions {
  getProvider?: () => Nostr | undefined;
  loadRemote?: () => Promise<unknown>;
  signal: AbortSignal;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

function abortError(): LoginCancelledError {
  return new LoginCancelledError();
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

/** 拡張があれば常に優先し、なければ固定依存の window.nostr.js を読み込む。 */
export async function resolveNostrProvider({
  getProvider = () => window.nostr,
  loadRemote = () => import("window.nostr.js"),
  signal,
  pollIntervalMs = 50,
  timeoutMs = 5000,
}: ResolveProviderOptions): Promise<ResolvedNostrProvider> {
  const existing = getProvider();
  if (existing && !existing.isWnj) {
    return { method: "extension", provider: existing };
  }
  if (!existing) {
    await loadRemote();
  }

  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted && Date.now() < deadline) {
    const provider = getProvider();
    if (provider) {
      if (provider.isWnj && typeof document !== "undefined") {
        manageRemoteSignerWidget();
      }
      return { method: provider.isWnj ? "remote" : "extension", provider };
    }
    await wait(pollIntervalMs, signal);
  }
  if (signal.aborted) throw abortError();
  throw new Error("NIP-46ログイン画面を読み込めませんでした");
}

interface RequestPublicKeyOptions {
  signal: AbortSignal;
  readRemotePointer?: () => string | null;
  pollIntervalMs?: number;
}

/**
 * 公開鍵要求をキャンセル可能にする。
 * 0.8.1 の QR 接続経路で待機要求が flush されない問題は、保存された接続で
 * もう一度要求して通常の connect 経路へ進めることで回避する。
 */
export async function requestPublicKey(
  provider: Nostr,
  {
    signal,
    readRemotePointer = () => localStorage.getItem(REMOTE_POINTER_KEY),
    pollIntervalMs = 100,
  }: RequestPublicKeyOptions,
): Promise<string> {
  if (signal.aborted) throw abortError();

  const pointerBefore = provider.isWnj ? readRemotePointer() : null;
  let workaroundTimer: ReturnType<typeof setInterval> | undefined;
  if (provider.isWnj) {
    workaroundTimer = setInterval(() => {
      if (signal.aborted) return;
      const pointer = readRemotePointer();
      if (pointer && pointer !== pointerBefore) {
        clearInterval(workaroundTimer);
        workaroundTimer = undefined;
        void provider.getPublicKey().catch(() => undefined);
      }
    }, pollIntervalMs);
  }

  const providerRequest = provider.getPublicKey();
  // キャンセル後に upstream が解決・拒否しても未処理 Promise にしない。
  void providerRequest.catch(() => undefined);
  const cancellation = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });

  try {
    return await Promise.race([providerRequest, cancellation]);
  } finally {
    if (workaroundTimer) clearInterval(workaroundTimer);
  }
}

/** 重複ログインを直列化し、古い試行の遅延結果を無効化する。 */
export class LoginCoordinator {
  private sequence = 0;
  private controller: AbortController | null = null;

  cancel(): void {
    this.sequence += 1;
    this.controller?.abort();
    this.controller = null;
  }

  async run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.cancel();
    const sequence = this.sequence;
    const controller = new AbortController();
    this.controller = controller;

    try {
      const result = await operation(controller.signal);
      if (controller.signal.aborted || this.sequence !== sequence) {
        throw abortError();
      }
      return result;
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
}
