"use client";

import { useEffect, useRef, useState } from "react";
import { MediaImage } from "./CanvasAwareImage";
import { ReactionTooltip } from "./ReactionTooltip";
import type { NostrProfile, ReactionSummary } from "../lib/types";

interface ReactionBadgesProps {
  reactions?: Map<string, ReactionSummary>;
  myPubkey?: string;
  profiles?: Map<string, NostrProfile>;
  fetchProfiles?: (pubkeys: string[]) => void;
  onReaction?: (emoji: string, imageUrl?: string) => void;
  disabled?: boolean;
  compact?: boolean;
}

const EMPTY_PROFILES = new Map<string, NostrProfile>();

/** 通常カード・スレッド・プロフィールで共通のバッジとリアクション者表示。 */
export function ReactionBadges({
  reactions, myPubkey, profiles = EMPTY_PROFILES, fetchProfiles, onReaction,
  disabled = false, compact = false,
}: ReactionBadgesProps) {
  const [active, setActive] = useState<{ key: string; anchor: HTMLElement } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longTap = useRef(false);
  const cancelTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const hide = () => { cancelTimer(); setActive(null); };
  const show = (key: string, anchor: HTMLElement, touch = false) => {
    cancelTimer();
    const entry = reactions?.get(key);
    const unknown = entry ? [...entry.pubkeys].filter(pk => !profiles.has(pk)) : [];
    if (unknown.length) fetchProfiles?.(unknown);
    timer.current = setTimeout(() => {
      longTap.current = touch;
      setActive({ key, anchor });
    }, 500);
  };
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);
  useEffect(() => {
    if (!active) return;
    const touch = (event: TouchEvent) => {
      if (!active.anchor.contains(event.target as Node)) setActive(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setActive(null);
    };
    // スクロール後に画面外へ残るツールチップは閉じる。
    const scroll = () => setActive(null);
    document.addEventListener("touchstart", touch);
    document.addEventListener("keydown", escape);
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("touchstart", touch);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [active]);

  if (!reactions?.size) return null;
  const tooltip = active ? reactions.get(active.key) : undefined;
  return (
    <div className={compact ? "mt-1.5 ml-8 flex flex-wrap gap-1" : "mt-2 flex flex-wrap gap-1.5"}>
      {[...reactions].map(([key, { emoji, count, imageUrl, pubkeys }]) => {
        const reacted = !!myPubkey && pubkeys.has(myPubkey);
        return (
          <button key={key} type="button"
            aria-label={`${emoji} ${count}件${reacted ? "（リアクション済み）" : ""}`}
            aria-disabled={reacted || disabled || undefined}
            onClick={event => {
              event.stopPropagation();
              if (longTap.current) { longTap.current = false; return; }
              if (!reacted && !disabled) onReaction?.(emoji, imageUrl);
            }}
            onMouseEnter={event => show(key, event.currentTarget)}
            onMouseLeave={hide}
            onFocus={event => show(key, event.currentTarget)}
            onBlur={hide}
            onTouchStart={event => { longTap.current = false; show(key, event.currentTarget, true); }}
            onTouchEnd={event => { cancelTimer(); if (longTap.current) event.preventDefault(); }}
            onTouchCancel={hide}
            onTouchMove={hide}
            className={`rounded-full py-0.5 inline-flex items-center transition-colors ${compact ? "px-1.5 text-[11px] gap-0.5" : "px-2 text-xs gap-1"} ${reacted
              ? "bg-blue-100 dark:bg-blue-900/40 border border-blue-400 dark:border-blue-500 text-blue-700 dark:text-blue-300 cursor-not-allowed"
              : "bg-gray-100 dark:bg-gray-700 border border-transparent cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-600"} ${disabled ? "opacity-60" : ""}`}>
            {imageUrl ? <MediaImage src={imageUrl} alt={emoji}
              className={compact ? "inline-block h-3.5 w-3.5" : "inline-block h-4 w-4"}
              referrerPolicy="no-referrer" /> : emoji}{" "}{count}
          </button>
        );
      })}
      {active && tooltip && <ReactionTooltip isOpen pubkeys={[...tooltip.pubkeys]}
        profiles={profiles} anchorElement={active.anchor} />}
    </div>
  );
}
