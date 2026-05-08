/**
 * コンテンツパーサー
 * Nostrイベントのcontent文字列を構造化されたノードに分解する
 */

/** コンテンツノードの型定義（discriminated union） */
export type ContentNode =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "linkPreview"; url: string; text: string }
  | { type: "link"; url: string; text: string }
  | { type: "quote"; uri: string }
  | { type: "emoji"; shortcode: string; url: string };
// 今後追加予定: | { type: "video"; url: string }

/** 画像URLにマッチする正規表現パターン（パス途中の拡張子誤検出を防ぐため末尾に先読みを追加） */
const IMAGE_URL_PATTERN =
  /https?:\/\/[^\s]+\.(?:jpg|jpeg|png|gif|webp)(?:\?[^\s]*)?(?:#[^\s]*)?(?=\s|$)/gi;

/** 引用ノートのNostr URIにマッチする正規表現パターン（nevent1, note1, naddr1） */
const NOSTR_QUOTE_URI_PATTERN = /nostr:(?:nevent1|note1|naddr1)[a-z0-9]+/gi;

/** メンションのNostr URIにマッチする正規表現パターン（npub1, nprofile1） */
const NOSTR_MENTION_URI_PATTERN = /nostr:(?:npub1|nprofile1)[a-z0-9]+/gi;

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
function splitTextWithNostrAndLinks(
  text: string,
  state: { linkPreviewUsed: boolean },
): ContentNode[] {
  // すべてのマッチを収集し、位置でソートする
  type MatchEntry =
    | { kind: "nostr"; index: number; length: number; uri: string }
    | { kind: "mention"; index: number; length: number; uri: string }
    | { kind: "link"; index: number; length: number; url: string };

  const entries: MatchEntry[] = [];

  for (const match of text.matchAll(NOSTR_QUOTE_URI_PATTERN)) {
    entries.push({
      kind: "nostr",
      index: match.index,
      length: match[0].length,
      uri: match[0],
    });
  }

  for (const match of text.matchAll(NOSTR_MENTION_URI_PATTERN)) {
    entries.push({
      kind: "mention",
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
    } else if (entry.kind === "mention") {
      // npub/nprofile → njump.me へのリンクとして表示
      const identifier = entry.uri.replace(/^nostr:/, "");
      const shortId = identifier.length > 16
        ? `${identifier.slice(0, 12)}…${identifier.slice(-4)}`
        : identifier;
      nodes.push({ type: "link", url: `https://njump.me/${identifier}`, text: `@${shortId}` });
    } else if (!state.linkPreviewUsed) {
      state.linkPreviewUsed = true;
      nodes.push({ type: "linkPreview", url: entry.url, text: shortenUrl(entry.url) });
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
 * textノード内の :shortcode: パターンを検出し、emojiMapに存在すればemojiノードに分割する
 */
function splitTextWithEmoji(
  nodes: ContentNode[],
  emojiMap: Map<string, string>,
): ContentNode[] {
  const result: ContentNode[] = [];
  const emojiPattern = /:([\w-]+):/g;

  for (const node of nodes) {
    if (node.type !== "text") {
      result.push(node);
      continue;
    }

    let lastIdx = 0;
    let match: RegExpExecArray | null;
    emojiPattern.lastIndex = 0;

    while ((match = emojiPattern.exec(node.text)) !== null) {
      const shortcode = match[1];
      const url = emojiMap.get(shortcode);
      if (!url) continue;

      // マッチ前のテキスト
      if (match.index > lastIdx) {
        result.push({ type: "text", text: node.text.slice(lastIdx, match.index) });
      }

      result.push({ type: "emoji", shortcode, url });
      lastIdx = match.index + match[0].length;
    }

    // 残りのテキスト
    if (lastIdx < node.text.length) {
      result.push({ type: "text", text: node.text.slice(lastIdx) });
    } else if (lastIdx === 0) {
      // マッチなし: 元のノードをそのまま追加
      result.push(node);
    }
  }

  return result;
}

/**
 * content文字列をパースし、ContentNode配列を返す
 *
 * - 画像URL（.jpg, .jpeg, .png, .gif, .webp で終わるHTTP(S) URL）を検出
 * - クエリパラメータ付きURLにも対応
 * - 空のtextノードは生成しない
 * - tagsにemojiタグが含まれていれば、:shortcode: をカスタム絵文字ノードに変換する（NIP-30）
 */
export function parseContent(content: string, tags?: string[][]): ContentNode[] {
  if (!content) return [];

  // tagsからemojiマップを構築
  const emojiMap = new Map<string, string>();
  if (tags) {
    for (const tag of tags) {
      if (tag[0] === "emoji" && tag[1] && tag[2]) {
        emojiMap.set(tag[1], tag[2]);
      }
    }
  }

  const nodes: ContentNode[] = [];
  let lastIndex = 0;
  const parserState = { linkPreviewUsed: false };

  // matchAllを使うことでlastIndexの手動リセットが不要
  for (const match of content.matchAll(IMAGE_URL_PATTERN)) {
    const matchIndex = match.index;
    const matchedUrl = match[0];

    // マッチ前のテキスト部分を追加（nostr URI・URL検出を含む）
    if (matchIndex > lastIndex) {
      const text = content.slice(lastIndex, matchIndex);
      if (text.length > 0) {
        nodes.push(...splitTextWithNostrAndLinks(text, parserState));
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
      nodes.push(...splitTextWithNostrAndLinks(text, parserState));
    }
  }

  // カスタム絵文字の後処理（emojiMapが空でない場合のみ）
  if (emojiMap.size > 0) {
    return splitTextWithEmoji(nodes, emojiMap);
  }

  return nodes;
}
