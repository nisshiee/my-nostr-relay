"use client";

import { useEffect, useState, useMemo } from "react";
import Image from "next/image";
import useCanvasStore from "../../store";
import { useProfile, useEvent } from "../../store/selectors";
import { parseNostrUri } from "../../lib/nip19";

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

/** npubの省略表示を生成 */
function shortenPubkey(pubkey: string): string {
  if (pubkey.length <= 12) return pubkey;
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
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

/** nostr: URI をテキストから除去する */
function stripNostrUris(text: string): string {
  return text.replace(/nostr:(?:nevent1|note1|naddr1|npub1|nprofile1)[a-z0-9]+/gi, "").trim();
}

/** テキストを指定文字数でtruncateする */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "…";
}

/** njump.me のURLを生成する */
function njumpUrl(nostrUri: string): string {
  // "nostr:" プレフィックスを除去してnjump.meに渡す
  const identifier = nostrUri.replace(/^nostr:/, "");
  return `https://njump.me/${identifier}`;
}

/** URI をデコードして eventId / relayHints を抽出する（純粋関数） */
function decodeUri(nostrUri: string): {
  eventId: string;
  relayHints: string[];
} | null {
  const decoded = parseNostrUri(nostrUri);
  if (!decoded || decoded.type === "naddr") return null;
  const eventId = decoded.data.eventId;
  const relayHints =
    decoded.type === "nevent" && decoded.data.relays
      ? decoded.data.relays
      : [];
  return { eventId, relayHints };
}

// ---------------------------------------------------------------------------
// コンポーネント
// ---------------------------------------------------------------------------

interface QuoteNodeProps {
  /** nostr: URI 文字列（例: "nostr:nevent1..."） */
  uri: string;
}

/** 引用ノートをカード形式で表示するコンポーネント */
export function QuoteNode({ uri }: QuoteNodeProps) {
  const decoded = useMemo(() => decodeUri(uri), [uri]);
  const eventId = decoded?.eventId ?? "";

  // Store セレクター
  const event = useCanvasStore(useEvent(eventId));
  const eventPubkey = event?.pubkey ?? "";
  const profileRaw = useCanvasStore(useProfile(eventPubkey));
  const profile = event ? profileRaw : undefined;
  const fetchQuoted = useCanvasStore((s) => s.fetchQuoted);

  // フェッチ状態: "idle" | "loading" | "done" | "error"
  // effect 内で同期的に setState("loading") を呼ぶことを避けるため、
  // fetchQuoted の Promise チェーン内のコールバックでのみ setState する。
  const [fetchState, setFetchState] = useState<"idle" | "loading" | "done" | "error">(
    // 初期値: decoded があり event がなければ即 loading 開始予定
    decoded && !event ? "loading" : "idle",
  );

  useEffect(() => {
    if (!decoded || event) return; // 既にキャッシュにあればスキップ
    if (fetchState !== "loading") return; // idle / done / error ならスキップ

    let cancelled = false;

    fetchQuoted(decoded.eventId, decoded.relayHints).then((result) => {
      if (!cancelled) {
        setFetchState(result ? "done" : "error");
      }
    });

    return () => { cancelled = true; };
  }, [decoded, event, fetchState, fetchQuoted]);

  const linkUrl = njumpUrl(uri);
  const loading = fetchState === "loading" && !event;

  // ローディング中
  if (loading) {
    return (
      <a
        href={linkUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="block my-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700/50 p-3 animate-pulse"
      >
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-gray-200 dark:bg-gray-600" />
          <div className="h-3 w-24 rounded bg-gray-200 dark:bg-gray-600" />
        </div>
        <div className="mt-2 h-3 w-full rounded bg-gray-200 dark:bg-gray-600" />
        <div className="mt-1 h-3 w-2/3 rounded bg-gray-200 dark:bg-gray-600" />
      </a>
    );
  }

  // エラー or イベント取得失敗 → URIをリンクとして表示
  if (!event) {
    return (
      <a
        href={linkUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="block my-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700/50 p-3 text-sm text-blue-600 dark:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors break-all"
      >
        {uri}
      </a>
    );
  }

  // 正常表示
  const displayName =
    profile?.display_name || profile?.name || shortenPubkey(event.pubkey);
  const avatarUrl = profile?.picture;
  const strippedContent = stripNostrUris(event.content);
  const excerpt = truncateText(strippedContent, 140);

  return (
    <a
      href={linkUrl}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="block my-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700/50 p-3 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
    >
      {/* ヘッダー: アバター + 名前 + 時刻 */}
      <div className="flex items-center gap-2 mb-1.5">
        {avatarUrl ? (
          <Image
            src={avatarUrl}
            alt={displayName}
            width={24}
            height={24}
            className="h-6 w-6 shrink-0 rounded-full object-cover"
            unoptimized
          />
        ) : (
          <div className="w-6 h-6 rounded-full bg-gradient-to-br from-purple-400 to-blue-500 flex items-center justify-center flex-shrink-0">
            <span className="text-white text-[10px] font-bold">
              {displayName.charAt(0).toUpperCase()}
            </span>
          </div>
        )}
        <span className="text-xs font-semibold text-gray-900 dark:text-gray-100 truncate">
          {displayName}
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">
          {relativeTime(event.created_at)}
        </span>
      </div>

      {/* テキスト抜粋 */}
      {excerpt && (
        <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-words leading-relaxed line-clamp-3">
          {excerpt}
        </p>
      )}
    </a>
  );
}
