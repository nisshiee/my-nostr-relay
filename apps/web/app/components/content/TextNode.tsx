/** テキストノードコンポーネント */

interface TextNodeProps {
  text: string;
}

/** テキストを表示するノード（NoteCardの既存スタイルを維持） */
export function TextNode({ text }: TextNodeProps) {
  return (
    <span className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap break-words leading-relaxed">
      {text}
    </span>
  );
}
