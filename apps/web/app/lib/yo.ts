import { validateEvent, type Event } from "nostr-tools/core";
import { verifyEvent } from "nostr-tools/pure";
import type { NostrEvent } from "../types/nostr";

export const YO_KIND = 7;
export const YO_CONTENT = ":yo:";
export const YO_EMOJI_URL = "https://nostr.nisshiee.org/yo.svg";
const HEX = /^[0-9a-f]{64}$/;
const SIG = /^[0-9a-f]{128}$/;

export function isYoPubkey(value: string): boolean {
  return HEX.test(value);
}

/** 署名器やリレーの検証済みマーカーに依存せず、表に出すフィールドだけで再検証する。 */
export function isVerifiedYoEvent(event: Event): boolean {
  if (!event || typeof event.id !== "string" || !HEX.test(event.id) ||
      typeof event.sig !== "string" || !SIG.test(event.sig) ||
      !Number.isSafeInteger(event.created_at) || event.created_at < 0 ||
      !Array.isArray(event.tags) || !event.tags.every(tag => Array.isArray(tag) && tag.every(value => typeof value === "string"))) return false;
  const { id, sig, kind, pubkey, content, created_at, tags } = event;
  const canonical = { id, sig, kind, pubkey, content, created_at, tags };
  return validateEvent(canonical) && verifyEvent(canonical);
}

export function isIncomingYo(event: Event, recipient: string, now = Math.floor(Date.now() / 1000)): boolean {
  if (!event || event.kind !== YO_KIND || event.content !== YO_CONTENT ||
      event.created_at > now + 600 || !Array.isArray(event.tags)) return false;
  const named = (name: string) => event.tags.filter(tag => Array.isArray(tag) && tag[0] === name);
  const [e, p, k, emoji, a] = ["e", "p", "k", "emoji", "a"].map(named);
  if (a.length || e.length !== 1 || p.length !== 1 || k.length !== 1 || emoji.length !== 1 ||
      !HEX.test(e[0][1]) || (e[0][3] && e[0][3] !== recipient) ||
      p[0][1] !== recipient || k[0][1] !== "0" || emoji[0][1] !== "yo") return false;
  const src = emoji[0][2];
  if (typeof src !== "string" || src.length > 2048 || !/^https:\/\//i.test(src)) return false;
  try {
    const url = new URL(src);
    if (url.protocol !== "https:" || url.username || url.password) return false;
  } catch {
    return false;
  }
  return isVerifiedYoEvent(event);
}

export function newestYoProfile(events: Event[], target: string): Event | undefined {
  return events.filter(event => event.kind === 0 && event.pubkey === target && isVerifiedYoEvent(event))
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
}

export function buildYo(profile: Event, now = Math.floor(Date.now() / 1000)): NostrEvent {
  return {
    kind: YO_KIND, content: YO_CONTENT, created_at: now,
    tags: [
      ["e", profile.id, "", profile.pubkey],
      ["p", profile.pubkey],
      ["k", "0"],
      ["emoji", "yo", YO_EMOJI_URL],
      ["t", "yo"],
    ],
  };
}

export function isExpectedSignedYo(event: Event, template: NostrEvent, sender: string): boolean {
  return !!event && event.pubkey === sender && event.kind === template.kind &&
    event.content === template.content && event.created_at === template.created_at &&
    isVerifiedYoEvent(event) && JSON.stringify(event.tags) === JSON.stringify(template.tags);
}
