"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import Image from "next/image";
import type { NoteCard, NostrProfile } from "../lib/types";

/** npubの省略表示を生成 */
function shortenPubkey(pubkey: string): string {
  if (pubkey.length <= 12) return pubkey;
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}

interface ComposeCardProps {
  slotId: string;
  pubkey: string;
  profile?: NostrProfile;
  onHeightChange?: (slotId: string, height: number) => void;
  onPublish: (slotId: string, event: NoteCard) => void;
  onInput: (slotId: string) => void;
  onClose: (slotId: string) => void;
  publishEvent: (event: NostrEvent) => Promise<void>;
  autoFocus?: boolean;
}

export function ComposeCard({
  slotId,
  pubkey,
  profile,
  onHeightChange,
  onPublish,
  onInput,
  onClose,
  publishEvent,
  autoFocus,
}: ComposeCardProps) {
  const [text, setText] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const displayName =
    profile?.display_name || profile?.name || shortenPubkey(pubkey);
  const avatarUrl = profile?.picture;

  // autoFocus
  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [autoFocus]);

  // ResizeObserver でカードの高さを測定して親に通知
  useEffect(() => {
    const el = cardRef.current;
    if (!el || !onHeightChange) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        onHeightChange(slotId, entry.borderBoxSize[0].blockSize);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [slotId, onHeightChange]);

  // textarea の高さを内容に合わせて自動調整
  const adjustTextareaHeight = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value);
      onInput(slotId);
      adjustTextareaHeight();
    },
    [slotId, onInput, adjustTextareaHeight],
  );

  const handlePublish = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || publishing) return;

    setError(null);
    setPublishing(true);

    try {
      const nostr = window.nostr;
      if (!nostr) {
        throw new Error("NIP-07 拡張機能が見つかりません");
      }

      const unsignedEvent: NostrEvent = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: trimmed,
      };

      const signedEvent = await nostr.signEvent(unsignedEvent);

      const noteCard: NoteCard = {
        type: "note",
        slotId,
        eventId: signedEvent.id,
        pubkey: signedEvent.pubkey,
        content: signedEvent.content,
        created_at: signedEvent.created_at,
        score: 1,
        fadingOut: false,
      };

      // 署名完了の時点で即座にonPublishを呼ぶ（ComposeCard→送信済み状態に変化）
      // publishEventはawaitせずバックグラウンドで実行（リレーの応答速度差による二重表示を防止）
      onPublish(slotId, noteCard);
      publishEvent(signedEvent).catch((err) => {
        console.error("リレーへの送信に失敗:", err);
      });
      // 正常系: onPublish後にコンポーネントがアンマウントされるためstate更新不要
      return;
    } catch (err) {
      setError(err instanceof Error ? err.message : "署名に失敗しました");
      setPublishing(false);
    }
  }, [text, publishing, publishEvent, onPublish, slotId]);

  const handleClose = useCallback(() => {
    if (
      text.trim().length === 0 ||
      window.confirm("入力中の内容が破棄されます。閉じますか？")
    ) {
      onClose(slotId);
    }
  }, [text, onClose, slotId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void handlePublish();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
      }
    },
    [handlePublish, handleClose],
  );

  return (
    <div
      ref={cardRef}
      className="rounded-xl border-2 border-purple-300 dark:border-purple-700 bg-white dark:bg-gray-800 p-4"
    >
      {/* ヘッダー: アバター + 名前 */}
      <div className="flex items-center gap-3 mb-2">
        {avatarUrl ? (
          <Image
            src={avatarUrl}
            alt={displayName}
            width={32}
            height={32}
            className="h-8 w-8 shrink-0 rounded-full object-cover"
            unoptimized
          />
        ) : (
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-400 to-blue-500 flex items-center justify-center flex-shrink-0">
            <span className="text-white text-xs font-bold">
              {displayName.charAt(0).toUpperCase()}
            </span>
          </div>
        )}
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
            {displayName}
          </span>
        </div>
        <button
          type="button"
          onClick={handleClose}
          className="ml-auto text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
          title="閉じる (Esc)"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-4 w-4"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      </div>

      {/* テキストエリア */}
      <textarea
        ref={textareaRef}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="いまどうしてる？"
        rows={3}
        className="w-full resize-none overflow-hidden rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 p-3 text-sm text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-400 dark:focus:ring-purple-600 leading-relaxed"
        disabled={publishing}
      />

      {/* エラーメッセージ */}
      {error && (
        <p className="mt-1 text-xs text-red-500 dark:text-red-400">{error}</p>
      )}

      {/* フッター: 文字数 + Publishボタン */}
      <div className="flex items-center justify-between mt-2">
        <span className="text-xs text-gray-400 dark:text-gray-500">
          {text.length > 0 ? `${text.length} 文字` : ""}
        </span>
        <button
          type="button"
          onClick={() => void handlePublish()}
          disabled={publishing || text.trim().length === 0}
          className="rounded-lg bg-purple-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-purple-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {publishing ? (
            <span className="flex items-center gap-1">
              <svg
                className="animate-spin h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              投稿中…
            </span>
          ) : (
            "Publish"
          )}
        </button>
      </div>
    </div>
  );
}
