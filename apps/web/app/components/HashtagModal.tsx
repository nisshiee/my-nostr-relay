"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import type { Event } from "nostr-tools/core";
import type { EventCache } from "../hooks/useEventCache";
import { useHashtagNotes } from "../hooks/useHashtagNotes";
import type { NostrProfile } from "../lib/types";
import { normalizeHashtag } from "../lib/hashtags";
import { NoteCardContent } from "./NoteCardContent";

interface HashtagModalProps {
  tag: string;
  isOpen: boolean;
  onClose: () => void;
  fetchHashtagNotes: (tag: string) => Promise<Event[]>;
  cache: EventCache;
  profiles: Map<string, NostrProfile>;
  onHashtagClick?: (tag: string) => void;
}

const HASHTAG_NOTES_PANEL_MIN_HEIGHT_CLASS = "min-h-[420px]";

function HashtagNotesLoadingSkeleton() {
  return (
    <div className={`space-y-3 ${HASHTAG_NOTES_PANEL_MIN_HEIGHT_CLASS}`} aria-hidden="true">
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

export function HashtagModal({
  tag,
  isOpen,
  onClose,
  fetchHashtagNotes,
  cache,
  profiles,
  onHashtagClick,
}: HashtagModalProps) {
  const normalizedTag = normalizeHashtag(tag);
  const { notes, isLoading, error } = useHashtagNotes({
    tag: isOpen ? normalizedTag : null,
    enabled: isOpen,
    fetchHashtagNotes,
  });

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

  if (!isOpen) return null;

  return createPortal(
    <motion.div
      key="hashtag-modal-overlay"
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
          className="absolute right-4 top-5 z-20 cursor-pointer rounded-full bg-white/90 p-2 text-gray-500 transition-colors hover:text-gray-900 dark:bg-gray-800/90 dark:text-gray-400 dark:hover:text-gray-100"
          aria-label="閉じる"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <div className="border-b border-gray-200 bg-white px-6 py-6 dark:border-gray-700 dark:bg-gray-800 sm:px-8">
          <h2 className="truncate pr-12 text-2xl font-semibold text-gray-900 dark:text-gray-100">
            #{normalizedTag}
          </h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            最新50件
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          {isLoading ? (
            <HashtagNotesLoadingSkeleton />
          ) : error ? (
            <div className={`flex items-center ${HASHTAG_NOTES_PANEL_MIN_HEIGHT_CLASS}`}>
              <div className="w-full rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
                {error}
              </div>
            </div>
          ) : notes.length === 0 ? (
            <div className={`flex items-center ${HASHTAG_NOTES_PANEL_MIN_HEIGHT_CLASS}`}>
              <div className="w-full rounded-xl border border-gray-200 bg-white px-4 py-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
                このハッシュタグのノートはありません
              </div>
            </div>
          ) : (
            <div className={`space-y-3 ${HASHTAG_NOTES_PANEL_MIN_HEIGHT_CLASS}`}>
              {notes.map((note) => (
                <div
                  key={note.id}
                  className="rounded-xl border border-gray-200 bg-white px-4 py-4 dark:border-gray-700 dark:bg-gray-800"
                >
                  <NoteCardContent
                    note={note}
                    profile={profiles.get(note.pubkey)}
                    onHold={() => undefined}
                    onRelease={() => undefined}
                    cache={cache}
                    profiles={profiles}
                    onHashtagClick={onHashtagClick}
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
