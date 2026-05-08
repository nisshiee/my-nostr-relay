"use client";

interface HashtagNodeProps {
  tag: string;
  text: string;
  onHashtagClick?: (tag: string) => void;
}

/** NIP-24 hashtag node */
export function HashtagNode({ tag, text, onHashtagClick }: HashtagNodeProps) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onHashtagClick?.(tag);
      }}
      className="inline cursor-pointer p-0 text-sm text-blue-600 hover:underline dark:text-blue-400"
    >
      {text}
    </button>
  );
}
