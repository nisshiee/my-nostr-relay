/** リンクノードコンポーネント */

interface LinkNodeProps {
  url: string;
  text: string;
}

/** URLをクリック可能なリンクとして表示するノード */
export function LinkNode({ url, text }: LinkNodeProps) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="text-sm text-blue-600 dark:text-blue-400 hover:underline break-all"
    >
      {text}
    </a>
  );
}
