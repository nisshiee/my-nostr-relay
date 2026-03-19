"use client";

import Image from "next/image";
import { useQuotedEvent } from "../../hooks/useQuotedEvent";
import { SimplePool } from "nostr-tools/pool";

interface QuoteNodeProps {
  uri: string;
  pool: SimplePool | null;
  relayUrls: string[];
}

/** 相対時刻を表示する（"3分前", "1時間前" など） */
function relativeTime(unixTimestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diffSec = now - unixTimestamp;

  const rtf = new Intl.RelativeTimeFormat("ja", { numeric: "auto" });

  if (diffSec < 60) {
    return rtf.format(-diffSec, "second");
  } else if (diffSec < 3600) {
    return rtf.format(-Math.floor(diffSec / 60), "minute");
  } else if (diffSec < 86400) {
    return rtf.format(-Math.floor(diffSec / 3600), "hour");
  } else {
    return rtf.format(-Math.floor(diffSec / 86400), "day");
  }
}

/** テキストコンテンツからnostr: URIを除去し、指定文字数でtruncateする */
function cleanAndTruncateText(content: string, maxLength = 140): string {
  // nostr: URIを除去
  const cleaned = content.replace(/nostr:[a-z0-9]+/gi, "").trim();
  
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  
  return cleaned.slice(0, maxLength - 1) + "…";
}

/** 引用ノートを表示するコンポーネント */
export function QuoteNode({ uri, pool, relayUrls }: QuoteNodeProps) {
  const { event, profile, loading, error } = useQuotedEvent(uri, pool, relayUrls);

  // njump.me リンクを作成
  const njumpUrl = `https://njump.me/${uri.replace(/^nostr:/, "")}`;

  // クリックハンドラー
  const handleClick = () => {
    window.open(njumpUrl, "_blank", "noopener,noreferrer");
  };

  // ローディング状態
  if (loading) {
    return (
      <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 bg-gray-50 dark:bg-gray-800 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-750 transition-colors">
        <div className="flex items-center space-x-2">
          <div className="w-6 h-6 bg-gray-300 dark:bg-gray-600 rounded-full animate-pulse" />
          <div className="h-4 bg-gray-300 dark:bg-gray-600 rounded w-24 animate-pulse" />
        </div>
        <div className="mt-2 space-y-1">
          <div className="h-3 bg-gray-300 dark:bg-gray-600 rounded w-full animate-pulse" />
          <div className="h-3 bg-gray-300 dark:bg-gray-600 rounded w-3/4 animate-pulse" />
        </div>
      </div>
    );
  }

  // エラー状態またはデータが取得できない場合のフォールバック
  if (error || !event) {
    return (
      <a
        href={njumpUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 underline break-all"
      >
        {uri}
      </a>
    );
  }

  // 表示名の決定
  const displayName = profile?.display_name || profile?.name || "Anonymous";
  
  // アバター画像のURL
  const avatarUrl = profile?.picture || "";
  
  // テキスト抜粋を作成
  const textExcerpt = cleanAndTruncateText(event.content);

  // 相対タイムスタンプ
  const timeText = relativeTime(event.created_at);

  return (
    <div
      onClick={handleClick}
      className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 bg-gray-50 dark:bg-gray-800 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-750 transition-colors"
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      }}
    >
      {/* ヘッダー（アバター + 表示名 + タイムスタンプ） */}
      <div className="flex items-center space-x-2 mb-2">
        <div className="relative w-6 h-6 flex-shrink-0">
          {avatarUrl ? (
            <Image
              src={avatarUrl}
              alt={`${displayName}のアバター`}
              fill
              className="rounded-full object-cover"
              sizes="24px"
              onError={(e) => {
                // エラー時はデフォルト画像を表示
                const target = e.target as HTMLImageElement;
                target.style.display = "none";
              }}
            />
          ) : (
            <div className="w-6 h-6 bg-gray-300 dark:bg-gray-600 rounded-full flex items-center justify-center">
              <span className="text-xs text-gray-600 dark:text-gray-400">
                {displayName.charAt(0).toUpperCase()}
              </span>
            </div>
          )}
        </div>
        <span className="font-medium text-sm text-gray-900 dark:text-gray-100 truncate">
          {displayName}
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">
          {timeText}
        </span>
      </div>

      {/* テキスト抜粋 */}
      {textExcerpt && (
        <div className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
          {textExcerpt}
        </div>
      )}

      {/* 引用インジケーター */}
      <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
        引用されたノート
      </div>
    </div>
  );
}