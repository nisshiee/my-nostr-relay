"use client";

import { useRef, useEffect, useState } from "react";
import Image from "next/image";
import type { NoteCard as NoteCardType, NostrProfile } from "../lib/types";
import type { NostrEvent } from "../types/nostr";
import { ContentRenderer } from "./content/ContentRenderer";
import { ActionBar } from "./ActionBar";
import { ReplyCompose } from "./ReplyCompose";
import type { EventCache } from "../hooks/useEventCache";

/** npubの省略表示を生成 */
function shortenPubkey(pubkey: string): string {
  if (pubkey.length <= 12) return pubkey;
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}

/** 相対時刻を表示する（"3分前", "1時間前" など） */
function relativeTime(unixTimestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diffSec = now - unixTimestamp;

  const rtf = new Intl.RelativeTimeFormat("ja", { numeric: "auto" });

  if (diffSec < 60) {
    return rtf.format(-diffSec, "second");
  } else if (diffSec < 3600) {
    return rtf.format(-Math.floor(diffSec / 60), "minute");
  } else if (diffSec < 86400) {
    return rtf.format(-Math.floor(diffSec / 3600), "hour");
  } else {
    return rtf.format(-Math.floor(diffSec / 86400), "day");
  }
}

interface NoteCardProps {
  note: NoteCardType;
  profile?: NostrProfile;
  /** リポスターのプロフィール情報 */
  reposterProfile?: NostrProfile;
  /** リアクション集計（絵文字 → {件数, 画像URL, 送信者pubkey集合}） */
  reactions?: Map<string, { count: number; imageUrl?: string; pubkeys: Set<string> }>;
  /** 自分のpubkey（リアクション済み判定用） */
  myPubkey?: string;
  /** リアクション送信ハンドラ */
  onReaction?: (emoji: string, imageUrl?: string) => void;
  /** リポスト送信ハンドラ */
  onRepost?: () => void | Promise<void>;
  /** EventCache インスタンス（引用ノード表示用） */
  cache?: EventCache;
  /** pubkey → NostrProfile のマップ（引用ノード表示用） */
  profiles?: Map<string, NostrProfile>;
  onHeightChange?: (slotId: string, height: number) => void;
  onHold?: () => void;
  onRelease?: () => void;
  /** リプライPublish時のコールバック */
  onReplyPublish?: (
    signedEvent: NostrEvent & { id: string; sig: string },
    noteCard: { eventId: string; pubkey: string; content: string; tags: string[][]; created_at: number },
    /** リプライ対象のNoteCard情報（仮ThreadCard構築用） */
    originalNote: NoteCardType,
  ) => void;
  /** イベント送信関数 */
  publishEvent?: (event: NostrEvent) => Promise<void>;
  /** 自分のプロフィール（ReplyCompose で表示用） */
  myProfile?: NostrProfile;
  /** 引用ボタンクリック時のコールバック */
  onQuote?: () => void;
}

