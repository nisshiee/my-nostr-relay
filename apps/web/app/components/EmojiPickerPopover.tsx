"use client";

import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { EmojiPicker } from "frimousse";
import type { CustomEmoji, EmojiSet } from "../hooks/useCustomEmojis";
import type { RecentEmoji } from "../hooks/useRecentEmojis";

/** タブの種類 */
type TabType = "recent" | "custom" | "unicode";

interface EmojiPickerPopoverProps {
  /** ポップオーバーの開閉状態 */
  isOpen: boolean;
  /** ポップオーバーを閉じるハンドラ */
  onClose: () => void;
  /** 絵文字が選択されたときのハンドラ */
  onEmojiSelect: (emoji: string, imageUrl?: string) => void;
  /** ピッカーのアンカー要素（位置計算用） */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** 最近使った絵文字の配列 */
  recentEmojis?: RecentEmoji[];
  /** カスタム絵文字セット */
  emojiSets?: EmojiSet[];
  /** セットに属さないカスタム絵文字 */
  looseEmojis?: CustomEmoji[];
}

/** カスタム絵文字ボタン */
function CustomEmojiButton({
  shortcode,
  url,
  onEmojiSelect,
  onClose,
}: {
  shortcode: string;
  url: string;
  onEmojiSelect: (emoji: string, imageUrl?: string) => void;
  onClose: () => void;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        onEmojiSelect(`:${shortcode}:`, url);
        onClose();
      }}
      title={`:${shortcode}:`}
      className="flex items-center justify-center w-8 h-8 rounded hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer"
    >
      <img
        src={url}
        alt={`:${shortcode}:`}
        className="w-5 h-5 object-contain"
        referrerPolicy="no-referrer"
      />
    </button>
  );
}

/** タブバー */
function TabBar({
  activeTab,
  onTabChange,
  hasCustom,
}: {
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
  hasCustom: boolean;
}) {
  const tabs: { type: TabType; icon: string; label: string }[] = [
    { type: "recent", icon: "🕐", label: "最近使った絵文字" },
    ...(hasCustom
      ? [{ type: "custom" as const, icon: "⭐", label: "カスタム絵文字" }]
      : []),
    { type: "unicode", icon: "😀", label: "Unicode絵文字" },
  ];

  return (
    <div className="flex border-b border-gray-200 dark:border-gray-700">
      {tabs.map((tab) => (
        <button
          key={tab.type}
          type="button"
          aria-label={tab.label}
          onClick={() => onTabChange(tab.type)}
          className={`flex-1 py-1 text-center text-sm cursor-pointer transition-colors ${
            activeTab === tab.type
              ? "border-b-2 border-blue-500 dark:border-blue-400"
              : "text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
          }`}
        >
          {tab.icon}
        </button>
      ))}
    </div>
  );
}

/** 最近使った絵文字タブの中身 */
function RecentTab({
  recentEmojis,
  onEmojiSelect,
  onClose,
}: {
  recentEmojis: RecentEmoji[];
  onEmojiSelect: (emoji: string, imageUrl?: string) => void;
  onClose: () => void;
}) {
  if (recentEmojis.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-gray-400 dark:text-gray-500">
        まだリアクションしていません
      </div>
    );
  }

  return (
    <div>
      <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400 sticky top-0 bg-white dark:bg-gray-800">
        最近使った絵文字
      </div>
      <div className="flex flex-wrap px-1">
      {recentEmojis.map((recent) =>
        recent.imageUrl ? (
          <CustomEmojiButton
            key={recent.emoji}
            shortcode={recent.emoji.slice(1, -1)}
            url={recent.imageUrl}
            onEmojiSelect={onEmojiSelect}
            onClose={onClose}
          />
        ) : (
          <button
            key={recent.emoji}
            type="button"
            onClick={() => {
              onEmojiSelect(recent.emoji);
              onClose();
            }}
            className="flex items-center justify-center w-8 h-8 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-xl cursor-pointer"
          >
            {recent.emoji}
          </button>
        ),
      )}
      </div>
    </div>
  );
}

