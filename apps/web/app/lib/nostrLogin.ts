import type { Nostr } from "../types/nostr";
import type { NostrLoginMethod } from "./nostrSigner";

const REMOTE_POINTER_KEY = "wnj:bunkerPointer";
const WIDGET_MOUNT_ID = "wnj";
const EXTENSION_TIMEOUT = 3000;
const EXTENSION_PROVIDER = Symbol("nostr-extension-provider");

type NostrWindow = Window & { [EXTENSION_PROVIDER]?: Nostr };

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
  host?: NostrWindow;
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

function rememberExtension(host: NostrWindow, provider: Nostr): void {
  if (!provider.isWnj) host[EXTENSION_PROVIDER] = provider;
}

export function getExtensionProvider(
  host: NostrWindow = window,
): Nostr | undefined {
  if (host[EXTENSION_PROVIDER]) return host[EXTENSION_PROVIDER];
  if (host.nostr && !host.nostr.isWnj) return host.nostr;
  return undefined;
}

/** remote 読込前に既存拡張を退避し、window.nostr.js が初期化できる状態にする。 */
function prepareRemoteProvider(host: NostrWindow): void {
  const current = host.nostr;
  if (current?.isWnj) return;
  if (current) rememberExtension(host, current);

  const descriptor = Object.getOwnPropertyDescriptor(host, "nostr");
  if (descriptor && !descriptor.configurable) {
    throw new Error(
      "ブラウザ拡張がwindow.nostrを固定しているため、リモート署名器を開始できません",
    );
  }

  let remoteCandidate: Nostr | undefined;
  Object.defineProperty(host, "nostr", {
    configurable: true,
    get: () => remoteCandidate,
    set: (provider: Nostr) => {
      if (provider.isWnj) remoteCandidate = provider;
      else rememberExtension(host, provider);
    },
  });
}

/** remote provider を固定し、遅れて注入された拡張は明示選択用に退避する。 */
function lockRemoteProvider(host: NostrWindow, remote: Nostr): void {
  Object.defineProperty(host, "nostr", {
    configurable: true,
    get: () => remote,
    set: (provider: Nostr) => {
      if (provider !== remote) rememberExtension(host, provider);
    },
  });
}

/** NIP-46 を優先して固定依存の window.nostr.js を読み込む。 */
export async function resolveRemoteNostrProvider({
  host = window,
  loadRemote = () => import("window.nostr.js"),
  signal,
  pollIntervalMs = 50,
  timeoutMs = 5000,
}: ResolveProviderOptions): Promise<ResolvedNostrProvider> {
  const existing = host.nostr;
  if (existing?.isWnj) {
    lockRemoteProvider(host, existing);
    if (typeof document !== "undefined") manageRemoteSignerWidget();
    return { method: "remote", provider: existing };
  }

  prepareRemoteProvider(host);
  if (!host.nostr) {
    await loadRemote();
  }

  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted && Date.now() < deadline) {
    const provider = host.nostr;
    if (provider?.isWnj) {
      lockRemoteProvider(host, provider);
      if (typeof document !== "undefined") {
        manageRemoteSignerWidget();
      }
      return { method: "remote", provider };
    }
    await wait(pollIntervalMs, signal);
  }
  if (signal.aborted) throw abortError();
  throw new Error("NIP-46ログイン画面を読み込めませんでした");
}

interface ResolveExtensionOptions {
  host?: NostrWindow;
  signal: AbortSignal;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

/** 明示的に選ばれた NIP-07 拡張を、遅延注入も含めて解決する。 */
export async function resolveExtensionProvider({
  host = window,
  signal,
  pollIntervalMs = 50,
  timeoutMs = EXTENSION_TIMEOUT,
}: ResolveExtensionOptions): Promise<ResolvedNostrProvider> {
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted && Date.now() < deadline) {
    const provider = getExtensionProvider(host);
    if (provider) return { method: "extension", provider };
    await wait(pollIntervalMs, signal);
  }
  if (signal.aborted) throw abortError();
  throw new Error("NIP-07拡張が見つかりません");
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
