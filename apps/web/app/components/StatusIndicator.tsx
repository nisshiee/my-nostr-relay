import React from "react";

interface StatusIndicatorProps {
  status: "connecting" | "loading" | "connected" | "error";
}

/** 接続ステータスのインジケーター表示 */
export function StatusIndicator({ status }: StatusIndicatorProps): React.ReactNode {
  switch (status) {
    case "connecting":
      return (
        <div className="flex items-center gap-2 text-yellow-500">
          <div className="h-2 w-2 animate-pulse rounded-full bg-yellow-500" />
          <span className="text-xs">接続中...</span>
        </div>
      );
    case "loading":
      return (
        <div className="flex items-center gap-2 text-blue-500">
          <div className="h-2 w-2 animate-pulse rounded-full bg-blue-500" />
          <span className="text-xs">読み込み中...</span>
        </div>
      );
    case "connected":
      return (
        <div className="flex items-center gap-2 text-green-500">
          <div className="h-2 w-2 rounded-full bg-green-500" />
          <span className="text-xs">接続済み</span>
        </div>
      );
    case "error":
      return (
        <div className="flex items-center gap-2 text-red-500">
          <div className="h-2 w-2 rounded-full bg-red-500" />
          <span className="text-xs">接続エラー</span>
        </div>
      );
  }
}
