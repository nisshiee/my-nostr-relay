"use client";

import { useRef, useEffect, useState } from "react";
import Image from "next/image";
import type {
  ThreadCard as ThreadCardType,
  ThreadNote,
  NostrProfile,
  Reactions,
} from "../lib/types";
import { ContentRenderer } from "./content/ContentRenderer";
import type { EventCache } from "../hooks/useEventCache";
import { ActionBar } from "./ActionBar";

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

/** プロフィールから表示名を解決する */
function resolveDisplayName(
  pubkey: string | undefined,
  profiles: Map<string, NostrProfile>,
): string {
  if (!pubkey) return "不明なユーザー";
  const profile = profiles.get(pubkey);
  return profile?.display_name || profile?.name || shortenPubkey(pubkey);
}

interface ThreadCardProps {
  thread: ThreadCardType;
  profiles: Map<string, NostrProfile>;
  /** リアクション集計: eventId → (絵文字 → {件数, 画像URL, 送信者pubkey集合}) */
  reactions: Reactions;
  /** 自分のpubkey（リアクション済み判定用） */
  myPubkey?: string;
  /** リアクション送信ハンドラ */
  onReaction?: (
    targetEventId: string,
    targetPubkey: string,
    emoji: string,
    imageUrl?: string,
  ) => void;
  onHeightChange?: (slotId: string, height: number) => void;
  onHold?: () => void;
  onRelease?: () => void;
  /** EventCache インスタンス（引用ノード表示用） */
  cache?: EventCache;
}

export function ThreadCard({
  thread,
  profiles,
  reactions,
  myPubkey,
  onReaction,
  onHeightChange,
  onHold,
  onRelease,
  cache,
}: ThreadCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);

  // ResizeObserver でカードの高さを測定して親に通知
  useEffect(() => {
    const el = cardRef.current;
    if (!el || !onHeightChange) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        onHeightChange(thread.slotId, entry.borderBoxSize[0].blockSize);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [thread.slotId, onHeightChange]);

  // Click outside でアクションバーを閉じる
  // ※ 絵文字ピッカー（Portal描画）内のクリックはカード内扱いにする
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node;
      if (
        cardRef.current &&
        !cardRef.current.contains(target)
      ) {
        // 絵文字ピッカーPopover内のクリックは無視する
        const popover = document.querySelector("[data-emoji-picker-popover]");
        if (popover && popover.contains(target)) return;

        setActiveNoteId(null);
        onRelease?.();
      }
    };

    if (activeNoteId) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener(
        "touchstart",
        handleClickOutside as EventListener,
      );
      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
        document.removeEventListener(
          "touchstart",
          handleClickOutside as EventListener,
        );
      };
    }
  }, [activeNoteId, onRelease]);

  /** ノートクリック → アクションバーのトグル */
  const handleNoteClick = (noteEventId: string, e: React.MouseEvent) => {
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) return;

    setActiveNoteId((prev) => {
      const next = prev === noteEventId ? null : noteEventId;
      if (next) {
        onHold?.();
      } else {
        onRelease?.();
      }
      return next;
    });
  };

  // ホバー外れ → 少し遅延してからアクションバーを閉じる
  const isHoveringRef = useRef(false);
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
        setActiveNoteId(null);
        onRelease?.();
      }
    }, 100);
  };

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
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={`rounded-xl border border-purple-200 dark:border-purple-800 bg-white dark:bg-gray-800 border-l-[3px] border-l-purple-400 dark:border-l-purple-500 hover:shadow-md dark:hover:shadow-gray-900/50 ${
        activeNoteId ? "z-10" : ""
      }`}
    >
      {/* スレッドヘッダー */}
      <div className="px-3 pt-3 pb-1.5 text-xs font-semibold text-purple-600 dark:text-purple-400">
        🧵 スレッド ({thread.notes.length}件)
      </div>

      {/* ノート一覧 */}
      {thread.notes.map((note, index) => {
        const noteReactions = reactions.get(note.eventId);
        const isActive = activeNoteId === note.eventId;

        return (
          <ThreadNoteItem
            key={note.eventId}
            note={note}
            profiles={profiles}
            noteReactions={noteReactions}
            myPubkey={myPubkey}
            onReaction={onReaction}
            isActive={isActive}
            isLast={index === thread.notes.length - 1}
            showDivider={index > 0}
            onClick={(e) => handleNoteClick(note.eventId, e)}
            onActionComplete={() => {
              setActiveNoteId(null);
              onRelease?.();
            }}
            onHold={onHold}
            onRelease={onRelease}
            cache={cache}
          />
        );
      })}
    </div>
  );
}

// ─── 個別ノートアイテム ───────────────────────────────

interface ThreadNoteItemProps {
  note: ThreadNote;
  profiles: Map<string, NostrProfile>;
  noteReactions?: Map<
    string,
    { count: number; imageUrl?: string; pubkeys: Set<string> }
  >;
  myPubkey?: string;
  onReaction?: (
    targetEventId: string,
    targetPubkey: string,
    emoji: string,
    imageUrl?: string,
  ) => void;
  isActive: boolean;
  isLast: boolean;
  showDivider: boolean;
  onClick: (e: React.MouseEvent) => void;
  /** リアクション送信完了後のコールバック（アクションバーを閉じる等） */
  onActionComplete?: () => void;
  onHold?: () => void;
  onRelease?: () => void;
  cache?: EventCache;
}