export function NoteCard({ note, profile, reposterProfile, reactions, myPubkey, onReaction, onRepost, cache, profiles, onHeightChange, onHold, onRelease, onReplyPublish, publishEvent, myProfile, onQuote }: NoteCardProps) {
  const displayName =
    profile?.display_name || profile?.name || shortenPubkey(note.pubkey);

  // リポスター名の表示（display_name > name > 短縮pubkey）
  const reposterName = note.repostInfo
    ? reposterProfile?.display_name || reposterProfile?.name || shortenPubkey(note.repostInfo.reposterPubkey)
    : undefined;
  const avatarUrl = profile?.picture;
  const cardRef = useRef<HTMLDivElement>(null);
  const [isActionBarOpen, setIsActionBarOpen] = useState(false);
  const [isReplyMode, setIsReplyMode] = useState(false);
  const isHoveringRef = useRef(false);
  const isEmojiPickerOpenRef = useRef(false);

  // ResizeObserver でカードの高さを測定して親に通知
  useEffect(() => {
    const el = cardRef.current;
    if (!el || !onHeightChange) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        onHeightChange(note.slotId, entry.borderBoxSize[0].blockSize);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [note.slotId, onHeightChange]);

  // Click outside でアクションバーを閉じる（モバイル対応）
  // ※ 絵文字ピッカー（Portal描画）内のクリックはカード内扱いにする
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node;
      if (cardRef.current && !cardRef.current.contains(target)) {
        // 絵文字ピッカーPopover内のクリックは無視する
        const popover = document.querySelector("[data-emoji-picker-popover]");
        if (popover && popover.contains(target)) return;

        setIsActionBarOpen(false);
        onRelease?.();
      }
    };

    if (isActionBarOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("touchstart", handleClickOutside as EventListener);
      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
        document.removeEventListener("touchstart", handleClickOutside as EventListener);
      };
    }
  }, [isActionBarOpen]);

  // カードクリック → アクションバーのトグル（テキスト選択中は無視）
  // リプライモード中はアクションバーをトグルしない
  const handleCardClick = (e: React.MouseEvent) => {
    if (isReplyMode) return;
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) {
      return;
    }
    setIsActionBarOpen((prev) => {
      const next = !prev;
      // アクションバーを開いたらホールド開始、閉じたらホールド解除
      if (next) {
        onHold?.();
      } else {
        onRelease?.();
      }
      return next;
    });
  };

  // ホバー外れ → 少し遅延してからアクションバーを閉じる（子要素間の移動による一瞬のleaveを無視）
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMouseEnter = () => {
    isHoveringRef.current = true;
    if (leaveTimerRef.current) {
      clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
  };

  const handleMouseLeave = () => {
    isHoveringRef.current = false;
    leaveTimerRef.current = setTimeout(() => {
      if (!isHoveringRef.current && !isEmojiPickerOpenRef.current) {
        setIsActionBarOpen(false);
        onRelease?.();
      }
    }, 100);
  };

  // タイマークリーンアップ
  useEffect(() => {
    return () => {
      if (leaveTimerRef.current) {
        clearTimeout(leaveTimerRef.current);
      }
    };
  }, []);

  return (
    <div
      ref={cardRef}
      onClick={handleCardClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={`rounded-xl border bg-white dark:bg-gray-800 px-4 pt-4 hover:shadow-md dark:hover:shadow-gray-900/50 cursor-pointer relative ${
        isReplyMode
          ? "border-purple-200 dark:border-purple-800 border-l-[3px] border-l-purple-400 dark:border-l-purple-500 z-10 pb-4"
          : `border-gray-200 dark:border-gray-700 ${isActionBarOpen ? "z-10 pb-2" : "pb-4"}`
      }`}
    >
      {/* リプライモード: スレッドヘッダー */}
      {isReplyMode && (
        <div className="text-xs font-semibold text-purple-600 dark:text-purple-400 mb-2">
          🧵 スレッド
        </div>
      )}
      {/* リポスト情報（カード最上部） */}
      {note.repostInfo && (
        <div className="mb-2 text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
          <span>🔁</span>
          <span>{reposterName}がリポスト</span>
        </div>
      )}

      {/* ヘッダー: アバター + 名前 + 時刻 */}
      <div className="flex items-center gap-3 mb-2">
        {/* アバター */}
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

        {/* 名前と時刻 */}
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
            {displayName}
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {relativeTime(note.created_at)}
          </span>
        </div>
      </div>

      {/* テキスト内容（ContentRendererでリッチコンテンツを描画） */}
      <ContentRenderer content={note.content} onHold={onHold} onRelease={onRelease} cache={cache} profiles={profiles} tags={note.tags} />

      {/* リアクションバッジ */}
      {reactions && reactions.size > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {Array.from(reactions.entries()).map(([emoji, { count, imageUrl, pubkeys }]) => {
            const reacted = !!(myPubkey && pubkeys.has(myPubkey));
            return (
              <button
                key={emoji}
                type="button"
                disabled={reacted}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!reacted && onReaction) {
                    onReaction(emoji, imageUrl);
                  }
                }}
                className={`rounded-full px-2 py-0.5 text-xs inline-flex items-center gap-1 transition-colors ${
                  reacted
                    ? "bg-blue-100 dark:bg-blue-900/40 border border-blue-400 dark:border-blue-500 text-blue-700 dark:text-blue-300 cursor-not-allowed"
                    : "bg-gray-100 dark:bg-gray-700 border border-transparent cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-600"
                }`}
              >
                {imageUrl ? (
                  <img
                    src={imageUrl}
                    alt={emoji}
                    className="inline-block h-4 w-4"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  emoji
                )}{" "}
                {count}
              </button>
            );
          })}
        </div>
      )}

      {/* アクションバー（リプライモード中は非表示） */}
      <ActionBar
        isOpen={isReplyMode ? false : isActionBarOpen}
        onReply={onReplyPublish && publishEvent ? () => {
          setIsReplyMode(true);
          onHold?.();
        } : undefined}
        onThumbsUp={async () => {
          try {
            if (onReaction) {
              await onReaction("+"); // Nostrプロトコル上の「👍」相当（NIP-25）
            }
          } catch (e) {
            console.error(e);
          } finally {
            setIsActionBarOpen(false); // エラー発生時も必ず閉じる
            onRelease?.();
          }
        }}
        isAlreadyReacted={!!(myPubkey && reactions?.get("+")?.pubkeys?.has(myPubkey))}
        onRepost={async () => {
          try {
            if (onRepost) {
              await onRepost();
            }
          } catch (e) {
            console.error(e);
          } finally {
            setIsActionBarOpen(false);
            onRelease?.();
          }
        }}
        isAlreadyReposted={false}
        onQuote={onQuote ? async () => {
          setIsActionBarOpen(false);
          onRelease?.();
          onQuote();
        } : undefined}
        onPickerOpenChange={(open) => {
          isEmojiPickerOpenRef.current = open;
        }}
        onEmojiSelect={async (emoji) => {
          try {
            if (onReaction) {
              await onReaction(emoji);
            }
          } catch (e) {
            console.error(e);
          } finally {
            setIsActionBarOpen(false);
            onRelease?.();
          }
        }}
      />

      {/* リプライモード: ReplyCompose */}
      {isReplyMode && publishEvent && myPubkey && (
        <ReplyCompose
          replyTarget={{
            targetEventId: note.eventId,
            targetPubkey: note.pubkey,
            rootEventId: note.eventId,
          }}
          replyToDisplayName={displayName}
          myPubkey={myPubkey}
          myProfile={myProfile}
          onPublish={(signedEvent, noteCard) => {
            onReplyPublish?.(signedEvent, noteCard, note);
            setIsReplyMode(false);
            onRelease?.();
          }}
          onClose={() => {
            setIsReplyMode(false);
            onRelease?.();
          }}
          publishEvent={publishEvent}
          onHold={onHold}
          onRelease={onRelease}
          autoFocus
        />
      )}
    </div>
  );
}
