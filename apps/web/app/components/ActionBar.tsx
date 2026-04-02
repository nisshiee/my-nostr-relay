"use client";

import { useState, useRef } from "react";
import { MessageSquare, Repeat2, Plus, Smile, Quote } from "lucide-react";
import { EmojiPickerPopover } from "./EmojiPickerPopover";
import type { CustomEmoji, EmojiSet } from "../hooks/useCustomEmojis";
import type { RecentEmoji } from "../hooks/useRecentEmojis";

/** NoteCard用アクションバー（カードクリックで展開するリアクション操作UI） */

interface ActionBarProps {
  /** アクションバーの開閉状態 */
  isOpen: boolean;
  /** 「👍」ボタンクリック時のハンドラ（Nostrプロトコル上は「+」として送信） */
  onThumbsUp: () => void | Promise<void>;
  /** 自分が既に「👍」リアクション済みかどうか */
  isAlreadyReacted: boolean;
  /** リプライボタンクリック時のハンドラ */
  onReply?: () => void | Promise<void>;
  /** リポストボタンクリック時のハンドラ */
  onRepost: () => void | Promise<void>;
  /** 引用ボタンクリック時のハンドラ */
  onQuote?: () => void | Promise<void>;
  /** 自分が既にリポスト済みかどうか */
  isAlreadyReposted: boolean;
  /** 絵文字ピッカーから絵文字が選択されたときのハンドラ */
  onEmojiSelect?: (emoji: string, imageUrl?: string) => void;
  /** 絵文字ピッカーの開閉状態が変わったときのコールバック */
  onPickerOpenChange?: (isOpen: boolean) => void;
  /** 最近使った絵文字の配列 */
  recentEmojis?: RecentEmoji[];
  /** カスタム絵文字セット */
  emojiSets?: EmojiSet[];
  /** 個別のカスタム絵文字 */
  looseEmojis?: CustomEmoji[];
}

export function ActionBar({
  isOpen,
  onReply,
  onThumbsUp,
  isAlreadyReacted,
  onRepost,
  isAlreadyReposted,
  onQuote,
  onEmojiSelect,
  onPickerOpenChange,
  recentEmojis,
  emojiSets,
  looseEmojis,
}: ActionBarProps) {
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);

  // アクションバーが閉じたらピッカーもリセット（レンダー中の条件付きsetState）
  // React 19: 条件付きsetStateはレンダー中に安全にバッチされる
  if (!isOpen && isPickerOpen) {
    setIsPickerOpen(false);
    onPickerOpenChange?.(false);
  }

  /** ピッカーの開閉状態を更新し、親に通知する */
  const updatePickerOpen = (open: boolean) => {
    setIsPickerOpen(open);
    onPickerOpenChange?.(open);
  };

  return (
    <div
      role="toolbar"
      aria-label="アクションバー"
      className={`overflow-hidden transition-all duration-200 ease-out ${
        isOpen
          ? "max-h-8 opacity-100 mt-2"
          : "max-h-0 opacity-0 mt-0"
      }`}
    >
      <div className="flex items-center gap-1.5">
        {/* リプライボタン */}
        {onReply && (
          <button
            type="button"
            aria-label="返信"
            onClick={(e) => {
              e.stopPropagation();
              onReply();
            }}
            className="p-1.5 rounded transition-colors text-gray-400 dark:text-gray-500 cursor-pointer hover:text-blue-500 dark:hover:text-blue-400"
          >
            <MessageSquare size={18} />
          </button>
        )}
        {/* リポストボタン */}
        <button
          type="button"
          aria-label={isAlreadyReposted ? "既にリポスト済み" : "リポスト"}
          disabled={isAlreadyReposted}
          onClick={(e) => {
            e.stopPropagation();
            onRepost();
          }}
          className={`p-1.5 rounded transition-colors ${
            isAlreadyReposted
              ? "text-gray-300 dark:text-gray-600 cursor-not-allowed"
              : "text-gray-400 dark:text-gray-500 cursor-pointer hover:text-green-500 dark:hover:text-green-400"
          }`}
        >
          <Repeat2 size={18} />
        </button>
        {/* 引用ボタン */}
        {onQuote && (
          <button
            type="button"
            aria-label="引用"
            onClick={(e) => {
              e.stopPropagation();
              onQuote();
            }}
            className="p-1.5 rounded transition-colors text-gray-400 dark:text-gray-500 cursor-pointer hover:text-orange-500 dark:hover:text-orange-400"
          >
            <Quote size={18} />
          </button>
        )}
        {/* リアクション追加ボタン */}
        <button
          type="button"
          aria-label={isAlreadyReacted ? "既にリアクション済み" : "リアクションを追加"}
          aria-pressed={isAlreadyReacted}
          disabled={isAlreadyReacted}
          onClick={(e) => {
            e.stopPropagation();
            onThumbsUp();
          }}
          className={`p-1.5 rounded transition-colors ${
            isAlreadyReacted
              ? "text-gray-300 dark:text-gray-600 cursor-not-allowed"
              : "text-gray-400 dark:text-gray-500 cursor-pointer hover:text-gray-600 dark:hover:text-gray-300"
          }`}
        >
          <Plus size={18} />
        </button>
        {/* 絵文字ピッカーボタン */}
        {onEmojiSelect && (
          <>
            <button
              ref={emojiButtonRef}
              type="button"
              aria-label="絵文字ピッカーを開く"
              onClick={(e) => {
                e.stopPropagation();
                updatePickerOpen(!isPickerOpen);
              }}
              className="p-1.5 rounded transition-colors text-gray-400 dark:text-gray-500 cursor-pointer hover:text-gray-600 dark:hover:text-gray-300"
            >
              <Smile size={18} />
            </button>
            <EmojiPickerPopover
              isOpen={isPickerOpen}
              onClose={() => updatePickerOpen(false)}
              onEmojiSelect={(emoji, imageUrl) => {
                onEmojiSelect(emoji, imageUrl);
              }}
              anchorRef={emojiButtonRef}
              recentEmojis={recentEmojis}
              emojiSets={emojiSets}
              looseEmojis={looseEmojis}
            />
          </>
        )}
      </div>
    </div>
  );
}
