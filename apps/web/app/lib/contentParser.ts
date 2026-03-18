/**
 * コンテンツパーサー
 * Nostrイベントのcontent文字列を構造化されたノードに分解する
 */

/** コンテンツノードの型定義（discriminated union） */
export type ContentNode =
  | { type: "text"; text: string }
  | { type: "image"; url: string };
// 今後追加予定: | { type: "link"; url: string } | { type: "video"; url: string } | { type: "ogp"; url: string; title: string }

/** 画像URLにマッチする正規表現パターン（パス途中の拡張子誤検出を防ぐため末尾に先読みを追加） */
const IMAGE_URL_PATTERN =
  /https?:\/\/[^\s]+\.(?:jpg|jpeg|png|gif|webp)(?:\?[^\s]*)?(?:#[^\s]*)?(?=\s|$)/gi;

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

    // マッチ前のテキスト部分を追加
    if (matchIndex > lastIndex) {
      const text = content.slice(lastIndex, matchIndex);
      if (text.length > 0) {
        nodes.push({ type: "text", text });
      }
    }

    // 画像ノードを追加
    nodes.push({ type: "image", url: matchedUrl });

    lastIndex = matchIndex + matchedUrl.length;
  }

  // 残りのテキスト部分を追加
  if (lastIndex < content.length) {
    const text = content.slice(lastIndex);
    if (text.length > 0) {
      nodes.push({ type: "text", text });
    }
  }

  return nodes;
}
