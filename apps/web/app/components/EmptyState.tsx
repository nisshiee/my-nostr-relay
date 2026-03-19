import React from "react";

interface EmptyStateProps {
  status: "connecting" | "loading" | "connected" | "error";
  hasNotes: boolean;
  isProcessing: boolean;
}

/** 空状態・ローディング・エラーの表示（排他的: 最初にマッチした状態のみ表示）。何も表示しない場合は null を返す */
export function EmptyState({ status, hasNotes, isProcessing }: EmptyStateProps): React.ReactNode | null {
  if (status === "connecting" && !hasNotes) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-purple-400 border-t-transparent" />
          <p className="text-gray-500 dark:text-gray-400">
            リレーに接続中...
          </p>
        </div>
      </div>
    );
  }

  if (status === "loading" && !hasNotes) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-blue-400 border-t-transparent" />
          <p className="text-gray-500 dark:text-gray-400">
            ノートを読み込み中...
          </p>
        </div>
      </div>
    );
  }

  if (status === "error" && !hasNotes) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <p className="mb-2 text-lg text-red-500">⚠️ 接続エラー</p>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            リレーへの接続に失敗しました。再接続を試みています...
          </p>
        </div>
      </div>
    );
  }

  if (isProcessing) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-blue-400 border-t-transparent" />
          <p className="text-gray-500 dark:text-gray-400">
            ノートを読み込み中...
          </p>
        </div>
      </div>
    );
  }

  return null;
}
