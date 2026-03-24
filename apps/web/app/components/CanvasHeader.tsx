"use client";

import React from "react";
import { StatusIndicator } from "./StatusIndicator";

interface CanvasHeaderProps {
  status: "connecting" | "loading" | "connected" | "error";
  npub: string | null;
  onAddDraft: () => void;
  onLogout: () => void;
}

/** npubを省略表示する */
function truncateNpub(npub: string): string {
  if (npub.length <= 20) return npub;
  return `${npub.slice(0, 12)}...${npub.slice(-8)}`;
}

/** キャンバスのヘッダー（タイトル、ステータス、投稿ボタン、npub表示、ログアウトボタン） */
export function CanvasHeader({ status, npub, onAddDraft, onLogout }: CanvasHeaderProps): React.ReactNode {
  return (
    <header className="flex shrink-0 items-center justify-between border-b border-gray-200 bg-white px-6 py-3 dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-center gap-4">
        <img src="/icon.svg" alt="" width={28} height={28} className="rounded-md" />
        <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">
          Nostr Live Canvas
        </h1>
        <StatusIndicator status={status} />
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onAddDraft}
          className="rounded-lg bg-purple-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-600 transition-colors"
          title="新規投稿 (n)"
        >
          ✏️ 投稿
        </button>
        {npub && (
          <span
            className="rounded bg-gray-100 px-2 py-1 font-mono text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400"
            title={npub}
          >
            {truncateNpub(npub)}
          </span>
        )}
        <button
          type="button"
          onClick={onLogout}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          ログアウト
        </button>
      </div>
    </header>
  );
}
