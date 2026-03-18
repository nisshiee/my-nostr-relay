"use client";

import { parseContent, type ContentNode } from "../../lib/contentParser";
import { TextNode } from "./TextNode";
import { ImageNode } from "./ImageNode";
import type { ComponentType } from "react";

/**
 * ノードタイプ → レンダラーコンポーネントのマッピング
 * 新しいノードタイプを追加する場合はここに1行追加するだけでOK
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const NODE_RENDERERS: Record<ContentNode["type"], ComponentType<any>> = {
  text: TextNode,
  image: ImageNode,
  // 将来: link: LinkNode, video: VideoNode, ogp: OgpNode, ...
};

interface ContentRendererProps {
  content: string;
}

/** コンテンツをパースしてノードごとに適切なコンポーネントで描画する */
export function ContentRenderer({ content }: ContentRendererProps) {
  const nodes = parseContent(content);

  return (
    <div>
      {nodes.map((node, index) => {
        const Renderer = NODE_RENDERERS[node.type];
        // ノードのプロパティをそのままspreadで渡す（typeは除外）
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { type: _type, ...props } = node;
        return <Renderer key={index} {...props} />;
      })}
    </div>
  );
}
