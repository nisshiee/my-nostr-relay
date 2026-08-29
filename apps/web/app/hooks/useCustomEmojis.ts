import { useEffect, useState } from "react";
import type { SimplePool } from "nostr-tools/pool";
import type { Event } from "nostr-tools/core";
import type { SubCloser } from "nostr-tools/abstract-pool";

export interface CustomEmoji {
  shortcode: string;
  url: string;
}

export interface EmojiSet {
  id: string; // kind 30030 の d タグ
  name: string; // title タグ > d タグ
  icon?: string; // image タグ
  emojis: CustomEmoji[];
}

export interface UseCustomEmojisResult {
  emojiSets: EmojiSet[];
  looseEmojis: CustomEmoji[];
}

const EMPTY_EMOJI_SETS: EmojiSet[] = [];
const EMPTY_LOOSE_EMOJIS: CustomEmoji[] = [];

/**
 * ログインユーザーのカスタム絵文字パレット（NIP-51 kind 10030）を購読し、
 * 参照されている絵文字セット（kind 30030）を解決するhook
 *
 * - kind 10030 の emoji タグ → looseEmojis
 * - kind 10030 の a タグ (30030:<pubkey>:<d-tag>) → 各 kind 30030 を購読 → emojiSets
 * - oneose後にサブスクリプションを閉じる
 */
export function useCustomEmojis(
  pool: SimplePool | null,
  relayUrls: string[],
  pubkey: string | null,
): UseCustomEmojisResult {
  const [emojiSets, setEmojiSets] = useState<EmojiSet[]>(EMPTY_EMOJI_SETS);
  const [looseEmojis, setLooseEmojis] = useState<CustomEmoji[]>(
    EMPTY_LOOSE_EMOJIS,
  );

  useEffect(() => {
    if (!pool || relayUrls.length === 0 || !pubkey) return;

    let cancelled = false;
    let paletteSub: SubCloser | null = null;
    let setsSub: SubCloser | null = null;

    const paletteEvents: Event[] = [];

    paletteSub = pool.subscribeMany(
      relayUrls,
      { kinds: [10030], authors: [pubkey] },
      {
        onevent(event: Event) {
          if (cancelled) return;
          paletteEvents.push(event);
        },
        oneose() {
          if (cancelled) return;

          const latestPalette = paletteEvents.sort((a, b) => b.created_at - a.created_at)[0];
          if (!latestPalette) {
            setLooseEmojis(EMPTY_LOOSE_EMOJIS);
            setEmojiSets(EMPTY_EMOJI_SETS);
            if (paletteSub) {
              paletteSub.close();
              paletteSub = null;
            }
            return;
          }

          const loose: CustomEmoji[] = [];
          const setRefs: { pubkey: string; dTag: string }[] = [];

          for (const tag of latestPalette.tags) {
            if (tag[0] === "emoji" && tag[1] && tag[2]) {
              loose.push({ shortcode: tag[1], url: tag[2] });
            } else if (tag[0] === "a" && tag[1]) {
              const parts = tag[1].split(":");
              if (parts.length >= 3 && parts[0] === "30030") {
                const dTag = parts.slice(2).join(":");
                if (parts[1] && dTag) {
                  setRefs.push({ pubkey: parts[1], dTag });
                }
              }
            }
          }

          setLooseEmojis(loose.length > 0 ? loose : EMPTY_LOOSE_EMOJIS);

          if (setRefs.length === 0) {
            setEmojiSets(EMPTY_EMOJI_SETS);
            if (paletteSub) {
              paletteSub.close();
              paletteSub = null;
            }
            return;
          }

          const resolvedSets = new Map<string, EmojiSet>();
          const allAuthors = [...new Set(setRefs.map((ref) => ref.pubkey))];
          const allDTags = [...new Set(setRefs.map((ref) => ref.dTag))];
          const validRefs = new Set(setRefs.map((ref) => `${ref.pubkey}:${ref.dTag}`));

          setsSub = pool.subscribeMany(
            relayUrls,
            {
              kinds: [30030],
              authors: allAuthors,
              "#d": allDTags,
            },
            {
              onevent(setEvent: Event) {
                if (cancelled) return;

                const dTag = setEvent.tags.find((t) => t[0] === "d")?.[1] ?? "";
                if (!dTag || !validRefs.has(`${setEvent.pubkey}:${dTag}`)) return;

                const titleTag = setEvent.tags.find((t) => t[0] === "title")?.[1];
                const imageTag = setEvent.tags.find((t) => t[0] === "image")?.[1];
                const emojis: CustomEmoji[] = [];

                for (const tag of setEvent.tags) {
                  if (tag[0] === "emoji" && tag[1] && tag[2]) {
                    emojis.push({ shortcode: tag[1], url: tag[2] });
                  }
                }

                resolvedSets.set(`${setEvent.pubkey}:${dTag}`, {
                  id: dTag,
                  name: titleTag || dTag,
                  icon: imageTag,
                  emojis,
                });
              },
              oneose() {
                if (cancelled) return;
                const sets = Array.from(resolvedSets.values());
                setEmojiSets(sets.length > 0 ? sets : EMPTY_EMOJI_SETS);

                if (setsSub) {
                  setsSub.close();
                  setsSub = null;
                }
              },
            },
          );

          if (paletteSub) {
            paletteSub.close();
            paletteSub = null;
          }
        },
      },
    );

    return () => {
      cancelled = true;
      if (paletteSub) {
        try {
          paletteSub.close();
        } catch {
          // 既に閉じている場合は無視
        }
        paletteSub = null;
      }
      if (setsSub) {
        try {
          setsSub.close();
        } catch {
          // 既に閉じている場合は無視
        }
        setsSub = null;
      }
    };
  }, [pool, relayUrls, pubkey]);

  return { emojiSets, looseEmojis };
}
