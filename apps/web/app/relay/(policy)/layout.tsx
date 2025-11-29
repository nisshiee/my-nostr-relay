// ポリシーページ共通レイアウト
// シンプルで読みやすいデザインを提供

export default function PolicyLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black">
      <header className="border-b border-zinc-200 dark:border-zinc-800">
        <div className="mx-auto max-w-4xl px-6 py-4">
          <a
            href="/"
            className="text-sm text-zinc-600 dark:text-zinc-400 hover:text-black dark:hover:text-white transition-colors"
          >
            ← ホームに戻る
          </a>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-6 py-12">{children}</main>
      <footer className="border-t border-zinc-200 dark:border-zinc-800 mt-16">
        <div className="mx-auto max-w-4xl px-6 py-8">
          <nav className="flex flex-wrap gap-6 text-sm text-zinc-600 dark:text-zinc-400">
            <a
              href="/relay/terms"
              className="hover:text-black dark:hover:text-white transition-colors"
            >
              利用規約
            </a>
            <a
              href="/relay/privacy"
              className="hover:text-black dark:hover:text-white transition-colors"
            >
              プライバシーポリシー
            </a>
            <a
              href="/relay/posting-policy"
              className="hover:text-black dark:hover:text-white transition-colors"
            >
              投稿ポリシー
            </a>
          </nav>
          <p className="mt-4 text-xs text-zinc-500">
            最終更新日: 2025年11月29日
          </p>
        </div>
      </footer>
    </div>
  );
}
