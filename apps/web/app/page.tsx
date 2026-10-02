"use client";

import { useCallback, useRef } from "react";
import { useAuth } from "./contexts/AuthContext";
import { useNostrRelay } from "./hooks/useNostrRelay";
import { useThreadCards } from "./hooks/useThreadCards";
import { useRecentEmojis } from "./hooks/useRecentEmojis";
import { LiveCanvas } from "./components/LiveCanvas";

export default function Home() {
  const {
    pubkey,
    npub,
    nip07Available,
    autoLoading,
    remoteLoading,
    extensionLoading,
    loginError,
    loginMethod,
    login,
    loginRemote,
    cancelLogin,
    manageRemoteSigner,
    logout,
  } = useAuth();
  // eventId → slotId のマッピング（publish時に登録し、リレー到着時に参照する）
  const publishedSlotMapRef = useRef<Map<string, string>>(new Map());
  const {
    notes,
    profiles,
    reactions,
    status,
    relayUrls,
    pool,
    cache,
    emojiSets,
    looseEmojis,
    fetchProfiles,
    fetchUserRecentNotes,
    fetchHashtagNotes,
    publishEvent,
    sendReaction,
    sendRepost,
    isFollowing,
    follow,
    unfollow,
  } = useNostrRelay(pubkey, publishedSlotMapRef);
  const { filteredNotes, threadCards, isProcessing } = useThreadCards(notes, pubkey, relayUrls, pool, status, cache, publishedSlotMapRef);
  const { recentEmojis, addEmoji } = useRecentEmojis(pool, relayUrls, pubkey);

  const handleSendReaction = useCallback(
    async (targetEventId: string, targetPubkey: string, emoji: string, imageUrl?: string) => {
      addEmoji(emoji, imageUrl); // 楽観的に即座に更新
      await sendReaction(targetEventId, targetPubkey, emoji, imageUrl);
    },
    [sendReaction, addEmoji],
  );

  // 認証済み → LiveCanvas を全画面表示
  if (pubkey) {
    return (
      <LiveCanvas
        notes={filteredNotes}
        threadCards={threadCards}
        profiles={profiles}
        reactions={reactions}
        status={status}
        pubkey={pubkey}
        npub={npub}
        publishEvent={publishEvent}
        publishedSlotMapRef={publishedSlotMapRef}
        sendReaction={handleSendReaction}
        sendRepost={sendRepost}
        cache={cache}
        onLogout={logout}
        showSignerControl={loginMethod === "remote"}
        onManageSigner={manageRemoteSigner}
        isProcessing={isProcessing}
        recentEmojis={recentEmojis}
        emojiSets={emojiSets}
        looseEmojis={looseEmojis}
        fetchProfiles={fetchProfiles}
        fetchUserRecentNotes={fetchUserRecentNotes}
        fetchHashtagNotes={fetchHashtagNotes}
        isFollowing={isFollowing}
        follow={follow}
        unfollow={unfollow}
      />
    );
  }

  // 未認証 → ログインUI
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-zinc-950">
      <main className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-8 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
        <img src="/icon.svg" alt="Nostr Live Canvas" width={48} height={48} className="mx-auto mb-2" />
        <h1 className="mb-6 text-center text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          Nostr Live Canvas
        </h1>

        {/* 自動ログインまたは署名器接続中 */}
        {(autoLoading || remoteLoading || extensionLoading) && (
          <div className="flex flex-col items-center gap-4 py-8">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-zinc-300 border-t-purple-500 dark:border-zinc-600 dark:border-t-purple-400" />
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              {remoteLoading
                ? "リモート署名器への接続を待っています..."
                : extensionLoading
                  ? "ブラウザ拡張へ接続しています..."
                  : "自動ログイン中..."}
            </p>
            {remoteLoading && (
              <>
                <p className="text-center text-xs text-zinc-500 dark:text-zinc-400">
                  表示された画面のQRコードをスマートフォンの署名器で読み取るか、
                  bunker URLを入力してください。
                </p>
                <button
                  type="button"
                  onClick={cancelLogin}
                  className="rounded-lg border border-zinc-300 px-4 py-2 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  接続をキャンセル
                </button>
              </>
            )}
            {extensionLoading && (
              <button
                type="button"
                onClick={cancelLogin}
                className="rounded-lg border border-zinc-300 px-4 py-2 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                接続をキャンセル
              </button>
            )}
          </div>
        )}

        {/* ログイン方法は拡張検出を待たずに表示する */}
        {!autoLoading && !remoteLoading && !extensionLoading && (
          <div className="flex flex-col items-center gap-4 py-6">
            <p className="text-center text-sm text-zinc-600 dark:text-zinc-400">
              スマートフォンなどのNIP-46対応署名器ですぐに接続できます。
            </p>
            <button
              type="button"
              onClick={loginRemote}
              className="w-full rounded-lg bg-purple-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-purple-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-500 dark:bg-purple-500 dark:hover:bg-purple-600"
            >
              リモート署名器でログイン
            </button>
            <div className="my-2 flex w-full items-center gap-3 text-xs text-zinc-400">
              <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-700" />
              またはブラウザ拡張
              <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-700" />
            </div>
            <button
              type="button"
              onClick={login}
              className="w-full rounded-lg border border-zinc-300 px-6 py-3 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-500 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              ブラウザ拡張でログイン
              {nip07Available === true && (
                <span className="ml-2 text-xs font-normal text-green-600 dark:text-green-400">
                  検出済み
                </span>
              )}
            </button>
            <p className="text-center text-xs text-zinc-400 dark:text-zinc-500">
              NIP-07拡張はボタンを押したときに接続します。
            </p>
          </div>
        )}

        {loginError && !autoLoading && !remoteLoading && !extensionLoading && (
          <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {loginError}
          </p>
        )}
      </main>
    </div>
  );
}
