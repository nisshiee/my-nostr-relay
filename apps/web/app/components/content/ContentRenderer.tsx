"use client";

import { parseContent, type ContentNode } from "../../lib/contentParser";
import { TextNode } from "./TextNode";
import { ImageNode } from "./ImageNode";
import { LinkNode } from "./LinkNode";
import { QuoteNode } from "./QuoteNode";
import type { ComponentType } from "react";

/**
 * ノードタイプ → レンダラーコンポーネントのマッピング
 * 新しいノードタイプを追加する場合はここに1行追加するだけでOK
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const NODE_RENDERERS: Record<ContentNode["type"], ComponentType<any>> = {
  text: TextNode,
  image: ImageNode,
  link: LinkNode,
  quote: QuoteNode,
};

interface ContentRendererProps {
  content: string;
  onHold?: () => void;
  onRelease?: () => void;
}

/** コンテンツをパースしてノードごとに適切なコンポーネントで描画する */
export function ContentRenderer({ content, onHold, onRelease }: ContentRendererProps) {
  const nodes = parseContent(content);

  // 画像URLリストを抽出
  const imageUrls = nodes
    .filter((n): n is Extract<ContentNode, { type: "image" }> => n.type === "image")
    .map((n) => n.url);

  // 各ノードに対応する画像インデックスを事前計算（画像以外は-1）
  let imgIdx = 0;
  const imageIndexMap = nodes.map((n) => (n.type === "image" ? imgIdx++ : -1));

  return (
    <div>
      {nodes.map((node, index) => {
        const Renderer = NODE_RENDERERS[node.type];
        // ノードのプロパティをそのままspreadで渡す（typeは除外）
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { type: _type, ...props } = node;
        // 画像ノードにはLightbox用の追加propsをマージ
        const extraProps =
          node.type === "image"
            ? { imageUrls, imageIndex: imageIndexMap[index], onHold, onRelease }
            : {};
        return <Renderer key={index} {...props} {...extraProps} />;
      })}
    </div>
  );
}
