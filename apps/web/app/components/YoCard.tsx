"use client";

import type { NostrProfile, YoCard as YoCardType } from "../lib/types";
import Image from "./CanvasAwareImage";
import { relativeTime, resolveProfileDisplayName } from "./NoteCardContent";

interface YoCardProps {
  card: YoCardType;
  profile?: NostrProfile;
  onOpenProfile: (pubkey: string) => void;
}

export function YoCard({ card, profile, onOpenProfile }: YoCardProps) {
  const displayName = resolveProfileDisplayName(card.pubkey, profile);

  return (
    <div className="flex items-center gap-3 rounded-xl border border-purple-200 bg-white p-4 dark:border-purple-800 dark:bg-gray-800">
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-purple-100 text-sm font-bold text-purple-800 dark:bg-purple-900/60 dark:text-purple-200">
        Yo
      </div>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => onOpenProfile(card.pubkey)}
          aria-label={`${displayName}のプロフィールを開く`}
          className="flex max-w-full items-center gap-1.5 rounded-sm text-left text-sm font-semibold text-gray-900 hover:text-purple-700 focus-visible:outline-2 focus-visible:outline-purple-500 dark:text-gray-100 dark:hover:text-purple-300"
        >
          {profile?.picture && (
            <Image
              src={profile.picture}
              alt=""
              width={20}
              height={20}
              className="h-5 w-5 shrink-0 rounded-full object-cover"
              unoptimized
            />
          )}
          <span className="truncate">{displayName}</span>
        </button>
        <time
          dateTime={new Date(card.created_at * 1000).toISOString()}
          className="block text-xs text-gray-500 dark:text-gray-400"
        >
          {relativeTime(card.created_at)}
        </time>
      </div>
    </div>
  );
}
