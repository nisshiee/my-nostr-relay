/** カスタム絵文字ノードコンポーネント */

interface EmojiNodeProps {
  shortcode: string;
  url: string;
}

/** NIP-30 カスタム絵文字をインライン画像として表示する */
export function EmojiNode({ shortcode, url }: EmojiNodeProps) {
  return (
    <img
      src={url}
      alt={`:${shortcode}:`}
      title={`:${shortcode}:`}
      className="inline-block h-5 w-5 align-text-bottom object-contain"
    />
  );
}
