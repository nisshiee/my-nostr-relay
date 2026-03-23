"use client";

/** NoteCard用アクションバー（カードクリックで展開するリアクション操作UI） */

interface ActionBarProps {
  /** アクションバーの開閉状態 */
  isOpen: boolean;
  /** 「👍」ボタンクリック時のハンドラ（Nostrプロトコル上は「+」として送信） */
  onThumbsUp: () => void | Promise<void>;
  /** 自分が既に「👍」リアクション済みかどうか */
  isAlreadyReacted: boolean;
  /** リポストボタンクリック時のハンドラ */
  onRepost: () => void | Promise<void>;
  /** 自分が既にリポスト済みかどうか */
  isAlreadyReposted: boolean;
}

export function ActionBar({
  isOpen,
  onThumbsUp,
  isAlreadyReacted,
  onRepost,
  isAlreadyReposted,
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
        {/* 🔁 リポストボタン */}
        <button
          type="button"
          aria-label={isAlreadyReposted ? "既にリポスト済み" : "リポスト"}
          disabled={isAlreadyReposted}
          onClick={(e) => {
            e.stopPropagation();
            onRepost();
          }}
          className={`text-lg leading-none p-1 rounded transition-colors ${
            isAlreadyReposted
              ? "text-gray-300 dark:text-gray-600 cursor-not-allowed"
              : "text-gray-400 dark:text-gray-500 cursor-pointer hover:text-gray-600 dark:hover:text-gray-300"
          }`}
        >
          🔁
        </button>
        {/* + リアクション追加ボタン（アイコンのみ、ボーダーなし） */}
        <button
          type="button"
          aria-label={isAlreadyReacted ? "既にリアクション済み" : "リアクションを追加"}
          aria-pressed={isAlreadyReacted}
          disabled={isAlreadyReacted}
          onClick={(e) => {
            e.stopPropagation();
            onThumbsUp();
          }}
          className={`text-lg leading-none p-1 rounded transition-colors ${
            isAlreadyReacted
              ? "text-gray-300 dark:text-gray-600 cursor-not-allowed"
              : "text-gray-400 dark:text-gray-500 cursor-pointer hover:text-gray-600 dark:hover:text-gray-300"
          }`}
        >
          +
        </button>
        {/* 将来的に他のアクションボタンをここに追加 */}
      </div>
    </div>
  );
}
