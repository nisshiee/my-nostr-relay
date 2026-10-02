"use client";

import React from "react";
import { KeyRound } from "lucide-react";
import { StatusIndicator } from "./StatusIndicator";

interface CanvasHeaderProps {
  status: "connecting" | "loading" | "connected" | "error";
  npub: string | null;
  onAddDraft: () => void;
  onLogout: () => void;
  showSignerControl: boolean;
  onManageSigner: () => void;
}

/** npubを省略表示する */
function truncateNpub(npub: string): string {
  if (npub.length <= 20) return npub;
  return `${npub.slice(0, 12)}...${npub.slice(-8)}`;
}

/** キャンバスのヘッダー（タイトル、ステータス、投稿ボタン、npub表示、ログアウトボタン） */
export function CanvasHeader({ status, npub, onAddDraft, onLogout, showSignerControl, onManageSigner }: CanvasHeaderProps): React.ReactNode {
  return (
    <header className="flex shrink-0 items-center justify-between gap-2 border-b border-gray-200 bg-white px-3 py-3 sm:px-6 dark:border-gray-800 dark:bg-gray-900">
      <div className="flex min-w-0 items-center gap-2 sm:gap-4">
        <img src="/icon.svg" alt="" width={28} height={28} className="rounded-md" />
        <h1 className="hidden text-lg font-bold text-gray-900 sm:block dark:text-gray-100">
          Nostr Live Canvas
        </h1>
        <StatusIndicator status={status} />
      </div>
      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        <button
          type="button"
          onClick={onAddDraft}
          className="shrink-0 rounded-lg bg-purple-500 px-2.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-purple-600 sm:px-3"
          title="新規投稿 (n)"
        >
          ✏️ <span className="hidden sm:inline">投稿</span>
        </button>
        {npub && (
          <span
            className="hidden rounded bg-gray-100 px-2 py-1 font-mono text-xs text-gray-600 md:inline dark:bg-gray-800 dark:text-gray-400"
            title={npub}
          >
            {truncateNpub(npub)}
          </span>
        )}
        {showSignerControl && (
          <button
            type="button"
            onClick={onManageSigner}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-500 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            aria-label="リモート署名器を管理"
            title="リモート署名器を管理"
          >
            <KeyRound aria-hidden="true" size={14} />
            <span className="hidden sm:inline">署名器</span>
          </button>
        )}
        <button
          type="button"
          onClick={onLogout}
          className="shrink-0 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700 sm:px-3"
        >
          <span className="hidden sm:inline">ログアウト</span>
          <span className="sm:hidden" aria-hidden="true">退出</span>
        </button>
      </div>
    </header>
  );
}
