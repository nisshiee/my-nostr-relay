"use client";

import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { EmojiPicker } from "frimousse";
import type { CustomEmoji, EmojiSet } from "../hooks/useCustomEmojis";
import type { RecentEmoji } from "../hooks/useRecentEmojis";

interface EmojiPickerPopoverProps {
  isOpen: boolean;
  onClose: () => void;
  onEmojiSelect: (emoji: string, imageUrl?: string) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  recentEmojis?: RecentEmoji[];
  emojiSets?: EmojiSet[];
  looseEmojis?: CustomEmoji[];
}

function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400 sticky top-0 bg-white dark:bg-gray-800">
      {children}
    </div>
  );
}

function CustomEmojiButton({
  emoji,
  onSelect,
}: {
  emoji: CustomEmoji;
  onSelect: (emoji: string, imageUrl?: string) => void;
}) {
  return (
    <button
      type="button"
      title={`:${emoji.shortcode}:`}
      onClick={() => onSelect(`:${emoji.shortcode}:`, emoji.url)}
      className="flex items-center justify-center w-8 h-8 rounded hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer"
    >
      <img
        src={emoji.url}
        alt={`:${emoji.shortcode}:`}
        className="w-5 h-5 object-contain"
        referrerPolicy="no-referrer"
      />
    </button>
  );
}

function RecentEmojiButton({
  recent,
  onSelect,
}: {
  recent: RecentEmoji;
  onSelect: (emoji: string, imageUrl?: string) => void;
}) {
  if (recent.imageUrl) {
    return (
      <button
        type="button"
        title={recent.emoji}
        onClick={() => onSelect(recent.emoji, recent.imageUrl)}
        className="flex items-center justify-center w-8 h-8 rounded hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer"
      >
        <img
          src={recent.imageUrl}
          alt={recent.emoji}
          className="w-5 h-5 object-contain"
          referrerPolicy="no-referrer"
        />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(recent.emoji)}
      className="flex items-center justify-center w-8 h-8 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-xl cursor-pointer"
    >
      {recent.emoji}
    </button>
  );
}

function EmojiPickerContent({
  onClose,
  onEmojiSelect,
  recentEmojis = [],
  emojiSets = [],
  looseEmojis = [],
}: {
  onClose: () => void;
  onEmojiSelect: (emoji: string, imageUrl?: string) => void;
  recentEmojis?: RecentEmoji[];
  emojiSets?: EmojiSet[];
  looseEmojis?: CustomEmoji[];
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    requestAnimationFrame(() => {
      searchRef.current?.focus();
    });
  }, []);

  const allCustomEmojis = useMemo(() => {
    const merged = new Map<string, CustomEmoji>();

    for (const set of emojiSets) {
      for (const emoji of set.emojis) {
        merged.set(`${emoji.shortcode}:${emoji.url}`, emoji);
      }
    }

    for (const emoji of looseEmojis) {
      merged.set(`${emoji.shortcode}:${emoji.url}`, emoji);
    }

    return Array.from(merged.values());
  }, [emojiSets, looseEmojis]);

  const filteredCustomEmojis = useMemo(() => {
    if (search === "") return [];
    const query = search.toLowerCase();
    return allCustomEmojis.filter((emoji) => emoji.shortcode.toLowerCase().includes(query));
  }, [allCustomEmojis, search]);

  const handleSelect = useCallback(
    (emoji: string, imageUrl?: string) => {
      onEmojiSelect(emoji, imageUrl);
      onClose();
    },
    [onClose, onEmojiSelect],
  );

  return (
    <EmojiPicker.Root
      locale="en"
      onEmojiSelect={(emoji) => {
        handleSelect(emoji.emoji);
      }}
    >
      <EmojiPicker.Search
        ref={searchRef}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="絵文字を検索..."
        className="w-full px-3 py-2 text-sm border-b border-gray-200 dark:border-gray-700 bg-transparent outline-none text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500"
      />
      <EmojiPicker.Viewport className="h-[280px]">
        <EmojiPicker.Loading className="flex items-center justify-center h-full text-sm text-gray-400 dark:text-gray-500">
          読み込み中...
        </EmojiPicker.Loading>
        <EmojiPicker.Empty className="flex items-center justify-center h-full text-sm text-gray-400 dark:text-gray-500">
          見つかりません
        </EmojiPicker.Empty>

        {search === "" && recentEmojis.length > 0 && (
          <div>
            <SectionHeader>最近使った絵文字</SectionHeader>
            <div className="flex flex-wrap px-1">
              {recentEmojis.map((recent) => (
                <RecentEmojiButton key={`${recent.emoji}:${recent.imageUrl ?? ""}`} recent={recent} onSelect={handleSelect} />
              ))}
            </div>
          </div>
        )}

        {search === "" && emojiSets.map((set) => (
          <div key={set.id}>
            <SectionHeader>{set.name}</SectionHeader>
            <div className="flex flex-wrap px-1">
              {set.emojis.map((emoji) => (
                <CustomEmojiButton key={`${set.id}:${emoji.shortcode}:${emoji.url}`} emoji={emoji} onSelect={handleSelect} />
              ))}
            </div>
          </div>
        ))}

        {search === "" && looseEmojis.length > 0 && (
          <div>
            <SectionHeader>マイ絵文字</SectionHeader>
            <div className="flex flex-wrap px-1">
              {looseEmojis.map((emoji) => (
                <CustomEmojiButton key={`loose:${emoji.shortcode}:${emoji.url}`} emoji={emoji} onSelect={handleSelect} />
              ))}
            </div>
          </div>
        )}

        {search !== "" && filteredCustomEmojis.length > 0 && (
          <div>
            <SectionHeader>カスタム絵文字</SectionHeader>
            <div className="flex flex-wrap px-1">
              {filteredCustomEmojis.map((emoji) => (
                <CustomEmojiButton key={`search:${emoji.shortcode}:${emoji.url}`} emoji={emoji} onSelect={handleSelect} />
              ))}
            </div>
          </div>
        )}

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
  );
}

export function EmojiPickerPopover({
  isOpen,
  onClose,
  onEmojiSelect,
  anchorRef,
  recentEmojis,
  emojiSets,
  looseEmojis,
}: EmojiPickerPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number; placement: "above" | "below" }>({ top: 0, left: 0, placement: "above" });

  const updatePosition = useCallback(() => {
    if (!anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const pickerWidth = Math.min(320, window.innerWidth * 0.9);
    const pickerHeight = 320;
    const gap = 8;

    let left = rect.left;
    if (left + pickerWidth > window.innerWidth - 8) {
      left = window.innerWidth - pickerWidth - 8;
    }
    if (left < 8) left = 8;

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

  useEffect(() => {
    if (!isOpen) return;

    updatePosition();

    const handleMouseDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

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
      className="fixed rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg"
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
      <EmojiPickerContent
        onClose={onClose}
        onEmojiSelect={onEmojiSelect}
        recentEmojis={recentEmojis}
        emojiSets={emojiSets}
        looseEmojis={looseEmojis}
      />
    </div>,
    document.body,
  );
}
