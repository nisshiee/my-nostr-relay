/** contentが単一のUnicode絵文字かを判定する（Intl.Segmenter使用） */
export function isUnicodeEmoji(content: string): boolean {
  if (content.length === 0) return false;
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  const segments = [...segmenter.segment(content)];
  if (segments.length !== 1) return false;
  // Extended_Pictographic: 一般的な絵文字、Regional_Indicator: 国旗、\u20e3: キーキャップ
  return /\p{Extended_Pictographic}/u.test(content) || /\p{Regional_Indicator}/u.test(content) || /\u20e3/u.test(content);
}

/** :shortcode: 形式のカスタム絵文字かを判定する */
export function isCustomEmojiShortcode(content: string): boolean {
  return /^:[^:\s]+:$/.test(content);
}

/** 最近使った絵文字として有効かを判定する（+, -, 空文字を除外、Unicode絵文字またはカスタム絵文字） */
export function isValidRecentEmoji(content: string): boolean {
  if (content === "+" || content === "-" || content === "") return false;
  return isUnicodeEmoji(content) || isCustomEmojiShortcode(content);
}

/** kind:7リアクションのcontentを集計用に正規化する。不正なcontentはnullを返す */
export function normalizeReactionContent(content: string): string | null {
  if (content === "+" || content === "") return "👍";
  if (content === "-") return "👎";
  if (isCustomEmojiShortcode(content) || isUnicodeEmoji(content)) return content;
  return null;
}
