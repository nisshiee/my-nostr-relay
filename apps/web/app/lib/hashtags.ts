/** NIP-24 hashtag utilities */

/**
 * ハッシュタグ終端文字。
 * 空白・改行・句読点・括弧・URL区切り文字などでタグを終了する。
 */
const HASHTAG_TERMINATOR_PATTERN = /[\s\u3000.,;:!?。、，．！？；：「」『』（）()\[\]{}<>〈〉《》【】…‥、/\\|"'`“”‘’#?&=]/u;

/** タグ開始条件: 本文先頭、または直前が空白文字 */
function isValidHashtagStart(text: string, hashIndex: number): boolean {
  return hashIndex === 0 || /\s/u.test(text[hashIndex - 1]);
}

/** NIP-24検索用にタグを正規化する（英字部分をlowercase、先頭#は除去） */
export function normalizeHashtag(tag: string): string {
  return tag.replace(/^#+/u, "").toLocaleLowerCase();
}

export interface HashtagMatch {
  /** 正規化済みタグ（event.tagsのt tag/search filterに使う） */
  tag: string;
  /** content内の開始位置（#を含む） */
  index: number;
  /** content内の長さ（#を含む） */
  length: number;
  /** content内の元表記（#を含む） */
  text: string;
}

/**
 * 本文からNIP-24用ハッシュタグを抽出する。
 * - 開始: # が本文先頭、または直前が空白文字
 * - 終端: 空白、改行、句読点、括弧、URL区切り文字など
 * - #単体、URL fragment、abc#tag は除外
 * - 英字部分はlowercase、重複は初出順で排除
 */
export function findHashtagMatches(text: string): HashtagMatch[] {
  const matches: HashtagMatch[] = [];

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "#" || !isValidHashtagStart(text, index)) {
      continue;
    }

    let end = index + 1;
    while (end < text.length && !HASHTAG_TERMINATOR_PATTERN.test(text[end])) {
      end += 1;
    }

    if (end === index + 1) {
      continue;
    }

    const rawText = text.slice(index, end);
    const tag = normalizeHashtag(rawText);
    if (!tag) {
      continue;
    }

    matches.push({ tag, index, length: rawText.length, text: rawText });
    index = end - 1;
  }

  return matches;
}

/** 投稿用: 重複排除済みの正規化タグを返す */
export function extractHashtags(text: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];

  for (const match of findHashtagMatches(text)) {
    if (seen.has(match.tag)) {
      continue;
    }
    seen.add(match.tag);
    tags.push(match.tag);
  }

  return tags;
}

/** event.tags から重複排除済みの正規化済み t tag を取り出す */
export function extractEventHashtags(tags?: string[][]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const tag of tags ?? []) {
    if (tag[0] !== "t" || !tag[1]) {
      continue;
    }

    const normalized = normalizeHashtag(tag[1]);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}
