"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { EmojiPicker } from "frimousse";

interface EmojiPickerPopoverProps {
  /** ポップオーバーの開閉状態 */
  isOpen: boolean;
  /** ポップオーバーを閉じるハンドラ */
  onClose: () => void;
  /** 絵文字が選択されたときのハンドラ */
  onEmojiSelect: (emoji: string) => void;
  /** ピッカーのアンカー要素（位置計算用） */
  anchorRef: React.RefObject<HTMLElement | null>;
}

/** 絵文字ピッカーポップオーバーコンポーネント（Portal描画） */
export function EmojiPickerPopover({
  isOpen,
  onClose,
  onEmojiSelect,
  anchorRef,
}: EmojiPickerPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number; placement: "above" | "below" }>({ top: 0, left: 0, placement: "above" });

  /** アンカー要素の位置からポップオーバーの位置を計算する（上下自動切り替え） */
  const updatePosition = useCallback(() => {
    if (!anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const pickerWidth = Math.min(320, window.innerWidth * 0.9);
    const pickerHeight = 320; // maxHeight と同じ
    const gap = 8; // アンカーとの間隔

    // 左端の調整
    let left = rect.left;
    if (left + pickerWidth > window.innerWidth - 8) {
      left = window.innerWidth - pickerWidth - 8;
    }
    if (left < 8) left = 8;

    // 上に十分なスペースがあれば上に、なければ下に表示
    const spaceAbove = rect.top;
    const placement = spaceAbove >= pickerHeight + gap ? "above" : "below";

    if (placement === "above") {
      setPosition({
        top: rect.top + window.scrollY - gap,
        left: left + window.scrollX,
        placement,
      });
    } else {
      setPosition({
        top: rect.bottom + window.scrollY + gap,
        left: left + window.scrollX,
        placement,
      });
    }
  }, [anchorRef]);

  // 検索ボックスに自動フォーカス
  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => {
        searchRef.current?.focus();
      });
    }
  }, [isOpen]);

  // ピッカー外クリックで閉じる
  useEffect(() => {
    if (!isOpen) return;

    updatePosition();

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

    // スクロール・リサイズ時に位置を更新
    const handleScroll = () => updatePosition();

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [isOpen, onClose, updatePosition]);

  if (!isOpen) return null;

  return createPortal(
    <div
      ref={popoverRef}
      className="fixed flex flex-col overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg"
      data-emoji-picker-popover
      style={{
        width: "min(320px, 90vw)",
        maxHeight: "320px",
        top: position.top,
        left: position.left,
        transform: position.placement === "above" ? "translateY(-100%)" : undefined,
        zIndex: 9999,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex px-3 py-1.5 border-b border-gray-200 dark:border-gray-700">
        {["🎉", "😢", "😇"].map((emoji) => (
          <button
            key={emoji}
            type="button"
            aria-label={emoji}
            className="flex items-center justify-center w-8 h-8 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-xl cursor-pointer"
            onClick={() => {
              onEmojiSelect(emoji);
              onClose();
            }}
          >
            {emoji}
          </button>
        ))}
      </div>
      <EmojiPicker.Root
        locale="en"
        onEmojiSelect={(emoji) => {
          onEmojiSelect(emoji.emoji);
          onClose();
        }}
      >
        <EmojiPicker.Search
          ref={searchRef}
          placeholder="絵文字を検索..."
          className="w-full px-3 py-2 text-sm border-b border-gray-200 dark:border-gray-700 bg-transparent outline-none text-gray-900 dark:text-gray-100 placeholder-gray-400"
        />
        <EmojiPicker.Viewport className="h-[230px]">
          <EmojiPicker.Loading className="flex items-center justify-center h-full text-sm text-gray-400 dark:text-gray-500">読み込み中...</EmojiPicker.Loading>
          <EmojiPicker.Empty className="flex items-center justify-center h-full text-sm text-gray-400 dark:text-gray-500">見つかりません</EmojiPicker.Empty>
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
    </div>,
    document.body,
  );
}
