/** 画像ノードコンポーネント */

interface ImageNodeProps {
  url: string;
}

/** 画像を表示するノード（外部URLのため通常のimgタグを使用） */
export function ImageNode({ url }: ImageNodeProps) {
  return (
    <img
      src={url}
      alt="投稿画像"
      loading="lazy"
      className="my-2 max-w-full rounded-lg"
    />
  );
}
