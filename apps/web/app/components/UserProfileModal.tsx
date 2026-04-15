"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import type { Event } from "nostr-tools/core";
import type { EventCache } from "../hooks/useEventCache";
import { useUserRecentNotes } from "../hooks/useUserRecentNotes";
import { encodeNpub } from "../lib/nip19";
import type { NostrProfile } from "../lib/types";
import { NoteCardContent, resolveProfileDisplayName } from "./NoteCardContent";

interface UserProfileModalProps {
  pubkey: string;
  profile?: NostrProfile;
  isOpen: boolean;
  onClose: () => void;
  fetchProfiles: (pubkeys: string[]) => void;
  fetchUserRecentNotes: (pubkey: string) => Promise<Event[]>;
  cache: EventCache;
  profiles: Map<string, NostrProfile>;
  isFollowing: boolean;
  follow: (targetPubkey: string) => Promise<void>;
  unfollow: (targetPubkey: string) => Promise<void>;
}

const RECENT_NOTES_PANEL_MIN_HEIGHT_CLASS = "min-h-[420px]";

function RecentNotesLoadingSkeleton() {
  return (
    <div className={`space-y-3 ${RECENT_NOTES_PANEL_MIN_HEIGHT_CLASS}`} aria-hidden="true">
      {Array.from({ length: 3 }).map((_, index) => (
        <div
          key={index}
          className="rounded-xl border border-gray-200 bg-white px-4 py-4 dark:border-gray-700 dark:bg-gray-800"
        >
          <div className="animate-pulse">
            <div className="mb-3 flex items-center gap-3">
              <div className="h-8 w-8 rounded-full bg-gray-200 dark:bg-gray-700" />
              <div className="flex-1 space-y-2">
                <div className="h-3 w-32 rounded bg-gray-200 dark:bg-gray-700" />
                <div className="h-2.5 w-20 rounded bg-gray-200 dark:bg-gray-700" />
              </div>
            </div>
            <div className="space-y-2">
              <div className="h-3 w-full rounded bg-gray-200 dark:bg-gray-700" />
              <div className="h-3 w-5/6 rounded bg-gray-200 dark:bg-gray-700" />
              <div className="h-3 w-2/3 rounded bg-gray-200 dark:bg-gray-700" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function UserProfileModal({
  pubkey,
  profile,
  isOpen,
  onClose,
  fetchProfiles,
  fetchUserRecentNotes,
  cache,
  profiles,
  isFollowing,
  follow,
  unfollow,
}: UserProfileModalProps) {
  const { notes, isLoading, error } = useUserRecentNotes({
    pubkey: isOpen ? pubkey : null,
    enabled: isOpen,
    fetchUserRecentNotes,
  });
  const [isSubmittingFollow, setIsSubmittingFollow] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    fetchProfiles([pubkey]);
  }, [isOpen, pubkey, fetchProfiles]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    setIsSubmittingFollow(false);
    setFollowError(null);
  }, [isOpen, pubkey]);

  if (!isOpen) return null;

  const displayName = resolveProfileDisplayName(pubkey, profile);
  const avatarUrl = profile?.picture;
  const bannerUrl = profile?.banner;
  const npub = encodeNpub(pubkey);

  const handleFollowClick = async () => {
    setIsSubmittingFollow(true);
    setFollowError(null);

    try {
      if (isFollowing) {
        await unfollow(pubkey);
      } else {
        await follow(pubkey);
      }
    } catch (err) {
      setFollowError(err instanceof Error ? err.message : "フォロー状態を更新できませんでした");
    } finally {
      setIsSubmittingFollow(false);
    }
  };

  return createPortal(
    <motion.div
      key="user-profile-modal-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 px-4 py-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, y: 8 }}
        transition={{ duration: 0.2 }}
        className="relative flex h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-gray-50 shadow-2xl dark:border-gray-700 dark:bg-gray-900"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 z-10 rounded-full bg-white/90 p-2 text-gray-500 transition-colors hover:text-gray-900 dark:bg-gray-800/90 dark:text-gray-400 dark:hover:text-gray-100"
          aria-label="閉じる"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <div
          className={`border-b border-gray-200 dark:border-gray-700 ${
            bannerUrl
              ? "relative overflow-hidden bg-gray-900"
              : "bg-white dark:bg-gray-800"
          }`}
        >
          {bannerUrl && (
            <>
              <div className="absolute inset-0">
                <Image
                  src={bannerUrl}
                  alt={`${displayName} banner`}
                  fill
                  className="object-cover"
                  unoptimized
                />
              </div>
              <div className="absolute inset-0 bg-gradient-to-b from-black/35 via-black/45 to-black/60" />
              <div className="absolute inset-x-0 bottom-0 h-20 bg-white/10 backdrop-blur-[1px] dark:bg-black/10" />
            </>
          )}

          <div
            className={`relative px-6 ${bannerUrl ? "py-5 text-white" : "py-6"} sm:px-8`}
          >
            <div className="flex items-start justify-between gap-4 sm:gap-5">
              <div className="flex min-w-0 flex-1 items-start gap-4 sm:gap-5">
                {avatarUrl ? (
                  <Image
                    src={avatarUrl}
                    alt={displayName}
                    width={72}
                    height={72}
                    className={`h-16 w-16 rounded-full object-cover sm:h-[72px] sm:w-[72px] ${
                      bannerUrl ? "ring-2 ring-white/70" : ""
                    }`}
                    unoptimized
                  />
                ) : (
                  <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-purple-400 to-blue-500 sm:h-[72px] sm:w-[72px]">
                    <span className="text-xl font-bold text-white">{displayName.charAt(0).toUpperCase()}</span>
                  </div>
                )}

                <div className="min-w-0 flex-1 pr-2 sm:pr-6">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <h2
                      className={`truncate text-xl font-semibold sm:text-2xl ${
                        bannerUrl ? "text-white" : "text-gray-900 dark:text-gray-100"
                      }`}
                    >
                      {displayName}
                    </h2>
                    {profile?.name && profile.name !== displayName && (
                      <span
                        className={`truncate text-sm ${
                          bannerUrl ? "text-gray-200" : "text-gray-500 dark:text-gray-400"
                        }`}
                      >
                        @{profile.name}
                      </span>
                    )}
                  </div>
                  <div
                    className={`mt-1 break-all text-xs leading-5 select-all ${
                      bannerUrl ? "text-gray-200" : "text-gray-500 dark:text-gray-400"
                    }`}
                    title={npub}
                  >
                    {npub}
                  </div>
                  {profile?.nip05 && (
                    <div
                      className={`mt-2 text-sm ${
                        bannerUrl ? "text-purple-100" : "text-purple-600 dark:text-purple-400"
                      }`}
                    >
                      {profile.nip05}
                    </div>
                  )}
                  {profile?.about && (
                    <p
                      className={`mt-3 whitespace-pre-wrap text-sm leading-6 ${
                        bannerUrl ? "text-gray-100" : "text-gray-700 dark:text-gray-300"
                      }`}
                    >
                      {profile.about}
                    </p>
                  )}
                </div>
              </div>

              <div className="relative z-10 mt-10 flex shrink-0 flex-col items-end gap-2 sm:mt-0 sm:pr-12">
                <button
                  type="button"
                  onClick={handleFollowClick}
                  disabled={isSubmittingFollow}
                  className={`inline-flex min-w-[112px] items-center justify-center rounded-full px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${
                    isFollowing
                      ? bannerUrl
                        ? "border border-white/30 bg-white/10 text-white hover:bg-white/15"
                        : "border border-gray-300 bg-white text-gray-900 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700"
                      : bannerUrl
                        ? "bg-purple-500 text-white hover:bg-purple-400"
                        : "bg-purple-600 text-white hover:bg-purple-700 dark:bg-purple-500 dark:hover:bg-purple-400"
                  }`}
                >
                  {isSubmittingFollow ? "Updating..." : isFollowing ? "Following" : "Follow"}
                </button>
                {followError && (
                  <p
                    className={`max-w-[220px] text-right text-xs ${
                      bannerUrl ? "text-red-100" : "text-red-600 dark:text-red-400"
                    }`}
                  >
                    {followError}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Recent notes
            </h3>
            <span className="text-xs text-gray-500 dark:text-gray-400">最新50件</span>
          </div>

          {isLoading ? (
            <RecentNotesLoadingSkeleton />
          ) : error ? (
            <div className={`flex items-center ${RECENT_NOTES_PANEL_MIN_HEIGHT_CLASS}`}>
              <div className="w-full rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
                {error}
              </div>
            </div>
          ) : notes.length === 0 ? (
            <div className={`flex items-center ${RECENT_NOTES_PANEL_MIN_HEIGHT_CLASS}`}>
              <div className="w-full rounded-xl border border-gray-200 bg-white px-4 py-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
                recent note はありません
              </div>
            </div>
          ) : (
            <div className={`space-y-3 ${RECENT_NOTES_PANEL_MIN_HEIGHT_CLASS}`}>
              {notes.map((note) => (
                <div
                  key={note.id}
                  className="rounded-xl border border-gray-200 bg-white px-4 py-4 dark:border-gray-700 dark:bg-gray-800"
                >
                  <NoteCardContent
                    note={note}
                    profile={profile}
                    onHold={() => undefined}
                    onRelease={() => undefined}
                    cache={cache}
                    profiles={profiles}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}
