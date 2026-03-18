"use client";

/** NoteCard用アクションバー（長押しで展開するリアクション操作UI） */

interface ActionBarProps {
  /** アクションバーの開閉状態 */
  isOpen: boolean;
  /** 「👍」ボタンクリック時のハンドラ */
  onThumbsUp: () => void;
  /** 自分が既に「👍」リアクション済みかどうか */
  isAlreadyReacted: boolean;
  /** 明示的に閉じる場合のハンドラ（将来拡張用） */
  onClose?: () => void;
}

export function ActionBar({
  isOpen,
  onThumbsUp,
  isAlreadyReacted,
  onClose: _onClose,
}: ActionBarProps) {
  return (
    <div
      role="toolbar"
      aria-label="アクションバー"
      className={`overflow-hidden transition-all duration-200 ease-out ${
        isOpen
          ? "max-h-12 opacity-100 mt-2"
          : "max-h-0 opacity-0 mt-0"
      }`}
    >
      <div className="flex items-center gap-1.5">
        {/* 👍 リアクションボタン */}
        <button
          type="button"
          aria-label={isAlreadyReacted ? "既にリアクション済み" : "👍 リアクション"}
          aria-pressed={isAlreadyReacted}
          disabled={isAlreadyReacted}
          onClick={onThumbsUp}
          className={`rounded-full px-2 py-0.5 text-xs inline-flex items-center gap-1 transition-colors ${
            isAlreadyReacted
              ? "bg-blue-100 dark:bg-blue-900/40 border border-blue-400 dark:border-blue-500 text-blue-700 dark:text-blue-300 cursor-not-allowed"
              : "bg-gray-100 dark:bg-gray-700 border border-transparent cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-600"
          }`}
        >
          👍
        </button>
        {/* 将来的に他のアクションボタンをここに追加 */}
      </div>
    </div>
  );
}
