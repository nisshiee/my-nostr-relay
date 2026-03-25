import { useCallback, useEffect, useState } from "react";
import type { SimplePool } from "nostr-tools/pool";
import type { Event } from "nostr-tools/core";
import type { SubCloser } from "nostr-tools/abstract-pool";

/** contentが単一のUnicode絵文字かを判定する（Intl.Segmenter使用） */
function isUnicodeEmoji(content: string): boolean {
  if (content.length === 0) return false;
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  const segments = [...segmenter.segment(content)];
  if (segments.length !== 1) return false;
  // Extended_Pictographic: 一般的な絵文字、Regional_Indicator: 国旗、\u20e3: キーキャップ
  return /\p{Extended_Pictographic}/u.test(content) || /\p{Regional_Indicator}/u.test(content) || /\u20e3/u.test(content);
}

/** 最近使った絵文字として有効かを判定する（+, -, 空文字, :shortcode: を除外、Unicode絵文字のみ） */
function isValidRecentEmoji(content: string): boolean {
  // +, -, 空文字を除外
  if (content === "+" || content === "-" || content === "") return false;

  // :shortcode: 形式を除外
  if (content.startsWith(":") && content.endsWith(":") && content.length > 2) return false;

  // Unicode絵文字のみ対象
  return isUnicodeEmoji(content);
}

/**
 * 自分の最近のリアクションからユニークなUnicode絵文字をMRU順で取得するhook
 *
 * - kind:7の最新50件を取得し、oneose後にサブスクリプションを閉じる
 * - `+`, `-`, 空文字, `:shortcode:` 形式は除外
 * - 最大8個を返す
 * - `addEmoji` で楽観的にリストを更新できる
 */
export function useRecentEmojis(
  pool: SimplePool | null,
  relayUrls: string[],
  pubkey: string | null,
): { recentEmojis: string[]; addEmoji: (emoji: string) => void } {
  const [recentEmojis, setRecentEmojis] = useState<string[]>([]);

  useEffect(() => {
    if (!pool || relayUrls.length === 0 || !pubkey) return;

    let cancelled = false;
    let sub: SubCloser | null = null;

    const events: Event[] = [];

    sub = pool.subscribeMany(
      relayUrls,
      { kinds: [7], authors: [pubkey], limit: 50 },
      {
        onevent(event: Event) {
          if (cancelled) return;
          events.push(event);
        },
        oneose() {
          if (cancelled) return;

          // created_at降順でソート（MRU順）
          events.sort((a, b) => b.created_at - a.created_at);

          // ユニーク絵文字をMRU順で抽出
          const seen = new Set<string>();
          const emojis: string[] = [];

          for (const evt of events) {
            const content = evt.content;

            if (!isValidRecentEmoji(content)) continue;

            if (!seen.has(content)) {
              seen.add(content);
              emojis.push(content);
              if (emojis.length >= 8) break;
            }
          }

          if (!cancelled) {
            setRecentEmojis(emojis);
          }

          // oneose後にサブスクリプションを閉じる
          if (sub) {
            sub.close();
            sub = null;
          }
        },
      },
    );

    return () => {
      cancelled = true;
      if (sub) {
        try {
          sub.close();
        } catch {
          // 既に閉じている場合は無視
        }
        sub = null;
      }
    };
  }, [pool, relayUrls, pubkey]);

  const addEmoji = useCallback((emoji: string) => {
    if (!isValidRecentEmoji(emoji)) return;

    setRecentEmojis((prev) => {
      const filtered = prev.filter((e) => e !== emoji);
      return [emoji, ...filtered].slice(0, 8);
    });
  }, []);

  return { recentEmojis, addEmoji };
}
