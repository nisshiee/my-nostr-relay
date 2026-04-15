"use client";

import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import Image from "next/image";
import { ContentRenderer } from "./content/ContentRenderer";
import type { EventCache } from "../hooks/useEventCache";
import type { NostrProfile } from "../lib/types";

export interface NoteCardContentNote {
  pubkey: string;
  content: string;
  created_at: number;
  tags: string[][];
  repostInfo?: {
    reposterPubkey: string;
    repostedAt: number;
  };
}

export function shortenPubkey(pubkey: string): string {
  if (pubkey.length <= 12) return pubkey;
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}

export function relativeTime(unixTimestamp: number): string {
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

export function resolveProfileDisplayName(
  pubkey: string,
  profile?: NostrProfile,
): string {
  return profile?.display_name || profile?.name || shortenPubkey(pubkey);
}

interface NoteCardContentProps {
  note: NoteCardContentNote;
  profile?: NostrProfile;
  reposterProfile?: NostrProfile;
  replyToName?: string | null;
  variant?: "default" | "compact";
  onHold?: () => void;
  onRelease?: () => void;
  cache?: EventCache;
  profiles?: Map<string, NostrProfile>;
  onProfileClick?: (pubkey: string, event: ReactMouseEvent | ReactKeyboardEvent) => void;
}

export function NoteCardContent({
  note,
  profile,
  reposterProfile,
  replyToName,
  variant = "default",
  onHold,
  onRelease,
  cache,
  profiles,
  onProfileClick,
}: NoteCardContentProps) {
  const isCompact = variant === "compact";
  const displayName = resolveProfileDisplayName(note.pubkey, profile);
  const reposterName = note.repostInfo
    ? resolveProfileDisplayName(note.repostInfo.reposterPubkey, reposterProfile)
    : undefined;
  const avatarUrl = profile?.picture;

  const avatarButtonClass = isCompact
    ? "h-6 w-6 shrink-0 rounded-full"
    : "h-8 w-8 shrink-0 rounded-full";

  return (
    <>
      {replyToName && isCompact && (
        <div className="text-[11px] text-gray-400 dark:text-gray-500 mb-0.5 ml-8">
          ↩ {replyToName}
        </div>
      )}

      {note.repostInfo && !isCompact && (
        <div className="mb-2 text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
          <span>🔁</span>
          <span>{reposterName}がリポスト</span>
        </div>
      )}

      <div className={`flex items-center ${isCompact ? "gap-2 mb-1" : "gap-3 mb-2"}`}>
        {onProfileClick ? (
          <button
            type="button"
            onClick={(event) => onProfileClick(note.pubkey, event)}
            className={`${avatarButtonClass} rounded-full transition-opacity hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-purple-400`}
            aria-label={`${displayName}のプロフィールを開く`}
          >
            {avatarUrl ? (
              <Image
                src={avatarUrl}
                alt={displayName}
                width={isCompact ? 24 : 32}
                height={isCompact ? 24 : 32}
                className={isCompact
                  ? "h-6 w-6 shrink-0 rounded-full object-cover"
                  : "h-8 w-8 shrink-0 rounded-full object-cover"}
                unoptimized
              />
            ) : (
              <div className={isCompact
                ? "w-6 h-6 rounded-full bg-gradient-to-br from-purple-400 to-blue-500 flex items-center justify-center flex-shrink-0"
                : "w-8 h-8 rounded-full bg-gradient-to-br from-purple-400 to-blue-500 flex items-center justify-center flex-shrink-0"}
              >
                <span className={isCompact ? "text-white text-[10px] font-bold" : "text-white text-xs font-bold"}>
                  {displayName.charAt(0).toUpperCase()}
                </span>
              </div>
            )}
          </button>
        ) : avatarUrl ? (
          <Image
            src={avatarUrl}
            alt={displayName}
            width={isCompact ? 24 : 32}
            height={isCompact ? 24 : 32}
            className={isCompact
              ? "h-6 w-6 shrink-0 rounded-full object-cover"
              : "h-8 w-8 shrink-0 rounded-full object-cover"}
            unoptimized
          />
        ) : (
          <div className={isCompact
            ? "w-6 h-6 rounded-full bg-gradient-to-br from-purple-400 to-blue-500 flex items-center justify-center flex-shrink-0"
            : "w-8 h-8 rounded-full bg-gradient-to-br from-purple-400 to-blue-500 flex items-center justify-center flex-shrink-0"}
          >
            <span className={isCompact ? "text-white text-[10px] font-bold" : "text-white text-xs font-bold"}>
              {displayName.charAt(0).toUpperCase()}
            </span>
          </div>
        )}

        {isCompact ? (
          <div className="flex items-baseline gap-1.5 min-w-0 flex-1">
            {onProfileClick ? (
              <button
                type="button"
                onClick={(event) => onProfileClick(note.pubkey, event)}
                className="min-w-0 truncate text-left text-xs font-semibold text-gray-900 transition-colors hover:text-purple-600 focus:outline-none focus:ring-2 focus:ring-purple-400 dark:text-gray-100 dark:hover:text-purple-400"
              >
                {displayName}
              </button>
            ) : (
              <span className="text-xs font-semibold text-gray-900 dark:text-gray-100 truncate">
                {displayName}
              </span>
            )}
            <span className="text-[11px] text-gray-400 dark:text-gray-500 flex-shrink-0">
              {relativeTime(note.created_at)}
            </span>
          </div>
        ) : (
          <div className="flex flex-col min-w-0 flex-1">
            {onProfileClick ? (
              <button
                type="button"
                onClick={(event) => onProfileClick(note.pubkey, event)}
                className="truncate text-left text-sm font-semibold text-gray-900 transition-colors hover:text-purple-600 focus:outline-none focus:ring-2 focus:ring-purple-400 dark:text-gray-100 dark:hover:text-purple-400"
              >
                {displayName}
              </button>
            ) : (
              <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                {displayName}
              </span>
            )}
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {relativeTime(note.created_at)}
            </span>
          </div>
        )}
      </div>

      <div className={isCompact ? "ml-8 text-sm" : undefined}>
        <ContentRenderer
          content={note.content}
          onHold={onHold}
          onRelease={onRelease}
          cache={cache}
          profiles={profiles}
          tags={note.tags}
        />
      </div>
    </>
  );
}
