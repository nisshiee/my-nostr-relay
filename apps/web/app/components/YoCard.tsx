"use client";

import { useState } from "react";
import { validateCanvasImageSource } from "../lib/canvasImagePolicy";
import type { NostrProfile, YoCard as YoCardType } from "../lib/types";
import Image, { MediaImage } from "./CanvasAwareImage";
import { relativeTime, resolveProfileDisplayName } from "./NoteCardContent";

interface YoCardProps {
  card: YoCardType;
  profile?: NostrProfile;
  onOpenProfile: (pubkey: string) => void;
}

function YoEmoji({ url }: { url?: string }) {
  const [status, setStatus] = useState<"pending" | "loaded" | "failed">("pending");
  const source = url && /^https:\/\//i.test(url) ? validateCanvasImageSource(url) : undefined;

  return (
    <div className="relative grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-purple-100 text-sm font-bold text-purple-800 dark:bg-purple-900/60 dark:text-purple-200">
      {status !== "loaded" && <span>Yo</span>}
      {source?.allowed && status !== "failed" && (
        <MediaImage
          src={source.url}
          alt="Yo"
          width={40}
          height={40}
          className={`absolute inset-0 h-full w-full object-contain${status === "loaded" ? "" : " invisible"}`}
          onLoad={() => setStatus("loaded")}
          onError={() => setStatus("failed")}
        />
      )}
    </div>
  );
}

export function YoCard({ card, profile, onOpenProfile }: YoCardProps) {
  const displayName = resolveProfileDisplayName(card.pubkey, profile);

  return (
    <div className="flex items-center gap-3 rounded-xl border border-purple-200 bg-white p-4 dark:border-purple-800 dark:bg-gray-800">
      <YoEmoji key={card.emojiUrl} url={card.emojiUrl} />
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
