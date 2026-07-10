"use client";

import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import Image from "next/image";
import type { NostrProfile } from "../lib/types";
import type { NostrEvent } from "../types/nostr";
import { useImageUpload } from "../hooks/useImageUpload";
import { CLIENT_TAG } from "../lib/constants";
import { extractHashtags } from "../lib/hashtags";

/** npubの省略表示を生成 */
function shortenPubkey(pubkey: string): string {
  if (pubkey.length <= 12) return pubkey;
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}

interface ReplyComposeProps {
  /** リプライ対象の情報 */
  replyTarget: {
    targetEventId: string;
    targetPubkey: string;
    /** ルートイベントID（スレッド内返信の場合。直接返信の場合はtargetEventIdと同じ） */
    rootEventId: string;
  };
  /** 返信先の表示名（「↩ {displayName} に返信」で使用） */
  replyToDisplayName: string;
  /** 自分のpubkey */
  myPubkey: string;
  /** 自分のプロフィール */
  myProfile?: NostrProfile;
  /** Publish完了時のコールバック（署名済みイベントとNoteCard情報を返す） */
  onPublish: (
    signedEvent: NostrEvent & { id: string; sig: string },
    noteCard: {
      eventId: string;
      pubkey: string;
      content: string;
      tags: string[][];
      created_at: number;
    },
  ) => void;
  /** 閉じるボタン/Escキー押下時 */
  onClose: () => void;
  /** イベント送信関数 */
  publishEvent: (event: NostrEvent) => Promise<void>;
  /** テキストエリアにフォーカスしたときのコールバック（ホールド開始） */
  onHold?: () => void;
  /** テキストエリアからブラーしたときのコールバック（ホールド解除） */
  onRelease?: () => void;
  /** 自動フォーカスするかどうか */
  autoFocus?: boolean;
}

export function ReplyCompose({
  replyTarget,
  replyToDisplayName,
  myPubkey,
  myProfile,
  onPublish,
  onClose,
  publishEvent,
  onHold,
  onRelease,
  autoFocus,
}: ReplyComposeProps) {
  const [text, setText] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const imageUpload = useImageUpload();

  // プレビューURL生成（メモ化）
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
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // autoFocus
  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [autoFocus]);

  const displayName =
    myProfile?.display_name || myProfile?.name || shortenPubkey(myPubkey);
  const avatarUrl = myProfile?.picture;

  /** テキストエリアの高さを内容に合わせて自動調整 */
  const adjustTextareaHeight = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value);
      adjustTextareaHeight();
    },
    [adjustTextareaHeight],
  );

  /** NIP-10準拠のタグを生成 */
  const buildReplyTags = useCallback((): string[][] => {
    const { rootEventId, targetEventId, targetPubkey } = replyTarget;
    const tags: string[][] = [];

    if (rootEventId === targetEventId) {
      // ルートへの直接リプライ
      tags.push(["e", targetEventId, "", "root"]);
      tags.push(["e", targetEventId, "", "reply"]);
    } else {
      // スレッド内ノートへの返信
      tags.push(["e", rootEventId, "", "root"]);
      tags.push(["e", targetEventId, "", "reply"]);
    }
    tags.push(["p", targetPubkey]);

    return tags;
  }, [replyTarget]);

  /** Publish処理 */
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

      const tags = [...buildReplyTags(), CLIENT_TAG];
      for (const tag of extractHashtags(trimmed)) {
        tags.push(["t", tag]);
      }

      const unsignedEvent: NostrEvent = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: trimmed,
      };

      const signedEvent = await nostr.signEvent(unsignedEvent);

      const noteCard = {
        eventId: signedEvent.id,
        pubkey: signedEvent.pubkey,
        content: signedEvent.content,
        tags: signedEvent.tags,
        created_at: signedEvent.created_at,
      };

      // 署名完了の時点で即座にonPublishを呼ぶ
      onPublish(signedEvent, noteCard);

      // リレーへの送信はバックグラウンドで実行
      publishEvent(signedEvent).catch((err) => {
        console.error("リレーへの送信に失敗:", err);
      });
      return;
    } catch (err) {
      setError(err instanceof Error ? err.message : "署名に失敗しました");
      setPublishing(false);
    }
  }, [text, publishing, buildReplyTags, onPublish, publishEvent, imageUpload]);

  /** 閉じる処理（入力中は確認ダイアログ） */
  const handleClose = useCallback(() => {
    if (
      text.trim().length === 0 ||
      window.confirm("入力中の内容が破棄されます。閉じますか？")
    ) {
      onClose();
    }
  }, [text, onClose]);

  /** クリップボードからの画像ペースト */
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
    },
    [imageUpload],
  );

  /** キーボードショートカット */
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

  /** ファイル選択ダイアログを開く */
  const handleFileButtonClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  /** ファイル選択時 */
  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) imageUpload.selectFile(file);
      e.target.value = "";
    },
    [imageUpload],
  );

  /** 画像アップロード実行 */
  const handleImageUpload = useCallback(async () => {
    const url = await imageUpload.uploadImage();
    if (!url) return;
    setText((prev) => {
      const separator = prev.length > 0 && !prev.endsWith("\n") ? "\n" : "";
      return `${prev}${separator}${url}`;
    });
    imageUpload.reset();
  }, [imageUpload]);

  /** 選択した画像をクリア */
  const handleImageClear = useCallback(() => {
    imageUpload.clearImage();
  }, [imageUpload]);

  const handleFocus = useCallback(() => {
    onHold?.();
  }, [onHold]);

  const handleBlur = useCallback(() => {
    onRelease?.();
  }, [onRelease]);

  return (
    <div className="mt-3">
      {/* 区切り線 */}
      <div className="border-t border-gray-200 dark:border-gray-700 mb-2" />

      {/* 返信先ヘッダー */}
      <div className="flex items-center gap-1 mb-1.5">
        <span className="text-[11px] text-gray-400 dark:text-gray-500">
          ↩ {replyToDisplayName} に返信
        </span>
      </div>

      {/* 自分のアバター + 名前 */}
      <div className="flex items-center gap-3 mb-2">
        {avatarUrl ? (
          <Image
            src={avatarUrl}
            alt={displayName}
            width={28}
            height={28}
            className="h-7 w-7 shrink-0 rounded-full object-cover"
            unoptimized
          />
        ) : (
          <div className="w-7 h-7 rounded-full bg-gradient-to-br from-purple-400 to-blue-500 flex items-center justify-center flex-shrink-0">
            <span className="text-white text-[10px] font-bold">
              {displayName.charAt(0).toUpperCase()}
            </span>
          </div>
        )}
        <span className="text-xs font-semibold text-gray-900 dark:text-gray-100 truncate">
          {displayName}
        </span>
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
        placeholder="返信を書く…"
        rows={2}
        className="w-full resize-none overflow-hidden rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 p-2.5 text-sm text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-400 dark:focus:ring-purple-600 leading-relaxed"
        disabled={publishing}
      />

      {/* 画像ファイル入力（hidden） */}
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
            className="max-h-32 rounded-lg border border-gray-200 dark:border-gray-600 object-contain"
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
