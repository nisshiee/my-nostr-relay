"use client";

import React, { useState } from "react";
import { KeyRound } from "lucide-react";
import { validateCanvasImageSource } from "../lib/canvasImagePolicy";
import type { NostrProfile } from "../lib/types";
import Image from "./CanvasAwareImage";
import { resolveProfileDisplayName } from "./NoteCardContent";
import { StatusIndicator } from "./StatusIndicator";

interface CanvasHeaderProps {
  status: "connecting" | "loading" | "connected" | "error";
  pubkey: string;
  profile?: NostrProfile;
  onOpenProfile: () => void;
  onAddDraft: () => void;
  onLogout: () => void;
  showSignerControl: boolean;
  onManageSigner: () => void;
  onOpenSettings?: () => void;
  settingsOpen?: boolean;
  settingsTrigger?: React.RefObject<HTMLButtonElement | null>;
}

interface HeaderProfileButtonProps {
  pubkey: string;
  profile?: NostrProfile;
  onOpenProfile: () => void;
}

/** 認証中ユーザーのアイコン。画像を表示できない場合はカードと同じ頭文字表示へ戻す。 */
function HeaderProfileButton({ pubkey, profile, onOpenProfile }: HeaderProfileButtonProps) {
  const displayName = resolveProfileDisplayName(pubkey, profile);
  const avatarUrl = profile?.picture;
  const [failedAvatarUrl, setFailedAvatarUrl] = useState<string | null>(null);
  const avatarSource = avatarUrl ? validateCanvasImageSource(avatarUrl) : null;
  const showAvatar = Boolean(avatarUrl && avatarSource?.allowed && failedAvatarUrl !== avatarUrl);

  return (
    <button
      type="button"
      onClick={onOpenProfile}
      className="h-8 w-8 shrink-0 overflow-hidden rounded-full transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-500"
      aria-label={`${displayName}の投稿一覧を開く`}
      title={`${displayName}の投稿一覧を開く`}
    >
      {showAvatar && avatarUrl ? (
        <Image
          src={avatarUrl}
          alt=""
          width={32}
          height={32}
          className="h-8 w-8 rounded-full object-cover"
          unoptimized
          onError={() => setFailedAvatarUrl(avatarUrl)}
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-purple-400 to-blue-500 text-xs font-bold text-white"
        >
          {displayName.charAt(0).toUpperCase()}
        </span>
      )}
    </button>
  );
}

/** キャンバスのヘッダー（タイトル、ステータス、投稿ボタン、プロフィール、ログアウトボタン） */
export function CanvasHeader({ status, pubkey, profile, onOpenProfile, onAddDraft, onLogout, showSignerControl, onManageSigner, onOpenSettings, settingsOpen, settingsTrigger }: CanvasHeaderProps): React.ReactNode {
  return (
    <header className="flex shrink-0 items-center justify-between gap-2 border-b border-gray-200 bg-white px-3 py-3 sm:px-6 dark:border-gray-800 dark:bg-gray-900">
      <div className="flex min-w-0 items-center gap-2 sm:gap-4">
        <img src="/icon.svg" alt="" width={28} height={28} className="rounded-md" />
        <h1 className="hidden text-lg font-bold text-gray-900 sm:block dark:text-gray-100">
          Nostr Live Canvas
        </h1>
        <StatusIndicator status={status} />
      </div>
      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        <button
          type="button"
          onClick={onAddDraft}
          className="shrink-0 rounded-lg bg-purple-500 px-2.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-purple-600 sm:px-3"
          title="新規投稿 (n)"
        >
          ✏️ <span className="hidden sm:inline">投稿</span>
        </button>
        <HeaderProfileButton pubkey={pubkey} profile={profile} onOpenProfile={onOpenProfile} />
        {onOpenSettings && <button ref={settingsTrigger} type="button" onClick={onOpenSettings} aria-haspopup="dialog" aria-expanded={settingsOpen} className="shrink-0 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs dark:border-gray-600">設定</button>}
        {showSignerControl && (
          <button
            type="button"
            onClick={onManageSigner}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-500 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            aria-label="リモート署名器を管理"
            title="リモート署名器を管理"
          >
            <KeyRound aria-hidden="true" size={14} />
            <span className="hidden sm:inline">署名器</span>
          </button>
        )}
        <button
          type="button"
          onClick={onLogout}
          className="shrink-0 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700 sm:px-3"
        >
          <span className="hidden sm:inline">ログアウト</span>
          <span className="sm:hidden" aria-hidden="true">退出</span>
        </button>
      </div>
    </header>
  );
}
