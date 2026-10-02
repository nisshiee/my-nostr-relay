"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { nip19 } from "nostr-tools";
import {
  LoginCancelledError,
  LoginCoordinator,
  closeRemoteSignerWidget,
  openRemoteSignerWidget,
  requestPublicKey,
  resolveNostrProvider,
} from "../lib/nostrLogin";
import {
  activateSigner,
  clearActiveSigner,
  type NostrLoginMethod,
} from "../lib/nostrSigner";
import type { Nostr } from "../types/nostr";

const STORAGE_KEY = "nostr-relay:pubkey";
const METHOD_STORAGE_KEY = "nostr-relay:login-method";
const REMOTE_POINTER_KEY = "wnj:bunkerPointer";

function getStoredPubkey(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(STORAGE_KEY);
}

function getStoredMethod(): NostrLoginMethod {
  if (typeof window === "undefined") return "extension";
  return localStorage.getItem(METHOD_STORAGE_KEY) === "remote"
    ? "remote"
    : "extension";
}

function storeSession(pubkey: string, method: NostrLoginMethod): void {
  localStorage.setItem(STORAGE_KEY, pubkey);
  localStorage.setItem(METHOD_STORAGE_KEY, method);
}

function removeStoredSession(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(METHOD_STORAGE_KEY);
}

function isValidPubkey(pubkey: string): boolean {
  return /^[0-9a-f]{64}$/i.test(pubkey);
}

interface AuthContextValue {
  pubkey: string | null;
  npub: string | null;
  /** NIP-07ブラウザ拡張の検出状態 */
  nip07Available: boolean | null;
  autoLoading: boolean;
  remoteLoading: boolean;
  loginError: string | null;
  loginMethod: NostrLoginMethod | null;
  login: () => Promise<void>;
  loginRemote: () => Promise<void>;
  manageRemoteSigner: () => void;
  cancelLogin: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);
