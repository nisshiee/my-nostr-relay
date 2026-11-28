"use client";

import { ArrowUpRight } from "lucide-react";
import { useRef, useState } from "react";
import { validateCanvasImageSource } from "../lib/canvasImagePolicy";
import type { NostrProfile, YoCard as YoCardType } from "../lib/types";
import Image, { MediaImage } from "./CanvasAwareImage";
import { relativeTime, resolveProfileDisplayName } from "./NoteCardContent";

interface YoCardProps {
  card: YoCardType;
  profile?: NostrProfile;
  onOpenProfile: (pubkey: string) => void;
  onSendYo?: (pubkey: string) => Promise<void>;
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

function YoReply({ sender, name, send }: {
  sender: string;
  name: string;
  send: NonNullable<YoCardProps["onSendYo"]>;
}) {
  const [status, setStatus] = useState<"idle" | "pending" | "sent" | "failed">("idle");
  const sending = useRef(false);

  async function reply() {
    if (sending.current || status === "sent") return;
    sending.current = true;
    setStatus("pending");
    try {
      await send(sender);
      setStatus("sent");
    } catch {
      setStatus("failed");
    } finally {
      sending.current = false;
    }
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-0.5 self-end">
      <span role="status" className="sr-only">
        {status === "pending" ? "Yoを送信中" : status === "sent" ? "Yoを送りました" : ""}
      </span>
      {status === "failed" && (
        <span role="alert" className="whitespace-nowrap text-xs leading-3 text-red-700 dark:text-red-300">
          送信できませんでした
        </span>
      )}
      <button
        type="button"
        onClick={reply}
        disabled={status === "pending" || status === "sent"}
        aria-label={status === "idle" || status === "failed" ? `${name}にYoを返す` : undefined}
        className="shrink-0 cursor-pointer rounded-full border border-purple-200 px-3 py-1 text-xs leading-3 font-semibold whitespace-nowrap text-purple-800 hover:bg-purple-100 focus-visible:outline-2 focus-visible:outline-purple-500 disabled:cursor-default disabled:opacity-70 dark:border-purple-700 dark:text-purple-200 dark:hover:bg-purple-900/60"
      >
        {status === "pending" ? "送信中…" : status === "sent" ? "送信済み" : "Yoを返す"}
      </button>
    </div>
  );
}

export function YoCard({ card, profile, onOpenProfile, onSendYo }: YoCardProps) {
  const outgoing = card.direction === "outgoing";
  const participant = outgoing ? card.recipientPubkey : card.pubkey;
  const displayName = resolveProfileDisplayName(participant, profile);

  return (
    <div className="flex items-center gap-3 rounded-xl border border-purple-200 bg-purple-50 p-4 dark:border-purple-800 dark:bg-[#282039]">
      <div className="relative shrink-0">
        <YoEmoji key={card.emojiUrl} url={card.emojiUrl} />
        {outgoing && (
          <span
            role="img"
            aria-label="送信済み"
            className="pointer-events-none absolute -right-1.5 -bottom-0.5 grid size-5 place-items-center rounded-full border-2 border-purple-50 bg-purple-100 text-purple-800 dark:border-[#282039] dark:bg-purple-900 dark:text-purple-200"
          >
            <ArrowUpRight aria-hidden="true" className="size-3.5" strokeWidth={2.5} />
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => onOpenProfile(participant)}
          aria-label={`${outgoing ? "送信先：" : ""}${displayName}のプロフィールを開く`}
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
      {!outgoing && onSendYo && <YoReply key={card.eventId} sender={card.pubkey} name={displayName} send={onSendYo} />}
    </div>
  );
}
