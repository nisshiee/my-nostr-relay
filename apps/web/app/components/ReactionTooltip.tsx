"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import type { NostrProfile } from "../lib/types";

interface ReactionTooltipProps {
  isOpen: boolean;
  /** リアクションした人のpubkey配列 */
  pubkeys: string[];
  /** pubkey → NostrProfile のマップ */
  profiles: Map<string, NostrProfile>;
  /** ツールチップのアンカー要素（位置計算用） */
  anchorElement: HTMLElement | null;
}

/** pubkeyを短縮表示する（先頭8文字…末尾4文字） */
function shortenPubkey(pubkey: string): string {
  if (pubkey.length <= 12) return pubkey;
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}

/** 表示名を取得する（display_name → name → 短縮pubkey） */
function getDisplayName(
  pubkey: string,
  profiles: Map<string, NostrProfile>,
): string {
  const profile = profiles.get(pubkey);
  return profile?.display_name || profile?.name || shortenPubkey(pubkey);
}

/** 最大表示人数 */
const MAX_DISPLAY = 5;

/** リアクションした人のツールチップコンポーネント（Portal描画） */
export function ReactionTooltip({
  isOpen,
  pubkeys,
  profiles,
  anchorElement,
}: ReactionTooltipProps) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>({
    top: 0,
    left: 0,
  });
  // アニメーション用: 実際にDOMにマウントするかどうか
  const [mounted, setMounted] = useState(false);
  // アニメーション用: opacity制御
  const [visible, setVisible] = useState(false);

  // Render-time state sync（useEffect内の同期的setStateを避ける）
  if (isOpen && !mounted) {
    setMounted(true);
  }
  if (!isOpen && visible) {
    setVisible(false);
  }

  /** アンカー要素の位置からツールチップの位置を計算する */
  const updatePosition = useCallback(() => {
    if (!anchorElement || !tooltipRef.current) return;
    const anchorRect = anchorElement.getBoundingClientRect();
    const tooltipRect = tooltipRef.current.getBoundingClientRect();
    const gap = 4; // アンカーとの間隔

    // 左端の調整
    let left = anchorRect.left + anchorRect.width / 2 - tooltipRect.width / 2;
    if (left + tooltipRect.width > window.innerWidth - 8) {
      left = window.innerWidth - tooltipRect.width - 8;
    }
    if (left < 8) left = 8;

    // 上に十分なスペースがあれば上に、なければ下に表示
    let top: number;
    if (anchorRect.top >= tooltipRect.height + gap) {
      // アンカーの上に表示
      top = anchorRect.top - tooltipRect.height - gap;
    } else {
      // アンカーの下に表示
      top = anchorRect.bottom + gap;
    }

    setPosition({ top, left });
  }, [anchorElement]);

  // isOpen → visibleのフェードイン（DOMマウント後に次フレームで発火）
  useEffect(() => {
    if (isOpen && mounted && !visible) {
      // 次フレームでvisibleにする（transitionを発火させるため）
      const raf1 = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setVisible(true);
        });
      });
      return () => cancelAnimationFrame(raf1);
    }
  }, [isOpen, mounted, visible]);

  // !isOpen → フェードアウト後にアンマウント
  useEffect(() => {
    if (!isOpen && mounted && !visible) {
      const timer = setTimeout(() => {
        setMounted(false);
      }, 150); // transitionと同じ時間
      return () => clearTimeout(timer);
    }
  }, [isOpen, mounted, visible]);

  // 位置の計算（マウント後 + スクロール/リサイズ時）
  useEffect(() => {
    if (!mounted) return;

    // マウント直後に位置計算
    requestAnimationFrame(() => {
      updatePosition();
    });

    const handleScroll = () => updatePosition();
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [mounted, updatePosition]);

  if (!mounted) return null;

  const displayPubkeys = pubkeys.slice(0, MAX_DISPLAY);
  const remaining = pubkeys.length - MAX_DISPLAY;

  return createPortal(
    <div
      ref={tooltipRef}
      data-reaction-tooltip
      className="fixed rounded-lg bg-gray-900/90 backdrop-blur-sm text-white shadow-lg px-3 py-2"
      style={{
        top: position.top,
        left: position.left,
        zIndex: 9999,
        opacity: visible ? 1 : 0,
        transition: "opacity 150ms ease-in-out",
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      <div className="flex flex-col gap-1">
        {displayPubkeys.map((pubkey) => {
          const profile = profiles.get(pubkey);
          const name = getDisplayName(pubkey, profiles);
          return (
            <div key={pubkey} className="flex items-center gap-2">
              {/* アバター画像 */}
              {profile?.picture ? (
                <img
                  src={profile.picture}
                  alt={name}
                  className="w-5 h-5 rounded-full object-cover flex-shrink-0"
                />
              ) : (
                <div className="w-5 h-5 rounded-full bg-gray-600 flex-shrink-0" />
              )}
              <span className="text-xs truncate max-w-[160px]">{name}</span>
            </div>
          );
        })}
        {remaining > 0 && (
          <span className="text-xs text-gray-400">…他{remaining}人</span>
        )}
      </div>
    </div>,
    document.body,
  );
}