const POLL_INTERVAL = 500;
const POLL_TIMEOUT = 3000;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [autoLoading, setAutoLoading] = useState(false);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginMethod, setLoginMethod] = useState<NostrLoginMethod | null>(null);
  const [nip07Available, setNip07Available] = useState<boolean | null>(() => {
    if (typeof window !== "undefined" && window.nostr && !window.nostr.isWnj) {
      return true;
    }
    return null;
  });
  const coordinatorRef = useRef(new LoginCoordinator());

  useEffect(() => {
    if (nip07Available !== null) return;

    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += POLL_INTERVAL;
      if (window.nostr && !window.nostr.isWnj) {
        setNip07Available(true);
        clearInterval(timer);
      } else if (elapsed >= POLL_TIMEOUT) {
        setNip07Available(false);
        clearInterval(timer);
      }
    }, POLL_INTERVAL);

    return () => clearInterval(timer);
  }, [nip07Available]);

  const completeLogin = useCallback(
    async (
      provider: Nostr,
      method: NostrLoginMethod,
      signal: AbortSignal,
      expectedPubkey?: string,
    ) => {
      const nextPubkey = await requestPublicKey(provider, { signal });
      if (!isValidPubkey(nextPubkey)) {
        throw new Error("署名器から不正な公開鍵が返されました");
      }
      if (expectedPubkey && expectedPubkey !== nextPubkey) {
        throw new Error("前回と異なるアカウントが返されたため、自動ログインを停止しました");
      }

      activateSigner(provider, nextPubkey);
      storeSession(nextPubkey, method);
      setPubkey(nextPubkey);
      setLoginMethod(method);
      setLoginError(null);
    },
    [],
  );

  // 保存済みセッションは、拡張を優先したうえで同じ公開鍵だけを復元する。
  useEffect(() => {
    if (nip07Available === null || pubkey) return;
    const storedPubkey = getStoredPubkey();
    if (!storedPubkey) return;
    const storedMethod = getStoredMethod();
    if (nip07Available === false && storedMethod !== "remote") return;

    let mounted = true;
    const coordinator = coordinatorRef.current;
    // 保存済みセッションがある場合だけ、復元処理中の表示へ切り替える。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAutoLoading(true);
    void coordinator
      .run(async (signal) => {
        const resolved = nip07Available
          ? { method: "extension" as const, provider: window.nostr! }
          : await resolveNostrProvider({ signal });
        await completeLogin(
          resolved.provider,
          resolved.method,
          signal,
          storedPubkey,
        );
      })
      .catch((error: unknown) => {
        if (!mounted || error instanceof LoginCancelledError) return;
        clearActiveSigner();
        removeStoredSession();
        setLoginError(error instanceof Error ? error.message : "自動ログインに失敗しました");
      })
      .finally(() => {
        if (mounted) setAutoLoading(false);
      });

    return () => {
      mounted = false;
      coordinator.cancel();
    };
  }, [completeLogin, nip07Available, pubkey]);

  const npub = useMemo(() => (pubkey ? nip19.npubEncode(pubkey) : null), [pubkey]);

  const login = useCallback(async () => {
    setLoginError(null);
    try {
      await coordinatorRef.current.run(async (signal) => {
        const provider = window.nostr;
        if (!provider || provider.isWnj) {
          throw new Error("NIP-07拡張が見つかりません");
        }
        await completeLogin(provider, "extension", signal);
      });
    } catch (error) {
      if (error instanceof LoginCancelledError) return;
      setLoginError(error instanceof Error ? error.message : "ログインに失敗しました");
    }
  }, [completeLogin]);

  const loginRemote = useCallback(async () => {
    setLoginError(null);
    setRemoteLoading(true);
    try {
      await coordinatorRef.current.run(async (signal) => {
        const resolved = await resolveNostrProvider({ signal });
        await completeLogin(resolved.provider, resolved.method, signal);
      });
    } catch (error) {
      if (!(error instanceof LoginCancelledError)) {
        setLoginError(error instanceof Error ? error.message : "NIP-46ログインに失敗しました");
      }
    } finally {
      setRemoteLoading(false);
    }
  }, [completeLogin]);

  const cancelLogin = useCallback(() => {
    coordinatorRef.current.cancel();
    closeRemoteSignerWidget();
    setRemoteLoading(false);
    setLoginError(null);
  }, []);

  const manageRemoteSigner = useCallback(() => {
    if (!openRemoteSignerWidget()) {
      setLoginError("リモート署名器の管理画面を開けませんでした");
    }
  }, []);

  const logout = useCallback(() => {
    coordinatorRef.current.cancel();
    clearActiveSigner();
    removeStoredSession();
    setPubkey(null);
    setLoginMethod(null);
    setAutoLoading(false);
    setRemoteLoading(false);
  }, []);

  // window.nostr.js のDisconnectはアプリへ通知しないため、接続情報の削除を監視する。
  useEffect(() => {
    if (!pubkey || loginMethod !== "remote") return;
    const timer = setInterval(() => {
      if (localStorage.getItem(REMOTE_POINTER_KEY)) return;
      coordinatorRef.current.cancel();
      clearActiveSigner();
      removeStoredSession();
      setPubkey(null);
      setLoginMethod(null);
      setLoginError("リモート署名器との接続が解除されました");
    }, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [loginMethod, pubkey]);

  useEffect(() => {
    const handleInvalidation = (event: Event) => {
      const message = (event as CustomEvent<string>).detail;
      removeStoredSession();
      setPubkey(null);
      setLoginMethod(null);
      setLoginError(message);
    };
    window.addEventListener("nostr-auth-invalidated", handleInvalidation);
    return () => window.removeEventListener("nostr-auth-invalidated", handleInvalidation);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      pubkey,
      npub,
      nip07Available,
      autoLoading,
      remoteLoading,
      loginError,
      loginMethod,
      login,
      loginRemote,
      manageRemoteSigner,
      cancelLogin,
      logout,
    }),
    [
      pubkey,
      npub,
      nip07Available,
      autoLoading,
      remoteLoading,
      loginError,
      loginMethod,
      login,
      loginRemote,
      manageRemoteSigner,
      cancelLogin,
      logout,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth は AuthProvider の中で使用してください");
  }
  return context;
}
