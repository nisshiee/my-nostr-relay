"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { nip19 } from "nostr-tools";

/** 認証コンテキストの型 */
interface AuthContextValue {
  /** hex形式の公開鍵 */
  pubkey: string | null;
  /** npub形式（bech32）の公開鍵 */
  npub: string | null;
  /** NIP-07拡張の検出状態（null=検出中, true=利用可能, false=利用不可） */
  nip07Available: boolean | null;
  /** NIP-07拡張でログインする */
  login: () => Promise<void>;
  /** ログアウトする */
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/** NIP-07拡張の検出ポーリング間隔（ms） */
const POLL_INTERVAL = 500;
/** NIP-07拡張の検出タイムアウト（ms） */
const POLL_TIMEOUT = 3000;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [pubkey, setPubkey] = useState<string | null>(null);
  // 初回レンダリング時に window.nostr が既にあれば即座に検出（SSR時はnull）
  const [nip07Available, setNip07Available] = useState<boolean | null>(() => {
    if (typeof window !== "undefined" && window.nostr) {
      return true;
    }
    return null;
  });

  // NIP-07拡張の検出ロジック（まだ検出中の場合のみポーリングする）
  useEffect(() => {
    if (nip07Available !== null) return;

    // 拡張はDOMContentLoaded後に注入されることがあるため、ポーリングで検出する
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += POLL_INTERVAL;
      if (window.nostr) {
        setNip07Available(true);
        clearInterval(timer);
      } else if (elapsed >= POLL_TIMEOUT) {
        setNip07Available(false);
        clearInterval(timer);
      }
    }, POLL_INTERVAL);

    return () => clearInterval(timer);
  }, [nip07Available]);

  // pubkey を npub 形式に変換
  const npub = useMemo(() => {
    if (!pubkey) return null;
    return nip19.npubEncode(pubkey);
  }, [pubkey]);

  const login = useCallback(async () => {
    if (!window.nostr) {
      throw new Error("NIP-07拡張が見つかりません");
    }
    const pk = await window.nostr.getPublicKey();
    setPubkey(pk);
  }, []);

  const logout = useCallback(() => {
    setPubkey(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ pubkey, npub, nip07Available, login, logout }),
    [pubkey, npub, nip07Available, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** 認証コンテキストを使用するhook */
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth は AuthProvider の中で使用してください");
  }
  return context;
}