function ThreadNoteItem({
  note,
  profiles,
  noteReactions,
  myPubkey,
  onReaction,
  isActive,
  isLast,
  showDivider,
  onClick,
  onActionComplete,
  onHold,
  onRelease,
  cache,
}: ThreadNoteItemProps) {
  const profile = profiles.get(note.pubkey);
  const displayName =
    profile?.display_name || profile?.name || shortenPubkey(note.pubkey);
  const avatarUrl = profile?.picture;

  // 返信先の表示名を解決
  const replyToName = note.replyTo
    ? resolveDisplayName(note.replyTo.pubkey, profiles)
    : null;

  return (
    <>
      {/* 区切り線 */}
      {showDivider && (
        <div className="mx-3 border-t border-gray-100 dark:border-gray-700" />
      )}

      <div
        onClick={onClick}
        className={`px-3 py-2 cursor-pointer relative ${
          isLast ? "pb-3 rounded-b-xl" : ""
        } ${isActive ? "bg-gray-50 dark:bg-gray-750" : ""}`}
      >
        {/* 返信先インジケータ */}
        {replyToName && (
          <div className="text-[11px] text-gray-400 dark:text-gray-500 mb-0.5 ml-8">
            ↩ {replyToName}
          </div>
        )}

        {/* ヘッダー: アバター + 名前 + 時刻 */}
        <div className="flex items-center gap-2 mb-1">
          {avatarUrl ? (
            <Image
              src={avatarUrl}
              alt={displayName}
              width={24}
              height={24}
              className="h-6 w-6 shrink-0 rounded-full object-cover"
              unoptimized
            />
          ) : (
            <div className="w-6 h-6 rounded-full bg-gradient-to-br from-purple-400 to-blue-500 flex items-center justify-center flex-shrink-0">
              <span className="text-white text-[10px] font-bold">
                {displayName.charAt(0).toUpperCase()}
              </span>
            </div>
          )}

          <div className="flex items-baseline gap-1.5 min-w-0 flex-1">
            <span className="text-xs font-semibold text-gray-900 dark:text-gray-100 truncate">
              {displayName}
            </span>
            <span className="text-[11px] text-gray-400 dark:text-gray-500 flex-shrink-0">
              {relativeTime(note.created_at)}
            </span>
          </div>
        </div>

        {/* コンテンツ */}
        <div className="ml-8 text-sm">
          <ContentRenderer
            content={note.content}
            onHold={onHold}
            onRelease={onRelease}
            cache={cache}
            profiles={profiles}
            tags={note.tags}
          />
        </div>

        {/* リアクションバッジ */}
        {noteReactions && noteReactions.size > 0 && (
          <div className="mt-1.5 ml-8 flex flex-wrap gap-1">
            {Array.from(noteReactions.entries()).map(
              ([emoji, { count, imageUrl, pubkeys }]) => {
                const reacted = !!(myPubkey && pubkeys.has(myPubkey));
                return (
                  <button
                    key={emoji}
                    type="button"
                    disabled={reacted}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!reacted && onReaction) {
                        onReaction(note.eventId, note.pubkey, emoji, imageUrl);
                      }
                    }}
                    className={`rounded-full px-1.5 py-0.5 text-[11px] inline-flex items-center gap-0.5 transition-colors ${
                      reacted
                        ? "bg-blue-100 dark:bg-blue-900/40 border border-blue-400 dark:border-blue-500 text-blue-700 dark:text-blue-300 cursor-not-allowed"
                        : "bg-gray-100 dark:bg-gray-700 border border-transparent cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-600"
                    }`}
                  >
                    {imageUrl ? (
                      <img
                        src={imageUrl}
                        alt={emoji}
                        className="inline-block h-3.5 w-3.5"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      emoji
                    )}{" "}
                    {count}
                  </button>
                );
              },
            )}
          </div>
        )}

        {/* アクションバー（アクティブなノートのみ） */}
        <ActionBar
          isOpen={isActive}
          onThumbsUp={async () => {
            try {
              if (onReaction) {
                await onReaction(note.eventId, note.pubkey, "+");
              }
            } catch (e) {
              console.error(e);
            } finally {
              onActionComplete?.();
            }
          }}
          isAlreadyReacted={
            !!(myPubkey && noteReactions?.get("+")?.pubkeys?.has(myPubkey))
          }
          onRepost={() => {
            // スレッド内ノートのリポストは未実装（将来対応）
          }}
          isAlreadyReposted={false}
          onEmojiSelect={async (emoji) => {
            try {
              if (onReaction) {
                await onReaction(note.eventId, note.pubkey, emoji);
              }
            } catch (e) {
              console.error(e);
            } finally {
              onActionComplete?.();
            }
          }}
        />
      </div>
    </>
  );
}
