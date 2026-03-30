"use client";

import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import Image from "next/image";
import type { NoteCard, NostrProfile } from "../lib/types";
import type { NostrEvent } from "../types/nostr";
import type { EventCache } from "../hooks/useEventCache";
import { useImageUpload } from "../hooks/useImageUpload";
import { QuoteNode } from "./content/QuoteNode";
import { encodeNevent, decodeNevent, decodeNote } from "../lib/nip19";
import { CLIENT_TAG } from "../lib/constants";

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
  /** テキストエリアにフォーカスしたときホールド開始 */
  onHold?: (slotId: string) => void;
  /** テキストエリアからブラーしたときホールド解除 */
  onRelease?: (slotId: string) => void;
  autoFocus?: boolean;
  /** 引用元イベント情報 */
  quotedEvent?: { eventId: string; pubkey: string; sig?: string };
  /** EventCache インスタンス（引用プレビュー用） */
  cache?: EventCache;
  /** pubkey → NostrProfile のマップ（引用プレビュー用） */
  profiles?: Map<string, NostrProfile>;
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
  onHold,
  onRelease,
  autoFocus,
  quotedEvent,
  cache,
  profiles,
}: ComposeCardProps) {
  const [text, setText] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [internalQuotedEvent, setInternalQuotedEvent] = useState<
    { eventId: string; pubkey?: string; sig?: string } | undefined
  >(quotedEvent);
  const cardRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // props の quotedEvent が変わったら内部ステートも更新
  useEffect(() => {
    setInternalQuotedEvent(quotedEvent);
  }, [quotedEvent]);

  const imageUpload = useImageUpload();

  // プレビューURL生成（メモ化して不要な再生成を防止）
  const previewUrl = useMemo(
    () =>
      imageUpload.state.file
        ? URL.createObjectURL(imageUpload.state.file)
        : null,
    [imageUpload.state.file],
  );

  // プレビューURLのクリーンアップ
  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  // アップロード完了時にURLをテキストエリアに挿入
  useEffect(() => {
    if (imageUpload.state.uploadedUrl) {
      const url = imageUpload.state.uploadedUrl;
      setText((prev) => {
        const separator = prev.length > 0 && !prev.endsWith("\n") ? "\n" : "";
        return `${prev}${separator}${url}`;
      });
      imageUpload.reset();
      onInput(slotId);
    }
  }, [imageUpload.state.uploadedUrl, imageUpload, onInput, slotId]);

  /** ファイル選択ダイアログを開く */
  const handleFileButtonClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  /** ファイル選択時のハンドラ */
  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        imageUpload.selectFile(file);
      }
      // 同じファイルを再選択できるようにリセット
      e.target.value = "";
    },
    [imageUpload],
  );

  /** 画像アップロード実行 */
  const handleImageUpload = useCallback(async () => {
    await imageUpload.uploadImage();
  }, [imageUpload]);

  /** 選択した画像をクリア */
  const handleImageClear = useCallback(() => {
    imageUpload.clearImage();
  }, [imageUpload]);

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

  /** テキストエリアのフォーカスでホールド開始 */
  const handleFocus = useCallback(() => {
    onHold?.(slotId);
  }, [onHold, slotId]);

  /** テキストエリアのブラーでホールド解除 */
  const handleBlur = useCallback(() => {
    onRelease?.(slotId);
  }, [onRelease, slotId]);

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
    // 未アップロードの画像がある場合は確認ダイアログを表示
    if (
      imageUpload.state.file !== null &&
      imageUpload.state.uploadedUrl === null &&
      !imageUpload.state.uploading
    ) {
      if (!window.confirm("画像がアップロードされていません。このまま投稿しますか？")) {
        return;
      }
    }

    const trimmed = text.trim();
    if (!trimmed || publishing) return;

    setError(null);
    setPublishing(true);

    try {
      const nostr = window.nostr;
      if (!nostr) {
        throw new Error("NIP-07 拡張機能が見つかりません");
      }

      const neventUri = internalQuotedEvent
        ? `nostr:${encodeNevent(internalQuotedEvent.eventId, internalQuotedEvent.pubkey)}`
        : null;
      const finalContent = neventUri ? `${trimmed}\n${neventUri}` : trimmed;
      const tags: string[][] = [CLIENT_TAG];
      if (internalQuotedEvent) {
        tags.push(["q", internalQuotedEvent.eventId, "", internalQuotedEvent.pubkey ?? ""]);
      }

      const unsignedEvent: NostrEvent = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: finalContent,
      };

      const signedEvent = await nostr.signEvent(unsignedEvent);

      const noteCard: NoteCard = {
        type: "note",
        slotId,
        eventId: signedEvent.id,
        pubkey: signedEvent.pubkey,
        content: signedEvent.content,
        tags: signedEvent.tags,
        created_at: signedEvent.created_at,
        score: 1,
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
  }, [text, publishing, publishEvent, onPublish, slotId, internalQuotedEvent, imageUpload]);

  const handleClose = useCallback(() => {
    if (
      text.trim().length === 0 ||
      window.confirm("入力中の内容が破棄されます。閉じますか？")
    ) {
      onClose(slotId);
    }
  }, [text, onClose, slotId]);

  /** クリップボードから画像をペーストした場合にアップロードフローを開始 */
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            imageUpload.selectFile(file);
            return;
          }
        }
      }
      // 画像が見つからない場合、テキストからbech32引用を検出
      const pastedText = e.clipboardData?.getData("text/plain")?.trim();
      if (pastedText) {
        // nostr: プレフィックスを剥がす（クライアントが nostr:nevent1... 形式でコピーするケース）
        const stripped = pastedText.startsWith("nostr:") ? pastedText.slice(6) : pastedText;
        if (stripped.startsWith("nevent1")) {
          const decoded = decodeNevent(stripped);
          if (decoded) {
            e.preventDefault();
            setInternalQuotedEvent({
              eventId: decoded.eventId,
              pubkey: decoded.pubkey,
            });
            return;
          }
        }
        if (stripped.startsWith("note1")) {
          const decoded = decodeNote(stripped);
          if (decoded) {
            e.preventDefault();
            setInternalQuotedEvent({
              eventId: decoded.eventId,
              pubkey: undefined,
            });
            return;
          }
        }
      }
      // テキストの通常ペーストとして処理
    },
    [imageUpload],
  );

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
          className="ml-auto text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
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
        onPaste={handlePaste}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholder="いまどうしてる？"
        rows={3}
        className="w-full resize-none overflow-hidden rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 p-3 text-sm text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-400 dark:focus:ring-purple-600 leading-relaxed"
        disabled={publishing}
      />

      {/* 引用プレビュー */}
      {internalQuotedEvent && cache && profiles && (
        <div className="mt-2 relative">
          <QuoteNode
            uri={`nostr:${encodeNevent(internalQuotedEvent.eventId, internalQuotedEvent.pubkey)}`}
            cache={cache}
            profiles={profiles}
          />
          <button
            type="button"
            onClick={() => setInternalQuotedEvent(undefined)}
            className="absolute -top-2 -right-2 rounded-full bg-gray-700 dark:bg-gray-600 text-white w-5 h-5 flex items-center justify-center text-xs hover:bg-gray-800 dark:hover:bg-gray-500 transition-colors"
            title="引用を解除"
          >
            ×
          </button>
        </div>
      )}

      {/* 画像アップロードセクション */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        onChange={handleFileChange}
        className="hidden"
        disabled={publishing}
      />

      {/* 画像プレビュー */}
      {previewUrl && imageUpload.state.file && (
        <div className="mt-2 relative inline-block">
          <img
            src={previewUrl}
            alt="プレビュー"
            className="max-h-40 rounded-lg border border-gray-200 dark:border-gray-600 object-contain"
          />
          {!imageUpload.state.uploading && (
            <button
              type="button"
              onClick={handleImageClear}
              className="absolute -top-2 -right-2 rounded-full bg-gray-700 dark:bg-gray-600 text-white w-5 h-5 flex items-center justify-center text-xs hover:bg-gray-800 dark:hover:bg-gray-500 transition-colors"
              title="画像を削除"
            >
              ×
            </button>
          )}
          {imageUpload.state.uploading && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40 rounded-lg">
              <svg
                className="animate-spin h-6 w-6 text-white"
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
            </div>
          )}
        </div>
      )}

      {/* 画像アップロードエラー */}
      {imageUpload.state.error && (
        <p className="mt-1 text-xs text-red-500 dark:text-red-400">
          {imageUpload.state.error}
        </p>
      )}

      {/* エラーメッセージ */}
      {error && (
        <p className="mt-1 text-xs text-red-500 dark:text-red-400">{error}</p>
      )}

      {/* フッター: 画像ボタン + 文字数 + Publishボタン */}
      <div className="flex items-center justify-between mt-2">
        <div className="flex items-center gap-2">
          {/* 画像添付ボタン */}
          <button
            type="button"
            onClick={handleFileButtonClick}
            disabled={publishing || imageUpload.state.uploading}
            className="text-gray-400 hover:text-purple-500 dark:text-gray-500 dark:hover:text-purple-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="画像を添付"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm12 12H4l4-8 3 6 2-4 3 6z"
                clipRule="evenodd"
              />
            </svg>
          </button>
          {/* アップロードボタン（ファイル選択済み & 未アップロード時） */}
          {imageUpload.state.file &&
            !imageUpload.state.uploading &&
            !imageUpload.state.uploadedUrl && (
              <button
                type="button"
                onClick={() => void handleImageUpload()}
                className="rounded-lg bg-purple-400 px-3 py-1 text-xs font-medium text-white hover:bg-purple-500 transition-colors"
              >
                アップロード
              </button>
            )}
          {imageUpload.state.uploading && (
            <span className="text-xs text-gray-400 dark:text-gray-500">
              アップロード中…
            </span>
          )}
          <span className="text-xs text-gray-400 dark:text-gray-500">
            {text.length > 0 ? `${text.length} 文字` : ""}
          </span>
        </div>
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
