/**
 * コンテンツパーサー
 * Nostrイベントのcontent文字列を構造化されたノードに分解する
 */

/** コンテンツノードの型定義（discriminated union） */
export type ContentNode =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "link"; url: string; text: string }
  | { type: "quote"; uri: string };
// 今後追加予定: | { type: "video"; url: string } | { type: "ogp"; url: string; title: string }

/** 画像URLにマッチする正規表現パターン（パス途中の拡張子誤検出を防ぐため末尾に先読みを追加） */
const IMAGE_URL_PATTERN =
  /https?:\/\/[^\s]+\.(?:jpg|jpeg|png|gif|webp)(?:\?[^\s]*)?(?:#[^\s]*)?(?=\s|$)/gi;

/** Nostr URIにマッチする正規表現パターン（nevent1, note1, naddr1） */
const NOSTR_URI_PATTERN = /nostr:(?:nevent1|note1|naddr1)[a-z0-9]+/gi;

/** 一般的なHTTP(S) URLにマッチする正規表現パターン */
const GENERAL_URL_PATTERN = /https?:\/\/[^\s<>「」『』【】（）\u3000-\u3002\uff01\uff0c\uff1b\uff1f]+/gi;

/**
 * URLを省略表示用テキストに変換する
 * - プロトコル（https://, http://）を除去
 * - 50文字を超える場合は末尾を「…」で省略
 */
function shortenUrl(url: string): string {
  const withoutProtocol = url.replace(/^https?:\/\//, "");
  const maxLength = 50;
  if (withoutProtocol.length <= maxLength) return withoutProtocol;
  return withoutProtocol.slice(0, maxLength - 1) + "…";
}

/**
 * URL末尾の句読点・括弧などを除去する
 * URL内部の同文字は保持し、末尾のみ除去
 */
function cleanUrlTrailing(url: string): string {
  return url.replace(/[)}\].,;:!?。、！？]+$/, "");
}

/**
 * テキスト内のNostr URIと一般URLを検出し、text/quote/linkノードに分割する
 * 画像マッチ後の残りテキストに対して使用する
 * 優先順: nostr URI → 一般 URL（重複区間は先にマッチした方が優先）
 */
function splitTextWithNostrAndLinks(text: string): ContentNode[] {
  // すべてのマッチを収集し、位置でソートする
  type MatchEntry =
    | { kind: "nostr"; index: number; length: number; uri: string }
    | { kind: "link"; index: number; length: number; url: string };

  const entries: MatchEntry[] = [];

  for (const match of text.matchAll(NOSTR_URI_PATTERN)) {
    entries.push({
      kind: "nostr",
      index: match.index,
      length: match[0].length,
      uri: match[0],
    });
  }

  for (const match of text.matchAll(GENERAL_URL_PATTERN)) {
    const rawUrl = match[0];
    const cleanedUrl = cleanUrlTrailing(rawUrl);

    if (!cleanedUrl || cleanedUrl === "https://" || cleanedUrl === "http://") {
      continue;
    }

    entries.push({
      kind: "link",
      index: match.index,
      length: cleanedUrl.length,
      url: cleanedUrl,
    });
  }

  // 位置順にソートし、nostr URIを優先（同一位置の場合）
  entries.sort((a, b) => a.index - b.index || (a.kind === "nostr" ? -1 : 1));

  // 重複区間を除去（先にマッチした方を優先）
  const filtered: MatchEntry[] = [];
  let occupiedUntil = 0;

  for (const entry of entries) {
    if (entry.index >= occupiedUntil) {
      filtered.push(entry);
      occupiedUntil = entry.index + entry.length;
    }
  }

  // ノードを構築
  const nodes: ContentNode[] = [];
  let lastIndex = 0;

  for (const entry of filtered) {
    // マッチ前のテキスト部分を追加
    if (entry.index > lastIndex) {
      const before = text.slice(lastIndex, entry.index);
      if (before.length > 0) {
        nodes.push({ type: "text", text: before });
      }
    }

    if (entry.kind === "nostr") {
      nodes.push({ type: "quote", uri: entry.uri });
    } else {
      nodes.push({ type: "link", url: entry.url, text: shortenUrl(entry.url) });
    }

    lastIndex = entry.index + entry.length;
  }

  // 残りのテキスト部分を追加
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex);
    if (remaining.length > 0) {
      nodes.push({ type: "text", text: remaining });
    }
  }

  return nodes;
}

/**
 * content文字列をパースし、ContentNode配列を返す
 *
 * - 画像URL（.jpg, .jpeg, .png, .gif, .webp で終わるHTTP(S) URL）を検出
 * - クエリパラメータ付きURLにも対応
 * - 空のtextノードは生成しない
 */
export function parseContent(content: string): ContentNode[] {
  if (!content) return [];

  const nodes: ContentNode[] = [];
  let lastIndex = 0;

  // matchAllを使うことでlastIndexの手動リセットが不要
  for (const match of content.matchAll(IMAGE_URL_PATTERN)) {
    const matchIndex = match.index;
    const matchedUrl = match[0];

    // マッチ前のテキスト部分を追加（nostr URI・URL検出を含む）
    if (matchIndex > lastIndex) {
      const text = content.slice(lastIndex, matchIndex);
      if (text.length > 0) {
        nodes.push(...splitTextWithNostrAndLinks(text));
      }
    }

    // 画像ノードを追加
    nodes.push({ type: "image", url: matchedUrl });

    lastIndex = matchIndex + matchedUrl.length;
  }

  // 残りのテキスト部分を追加（nostr URI・URL検出を含む）
  if (lastIndex < content.length) {
    const text = content.slice(lastIndex);
    if (text.length > 0) {
      nodes.push(...splitTextWithNostrAndLinks(text));
    }
  }

  return nodes;
}