/** カスタム絵文字タブの中身 */
function CustomTab({
  emojiSets,
  looseEmojis,
  search,
  onEmojiSelect,
  onClose,
}: {
  emojiSets: EmojiSet[];
  looseEmojis: CustomEmoji[];
  search: string;
  onEmojiSelect: (emoji: string, imageUrl?: string) => void;
  onClose: () => void;
}) {
  const filteredSets = useMemo(() => {
    if (search === "") return emojiSets;
    const query = search.toLowerCase();
    return emojiSets
      .map((set) => ({
        ...set,
        emojis: set.emojis.filter((e) =>
          e.shortcode.toLowerCase().includes(query),
        ),
      }))
      .filter((set) => set.emojis.length > 0);
  }, [emojiSets, search]);

  const filteredLoose = useMemo(() => {
    if (search === "") return looseEmojis;
    const query = search.toLowerCase();
    return looseEmojis.filter((e) =>
      e.shortcode.toLowerCase().includes(query),
    );
  }, [looseEmojis, search]);

  if (filteredSets.length === 0 && filteredLoose.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-gray-400 dark:text-gray-500">
        見つかりません
      </div>
    );
  }

  return (
    <div className="py-1">
      {filteredSets.map(
        (set) =>
          set.emojis.length > 0 && (
            <div key={set.id}>
              <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400 sticky top-0 bg-white dark:bg-gray-800">
                {set.icon ? `${set.icon} ${set.name}` : set.name}
              </div>
              <div className="flex flex-wrap px-1">
                {set.emojis.map((e) => (
                  <CustomEmojiButton
                    key={e.shortcode}
                    shortcode={e.shortcode}
                    url={e.url}
                    onEmojiSelect={onEmojiSelect}
                    onClose={onClose}
                  />
                ))}
              </div>
            </div>
          ),
      )}
      {filteredLoose.length > 0 && (
        <div>
          <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400 sticky top-0 bg-white dark:bg-gray-800">
            マイ絵文字
          </div>
          <div className="flex flex-wrap px-1">
            {filteredLoose.map((e) => (
              <CustomEmojiButton
                key={e.shortcode}
                shortcode={e.shortcode}
                url={e.url}
                onEmojiSelect={onEmojiSelect}
                onClose={onClose}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Unicode絵文字タブの中身（frimousse） */
function UnicodeTab({
  onEmojiSelect,
  onClose,
}: {
  onEmojiSelect: (emoji: string, imageUrl?: string) => void;
  onClose: () => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);

  // 検索ボックスに自動フォーカス
  useEffect(() => {
    requestAnimationFrame(() => {
      searchRef.current?.focus();
    });
  }, []);

  return (
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
        className="w-full px-3 py-2 text-sm border-b border-gray-200 dark:border-gray-700 bg-transparent outline-none text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500"
      />
      <EmojiPicker.Viewport className="h-[243px]">
        <EmojiPicker.Loading className="flex items-center justify-center h-full text-sm text-gray-400 dark:text-gray-500">
          読み込み中...
        </EmojiPicker.Loading>
        <EmojiPicker.Empty className="flex items-center justify-center h-full text-sm text-gray-400 dark:text-gray-500">
          見つかりません
        </EmojiPicker.Empty>
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

/** 絵文字ピッカーの内部コンテンツ（isOpen時のみマウントされ、閉じるとアンマウント→stateリセット） */
function EmojiPickerContent({
  onClose,
  onEmojiSelect,
  recentEmojis,
  emojiSets,
  looseEmojis,
}: {
  onClose: () => void;
  onEmojiSelect: (emoji: string, imageUrl?: string) => void;
  recentEmojis?: RecentEmoji[];
  emojiSets?: EmojiSet[];
  looseEmojis?: CustomEmoji[];
}) {
  const [activeTab, setActiveTab] = useState<TabType>("recent");
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const hasCustom =
    (emojiSets !== undefined && emojiSets.some((s) => s.emojis.length > 0)) ||
    (looseEmojis !== undefined && looseEmojis.length > 0);

  // タブ切替時に検索をリセット
  const handleTabChange = useCallback((tab: TabType) => {
    setActiveTab(tab);
    setSearch("");
  }, []);

  // カスタムタブで検索ボックスに自動フォーカス
  useEffect(() => {
    if (activeTab === "custom") {
      requestAnimationFrame(() => {
        searchRef.current?.focus();
      });
    }
  }, [activeTab]);

  return (
    <div>
      <TabBar
        activeTab={activeTab}
        onTabChange={handleTabChange}
        hasCustom={hasCustom}
      />

      {/* タブの中身 */}
      <div style={{ height: 280 }}>
        {activeTab === "recent" && (
          <div className="overflow-y-auto h-full">
            <RecentTab
              recentEmojis={recentEmojis ?? []}
              onEmojiSelect={onEmojiSelect}
              onClose={onClose}
            />
          </div>
        )}
        {activeTab === "custom" && (
          <div className="flex flex-col h-full">
            <input
              ref={searchRef}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="カスタム絵文字を検索..."
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              className="w-full px-3 py-2 text-sm border-b border-gray-200 dark:border-gray-700 bg-transparent outline-none text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 flex-shrink-0"
            />
            <div className="flex-1 overflow-y-auto">
              <CustomTab
                emojiSets={emojiSets ?? []}
                looseEmojis={looseEmojis ?? []}
                search={search}
                onEmojiSelect={onEmojiSelect}
                onClose={onClose}
              />
            </div>
          </div>
        )}
        {activeTab === "unicode" && (
          <UnicodeTab onEmojiSelect={onEmojiSelect} onClose={onClose} />
        )}
      </div>
    </div>
  );
}

/** 絵文字ピッカーポップオーバーコンポーネント（Portal描画） */
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
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    placement: "above" | "below";
  }>({ top: 0, left: 0, placement: "above" });

  /** アンカー要素の位置からポップオーバーの位置を計算する（上下自動切り替え） */
  const updatePosition = useCallback(() => {
    if (!anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const pickerWidth = Math.min(320, window.innerWidth * 0.9);
    const pickerHeight = 360; // タブバー分を加算
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
        top: position.top,
        left: position.left,
        transform:
          position.placement === "above" ? "translateY(-100%)" : undefined,
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
