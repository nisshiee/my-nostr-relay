"use client";

import { useRef, useEffect } from "react";
import Image from "next/image";
import type { CanvasNote, NostrProfile } from "../lib/types";

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

interface NoteCardProps {
  note: CanvasNote;
  profile?: NostrProfile;
  onHeightChange?: (id: string, height: number) => void;
}

export function NoteCard({ note, profile, onHeightChange }: NoteCardProps) {
  const displayName =
    profile?.display_name || profile?.name || shortenPubkey(note.pubkey);
  const avatarUrl = profile?.picture;
  const cardRef = useRef<HTMLDivElement>(null);

  // ResizeObserver でカードの高さを測定して親に通知
  useEffect(() => {
    const el = cardRef.current;
    if (!el || !onHeightChange) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        onHeightChange(note.id, entry.borderBoxSize[0].blockSize);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [note.id, onHeightChange]);

  return (
    <div
      ref={cardRef}
      className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 hover:shadow-md dark:hover:shadow-gray-900/50"
    >
      {/* ヘッダー: アバター + 名前 + 時刻 */}
      <div className="flex items-center gap-3 mb-2">
        {/* アバター */}
        {avatarUrl ? (
          <Image
            src={avatarUrl}
            alt={displayName}
            width={32}
            height={32}
            className="h-8 w-8 shrink-0 rounded-full object-cover"
            unoptimized
          />
        ) : (
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-400 to-blue-500 flex items-center justify-center flex-shrink-0">
            <span className="text-white text-xs font-bold">
              {displayName.charAt(0).toUpperCase()}
            </span>
          </div>
        )}

        {/* 名前と時刻 */}
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
            {displayName}
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {relativeTime(note.created_at)}
          </span>
        </div>
      </div>

      {/* テキスト内容 */}
      <p className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap break-words leading-relaxed">
        {note.content}
      </p>
    </div>
  );
}
