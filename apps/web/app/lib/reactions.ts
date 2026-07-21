import type { Event } from "nostr-tools/core";
import type { Reactions } from "./types";

export function normalizeReactionContent(content: string): string {
  if (content === "+" || content === "") return "👍";
  if (content === "-") return "👎";
  return content;
}

function isCustomEmoji(emoji: string): boolean {
  return emoji.startsWith(":") && emoji.endsWith(":") && emoji.length > 2;
}

export function extractCustomEmojiUrl(emoji: string, tags: string[][]): string | undefined {
  if (!isCustomEmoji(emoji)) return undefined;
  const shortcode = emoji.slice(1, -1);
  return tags.find((tag) => tag[0] === "emoji" && tag[1] === shortcode && tag[2])?.[2];
}

/** JSON tuple prevents collisions between Unicode and custom emoji key components. */
export function reactionKey(emoji: string, imageUrl?: string): string {
  return isCustomEmoji(emoji)
    ? JSON.stringify(["custom", emoji, imageUrl ?? null])
    : JSON.stringify(["unicode", emoji]);
}

/** Add one event without mutating the previous aggregation. */
export function aggregateReactionEvent(reactions: Reactions, event: Event): Reactions {
  const eTags = event.tags.filter((tag) => tag[0] === "e" && tag[1]);
  if (eTags.length === 0) return reactions;

  const targetEventId = eTags[eTags.length - 1]![1]!;
  const emoji = normalizeReactionContent(event.content);
  const imageUrl = extractCustomEmojiUrl(emoji, event.tags);
  const key = reactionKey(emoji, imageUrl);
  const next = new Map(reactions);
  const eventReactions = new Map(next.get(targetEventId));
  const existing = eventReactions.get(key);

  if (existing) {
    const pubkeys = new Set(existing.pubkeys);
    pubkeys.add(event.pubkey);
    eventReactions.set(key, { ...existing, count: existing.count + 1, pubkeys });
  } else {
    eventReactions.set(key, { emoji, count: 1, imageUrl, pubkeys: new Set([event.pubkey]) });
  }
  next.set(targetEventId, eventReactions);
  return next;
}
