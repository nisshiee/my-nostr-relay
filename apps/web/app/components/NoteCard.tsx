"use client";

import { useRef, useEffect, useState } from "react";
import Image from "next/image";
import type { NoteCard as NoteCardType, NostrProfile } from "../lib/types";
import { ContentRenderer } from "./content/ContentRenderer";
import { ActionBar } from "./ActionBar";
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
}

export function NoteCard({ note, profile, reposterProfile, reactions, myPubkey, onReaction, onRepost, cache, profiles, onHeightChange, onHold, onRelease }: NoteCardProps) {
  const displayName =
    profile?.display_name || profile?.name || shortenPubkey(note.pubkey);

  // リポスター名の表示（display_name > name > 短縮pubkey）
  const reposterName = note.repostInfo
    ? reposterProfile?.display_name || reposterProfile?.name || shortenPubkey(note.repostInfo.reposterPubkey)
    : undefined;
  const avatarUrl = profile?.picture;
  const cardRef = useRef<HTMLDivElement>(null);
  const [isActionBarOpen, setIsActionBarOpen] = useState(false);
  const isHoveringRef = useRef(false);

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
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      if (cardRef.current && !cardRef.current.contains(event.target as Node)) {
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
  const handleCardClick = (e: React.MouseEvent) => {
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
      if (!isHoveringRef.current) {
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
      className={`rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 pt-4 hover:shadow-md dark:hover:shadow-gray-900/50 cursor-pointer relative ${
        isActionBarOpen ? "z-10 pb-2" : "pb-4"
      }`}
    >
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

      {/* アクションバー */}
      <ActionBar
        isOpen={isActionBarOpen}
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
      />
    </div>
  );
}
