"use client";

import { useRef, useEffect } from "react";
import { EmojiPicker } from "frimousse";

interface EmojiPickerPopoverProps {
  /** ポップオーバーの開閉状態 */
  isOpen: boolean;
  /** ポップオーバーを閉じるハンドラ */
  onClose: () => void;
  /** 絵文字が選択されたときのハンドラ */
  onEmojiSelect: (emoji: string) => void;
}

/** 絵文字ピッカーポップオーバーコンポーネント */
export function EmojiPickerPopover({
  isOpen,
  onClose,
  onEmojiSelect,
}: EmojiPickerPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);

  // ピッカー外クリックで閉じる
  useEffect(() => {
    if (!isOpen) return;

    const handleMouseDown = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };

    // Escapeキーで閉じる
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      ref={popoverRef}
      className="absolute bottom-full mb-2 z-50 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg"
      style={{ width: "min(320px, 90vw)", maxHeight: "320px" }}
      onClick={(e) => e.stopPropagation()}
    >
      <EmojiPicker.Root
        locale="ja"
        onEmojiSelect={(emoji) => {
          onEmojiSelect(emoji.emoji);
          onClose();
        }}
      >
        <EmojiPicker.Search
          placeholder="絵文字を検索..."
          className="w-full px-3 py-2 text-sm border-b border-gray-200 dark:border-gray-700 bg-transparent outline-none text-gray-900 dark:text-gray-100 placeholder-gray-400"
        />
        <EmojiPicker.Viewport className="h-[280px]">
          <EmojiPicker.Loading>読み込み中...</EmojiPicker.Loading>
          <EmojiPicker.Empty>見つかりません</EmojiPicker.Empty>
          <EmojiPicker.List
            components={{
              CategoryHeader: ({ category, ...props }) => (
                <div
                  {...props}
                  className="px-3 py-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400 sticky top-0 bg-white dark:bg-gray-800"
                >
                  {category.label}
                </div>
              ),
              Row: ({ children, ...props }) => (
                <div {...props} className="flex px-1">
                  {children}
                </div>
              ),
              Emoji: ({ emoji, ...props }) => (
                <button
                  {...props}
                  type="button"
                  className="flex items-center justify-center w-8 h-8 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-xl cursor-pointer"
                >
                  {emoji.emoji}
                </button>
              ),
            }}
          />
        </EmojiPicker.Viewport>
      </EmojiPicker.Root>
    </div>
  );
}
