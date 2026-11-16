"use client";

import { useCallback, useRef, useState } from "react";
import type { Event } from "nostr-tools/core";
import type { NostrProfile, Reactions } from "../lib/types";
import type { CustomEmoji, EmojiSet } from "../hooks/useCustomEmojis";
import type { RecentEmoji } from "../hooks/useRecentEmojis";
import { reactionKey } from "../lib/reactions";
import { ReactionBadges } from "./ReactionBadges";
import { EmojiPickerPopover } from "./EmojiPickerPopover";

export interface ProfileReactionsProps {
  reactions: Reactions;
  myPubkey: string;
  sendReaction: (eventId: string, pubkey: string, emoji: string, imageUrl?: string) => Promise<void>;
  recentEmojis: RecentEmoji[];
  emojiSets: EmojiSet[];
  looseEmojis: CustomEmoji[];
}

/** 署名・送信はHome経由の共通ハンドラに委譲する。 */
export function ProfileNoteReactions({ note, reactions, myPubkey, sendReaction,
  recentEmojis, emojiSets, looseEmojis, profiles, fetchProfiles,
}: ProfileReactionsProps & {
  note: Event;
  profiles: Map<string, NostrProfile>;
  fetchProfiles: (pubkeys: string[]) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const closePicker = useCallback(() => {
    setPickerOpen(false);
    trigger.current?.focus();
  }, []);
  const noteReactions = reactions.get(note.id);
  const react = async (emoji: string, imageUrl?: string) => {
    if (pending.current || noteReactions?.get(reactionKey(emoji, imageUrl))?.pubkeys.has(myPubkey)) return;
    pending.current = true;
    setSending(true);
    setError(null);
    try {
      await sendReaction(note.id, note.pubkey, emoji, imageUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "リアクションを送信できませんでした");
    } finally {
      pending.current = false;
      setSending(false);
    }
  };
  return (
    <div>
      <div className="flex flex-wrap items-end gap-2">
        <ReactionBadges reactions={noteReactions} myPubkey={myPubkey} profiles={profiles}
          fetchProfiles={fetchProfiles} disabled={sending}
          onReaction={(emoji, imageUrl) => { void react(emoji, imageUrl); }} />
        <button ref={trigger} type="button" disabled={sending}
          aria-label="リアクションを追加" aria-expanded={pickerOpen} aria-haspopup="dialog"
          onClick={() => setPickerOpen(open => !open)}
          className="mt-2 rounded-full border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700">
          {sending ? "送信中…" : "＋"}
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      <EmojiPickerPopover isOpen={pickerOpen} onClose={closePicker} anchorRef={trigger}
        onEmojiSelect={(emoji, imageUrl) => { void react(emoji, imageUrl); }}
        recentEmojis={recentEmojis} emojiSets={emojiSets} looseEmojis={looseEmojis} />
    </div>
  );
}
