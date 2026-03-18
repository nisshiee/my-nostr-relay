"use client";

import { useAuth } from "./contexts/AuthContext";
import { useNostrRelay } from "./hooks/useNostrRelay";
import { LiveCanvas } from "./components/LiveCanvas";

export default function Home() {
  const { pubkey, npub, nip07Available, autoLoading, login, logout } = useAuth();
  const { notes, profiles, reactions, status, publishEvent, patchNoteSlotId } = useNostrRelay(pubkey);

  // 認証済み → LiveCanvas を全画面表示
  if (pubkey) {
    return (
      <LiveCanvas
        notes={notes}
        profiles={profiles}
        reactions={reactions}
        status={status}
        pubkey={pubkey}
        npub={npub}
        publishEvent={publishEvent}
        patchNoteSlotId={patchNoteSlotId}
        onLogout={logout}
      />
    );
  }

  // 未認証 → ログインUI
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-zinc-950">
      <main className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-8 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="mb-6 text-center text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          Nostr Relay
        </h1>

        {/* 自動ログイン中 */}
        {autoLoading && (
          <div className="flex flex-col items-center gap-4 py-8">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-zinc-300 border-t-purple-500 dark:border-zinc-600 dark:border-t-purple-400" />
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              自動ログイン中...
            </p>
          </div>
        )}

        {/* 検出中 */}
        {!autoLoading && nip07Available === null && (
          <div className="flex flex-col items-center gap-4 py-8">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-zinc-300 border-t-purple-500 dark:border-zinc-600 dark:border-t-purple-400" />
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              NIP-07拡張を検出中...
            </p>
          </div>
        )}

        {/* 未認証 + NIP-07あり */}
        {!autoLoading && nip07Available === true && (
          <div className="flex flex-col items-center gap-4 py-8">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              NIP-07拡張が検出されました
            </p>
            <button
              onClick={login}
              className="rounded-lg bg-purple-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-purple-700 dark:bg-purple-500 dark:hover:bg-purple-600"
            >
              Nostrでログイン
            </button>
          </div>
        )}

        {/* 未認証 + NIP-07なし */}
        {!autoLoading && nip07Available === false && (
          <div className="flex flex-col items-center gap-4 py-8">
            <p className="mb-2 text-sm text-zinc-600 dark:text-zinc-400">
              NIP-07対応のブラウザ拡張が必要です。
              <br />
              以下のいずれかをインストールしてください：
            </p>
            <ul className="flex flex-col gap-2 text-sm">
              <li>
                <a
                  href="https://github.com/fiatjaf/nos2x"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-purple-600 underline hover:text-purple-700 dark:text-purple-400 dark:hover:text-purple-300"
                >
                  nos2x
                </a>
              </li>
              <li>
                <a
                  href="https://getalby.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-purple-600 underline hover:text-purple-700 dark:text-purple-400 dark:hover:text-purple-300"
                >
                  Alby
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/susumuota/nostr-keyx"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-purple-600 underline hover:text-purple-700 dark:text-purple-400 dark:hover:text-purple-300"
                >
                  nostr-keyx
                </a>
              </li>
            </ul>
            <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
              インストール後、ページをリロードしてください。
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
