"use client";

import React, { useState, useEffect, useMemo, useCallback } from "react";
import { CanvasImageProvider } from "./CanvasAwareImage";
import { CanvasScene } from "./v2/CanvasScene";
import type { Card, NoteCard as NoteCardType, ThreadCard as ThreadCardType, NostrProfile, Reactions } from "../lib/types";
import {
  SCORE_UPDATE_INTERVAL,
  SCORE_HALF_LIFE,
  OWNER_SCORE_HALF_LIFE,
} from "../lib/constants";
import { calcFreshnessScore, sortByScore } from "../lib/scoring";
import { useDraftNotes } from "../hooks/useDraftNotes";
import { useReplyDrafts } from "../hooks/useReplyDrafts";

import { NoteCard } from "./NoteCard";
import { ThreadCard } from "./ThreadCard";
import { ComposeCard } from "./ComposeCard";
import { CanvasHeader } from "./CanvasHeader";
import { EmptyState } from "./EmptyState";
import type { NostrEvent } from "../types/nostr";
import type { Event } from "nostr-tools/core";
import type { EventCache } from "../hooks/useEventCache";
import type { CustomEmoji, EmojiSet } from "../hooks/useCustomEmojis";
import type { RecentEmoji } from "../hooks/useRecentEmojis";
import { UserProfileModal } from "./UserProfileModal";
import { HashtagModal } from "./HashtagModal";

interface LiveCanvasProps {
  notes: NoteCardType[];
  threadCards: ThreadCardType[];
  profiles: Map<string, NostrProfile>;
  /** リアクション集計: eventId → (絵文字 → 件数) */
  reactions: Reactions;
  status: "connecting" | "loading" | "connected" | "error";
  pubkey: string;
  npub: string | null;
  publishEvent: (event: NostrEvent) => Promise<void>;
  publishedSlotMapRef: React.RefObject<Map<string, string>>;
  /** リアクション送信ハンドラ */
  sendReaction: (targetEventId: string, targetPubkey: string, emoji: string, imageUrl?: string) => Promise<void>;
  /** リポスト送信ハンドラ */
  sendRepost: (targetEventId: string, targetPubkey: string, originalEvent: NostrEvent) => Promise<void>;
  /** EventCache インスタンス（引用ノード表示用） */
  cache: EventCache;
  onLogout: () => void;
  showSignerControl: boolean;
  onManageSigner: () => void;
  isProcessing: boolean;
  recentEmojis: RecentEmoji[];
  emojiSets: EmojiSet[];
  looseEmojis: CustomEmoji[];
  fetchProfiles: (pubkeys: string[]) => void;
  fetchUserRecentNotes: (pubkey: string) => Promise<Event[]>;
  fetchHashtagNotes: (tag: string) => Promise<Event[]>;
  isFollowing: (targetPubkey: string) => boolean;
  follow: (targetPubkey: string) => Promise<void>;
  unfollow: (targetPubkey: string) => Promise<void>;
}

export function LiveCanvasV2({ notes, threadCards, profiles, reactions, status, pubkey, npub, publishEvent, publishedSlotMapRef, sendReaction, sendRepost, cache, onLogout, showSignerControl, onManageSigner, isProcessing, recentEmojis, emojiSets, looseEmojis, fetchProfiles, fetchUserRecentNotes, fetchHashtagNotes, isFollowing, follow, unfollow }: LiveCanvasProps) {
  const [holdSet, setHoldSet] = useState<Set<string>>(() => new Set());
  const [profileModalPubkey, setProfileModalPubkey] = useState<string | null>(null);
  const [hashtagModalTag, setHashtagModalTag] = useState<string | null>(null);

  const openHashtagModal = useCallback((tag: string) => {
    // モーダルを重ねずに切り替える。Esc/スクロールロックの競合を避けるため。
    setProfileModalPubkey(null);
    setHashtagModalTag(tag);
  }, []);

  /** カードをホールド状態にする */
  const holdCard = useCallback((slotId: string) => {
    setHoldSet(prev => {
      const next = new Set(prev);
      next.add(slotId);
      return next;
    });
  }, []);

  /** カードのホールドを解除する */
  const releaseCard = useCallback((slotId: string) => {
    setHoldSet(prev => {
      if (!prev.has(slotId)) return prev;
      const next = new Set(prev);
      next.delete(slotId);
      return next;
    });
  }, []);
  const [nowEpoch, setNowEpoch] = useState(() =>
    Math.floor(Date.now() / 1000),
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setNowEpoch(Math.floor(Date.now() / 1000));
    }, SCORE_UPDATE_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  // 下書き・Publish管理
  const {
    draftNotes,
    publishedNotes,
    addDraft,
    handleDraftInput,
    handleDraftClose,
    handleDraftPublish,
  } = useDraftNotes({ pubkey, notes, publishedSlotMapRef });

  // リプライ仮データ管理
  const {
    pendingNoteReplies,
    pendingThreadReplies,
    addNoteReply,
    addThreadReply,
  } = useReplyDrafts({ threadCards, pubkey, publishedSlotMapRef });

  const scoredCards = useMemo((): Card[] => {
    // pendingNoteReplies の originalNote.eventId を収集（仮ThreadCardに変換されるため notes から除外する）
    const pendingOriginalEventIds = new Set<string>();
    for (const pending of pendingNoteReplies.values()) {
      pendingOriginalEventIds.add(pending.originalNote.eventId);
    }

    // notes + publishedNotes をマージ（eventIdで重複排除、pendingNoteRepliesの元ノートは除外）
    const noteEventIds = new Set(notes.map((n) => n.eventId));
    const uniquePublished = publishedNotes.filter((n) => !noteEventIds.has(n.eventId));
    const allNotes = [...notes, ...uniquePublished].filter(
      (n) => !pendingOriginalEventIds.has(n.eventId),
    );

    let updatedNotes: Card[] = allNotes.map((note) => {
      const halfLife = note.pubkey === pubkey ? OWNER_SCORE_HALF_LIFE : SCORE_HALF_LIFE;
      // リポストの場合はリポスト時刻をスコア計算に使用（フィード上での鮮度を反映）
      const scoreTimestamp = note.repostInfo?.repostedAt ?? note.created_at;
      const score = calcFreshnessScore(scoreTimestamp, nowEpoch, halfLife);
      return {
        ...note,
        score,
      };
    });

    // draftNotes にスコアを再計算
    const scoredDrafts: Card[] = draftNotes.map((d) => {
      const score = calcFreshnessScore(d.created_at, nowEpoch, OWNER_SCORE_HALF_LIFE);
      return {
        ...d,
        score,
      };
    });

    // pendingNoteReplies から仮ThreadCard を生成
    const fakeThreads: Card[] = Array.from(pendingNoteReplies.values()).map(
      (pending) => ({
        type: "thread" as const,
        slotId: pending.slotId,
        pubkey: pending.originalNote.pubkey,
        score: calcFreshnessScore(
          pending.replyNote.created_at,
          nowEpoch,
          OWNER_SCORE_HALF_LIFE,
        ),
        created_at: pending.replyNote.created_at,
        notes: [
          // 元のNoteCardをThreadNoteに変換
          {
            eventId: pending.originalNote.eventId,
            pubkey: pending.originalNote.pubkey,
            content: pending.originalNote.content,
            created_at: pending.originalNote.created_at,
            tags: pending.originalNote.tags,
          },
          // リプライ
          pending.replyNote,
        ],
        eventIds: new Set([
          pending.originalNote.eventId,
          pending.replyNote.eventId,
        ]),
      }),
    );

    // 本物のthreadCardsに同じslotIdが存在する仮ThreadCardは除外（重複によるアニメーション発火防止）
    const threadSlotIds = new Set(threadCards.map((tc) => tc.slotId));
    const dedupedFakeThreads = fakeThreads.filter((ft) => !threadSlotIds.has(ft.slotId));

    // ThreadCard（本物 or 仮）と同じslotIdのNoteCardを除外
    // - fakeThreadSlotIds: pendingNoteRepliesから生成された仮ThreadCard（NoteCard→ThreadCard変化時の重複防止）
    // - threadSlotIds: 本物のthreadCards（filteredNotesのeventIdベース除外だけでは
    //   タイミングずれでNoteCardが残る場合があるため、slotIdベースでも除外する）
    const allThreadSlotIds = new Set([
      ...threadSlotIds,
      ...dedupedFakeThreads.map((ft) => ft.slotId),
    ]);
    if (allThreadSlotIds.size > 0) {
      updatedNotes = updatedNotes.filter((n) => !allThreadSlotIds.has(n.slotId));
    }

    // threadCards にスコアを再計算（pendingThreadReplies の仮ノートをマージ）
    const scoredThreads: Card[] = threadCards.map((thread) => {
      // pendingThreadReplies の仮ノートを追加
      // ※ threadCards更新後、pendingThreadRepliesクリア前の1レンダーで重複マージされるのを防ぐため、
      //    すでにthreadCards.eventIdsに含まれるリプライは除外する
      const pendingReplies = pendingThreadReplies.get(thread.slotId);
      let mergedThread = thread;
      if (pendingReplies && pendingReplies.length > 0) {
        const newPending = pendingReplies.filter((p) => !thread.eventIds.has(p.replyEventId));
        if (newPending.length > 0) {
          const latestCreatedAt = Math.max(
            thread.created_at,
            ...newPending.map((p) => p.replyNote.created_at),
          );
          mergedThread = {
            ...thread,
            notes: [
              ...thread.notes,
              ...newPending.map((p) => p.replyNote),
            ],
            eventIds: new Set([
              ...thread.eventIds,
              ...newPending.map((p) => p.replyEventId),
            ]),
            created_at: latestCreatedAt,
          };
        }
      }

      // スレッド内に自分のノートがあれば OWNER_SCORE_HALF_LIFE を使用
      const hasOwnerNote = mergedThread.notes.some((n) => n.pubkey === pubkey);
      const halfLife = hasOwnerNote ? OWNER_SCORE_HALF_LIFE : SCORE_HALF_LIFE;
      // スレッド内最新リプライの created_at をベースにスコア計算
      const score = calcFreshnessScore(mergedThread.created_at, nowEpoch, halfLife);
      return {
        ...mergedThread,
        score,
      };
    });

    return sortByScore([...scoredDrafts, ...updatedNotes, ...scoredThreads, ...dedupedFakeThreads]);
  }, [notes, publishedNotes, draftNotes, threadCards, pendingNoteReplies, pendingThreadReplies, nowEpoch, pubkey]);

  // サイズ測定と座標はV2シーンが所有する。既存カードの通知は使用しない。
  const handleHeightChange = useCallback(() => {}, []);
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey ||
          target?.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) return;
      if (event.key === "f") {
        event.preventDefault();
        setIsFullscreen(value => !value);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const items = scoredCards.map(note => ({
    id: note.slotId,
    card: note,
    content: (
      note.type === "compose" ? (
        <ComposeCard
          slotId={note.slotId}
          pubkey={note.pubkey}
          profile={profiles.get(note.pubkey)}
          onHeightChange={handleHeightChange}
          onPublish={(slotId, event) => { releaseCard(slotId); handleDraftPublish(slotId, event); }}
          onInput={handleDraftInput}
          onClose={(slotId) => { releaseCard(slotId); handleDraftClose(slotId); }}
          publishEvent={publishEvent}
          onHold={holdCard}
          onRelease={releaseCard}
          autoFocus
          quotedEvent={note.quotedEvent}
          cache={cache}
          profiles={profiles}
        />
      ) : note.type === "thread" ? (
        <ThreadCard
          thread={note}
          profiles={profiles}
          reactions={reactions}
          myPubkey={pubkey}
          recentEmojis={recentEmojis}
          emojiSets={emojiSets}
          looseEmojis={looseEmojis}
          fetchProfiles={fetchProfiles}
          onProfileClick={(targetPubkey) => setProfileModalPubkey(targetPubkey)}
          onHashtagClick={openHashtagModal}
          onReaction={(targetEventId, targetPubkey, emoji, imageUrl) => {
            sendReaction(targetEventId, targetPubkey, emoji, imageUrl).catch(console.error);
          }}
          onHeightChange={handleHeightChange}
          onHold={() => holdCard(note.slotId)}
          onRelease={() => releaseCard(note.slotId)}
          cache={cache}
          onReplyPublish={(signedEvent, noteCard, threadSlotId) => {
            addThreadReply(signedEvent, noteCard, threadSlotId);
          }}
          publishEvent={publishEvent}
          myProfile={profiles.get(pubkey)}
          onQuote={(eventId, quotePubkey) => {
            addDraft({
              quotedEvent: {
                eventId,
                pubkey: quotePubkey,
              },
            });
          }}
        />
      ) : (
        <NoteCard
          note={note}
          profile={profiles.get(note.pubkey)}
          recentEmojis={recentEmojis}
          emojiSets={emojiSets}
          looseEmojis={looseEmojis}
          fetchProfiles={fetchProfiles}
          onProfileClick={(targetPubkey) => setProfileModalPubkey(targetPubkey)}
          onHashtagClick={openHashtagModal}
          reposterProfile={note.repostInfo ? profiles.get(note.repostInfo.reposterPubkey) : undefined}
          reactions={reactions.get(note.eventId)}
          myPubkey={pubkey}
          onReaction={(emoji, imageUrl) => {
            sendReaction(note.eventId, note.pubkey, emoji, imageUrl).catch(console.error);
          }}
          onQuote={() => {
            addDraft({
              quotedEvent: {
                eventId: note.eventId,
                pubkey: note.pubkey,
                sig: note.sig,
              },
            });
          }}
          onRepost={() => {
            const originalEvent: NostrEvent = {
              kind: 1,
              content: note.content,
              tags: note.tags,
              created_at: note.created_at,
              pubkey: note.pubkey,
              id: note.eventId,
              sig: note.sig,
            };
            sendRepost(note.eventId, note.pubkey, originalEvent).catch(console.error);
          }}
          cache={cache}
          profiles={profiles}
          onHeightChange={handleHeightChange}
          onHold={() => holdCard(note.slotId)}
          onRelease={() => releaseCard(note.slotId)}
          onReplyPublish={(signedEvent, noteCard, originalNote) => {
            addNoteReply(signedEvent, noteCard, originalNote);
          }}
          publishEvent={publishEvent}
          myProfile={profiles.get(pubkey)}
        />
      )
    ),
  }));

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-gray-50 dark:bg-gray-950">
      {!isFullscreen && <CanvasHeader
        status={status}
        npub={npub}
        onAddDraft={addDraft}
        onLogout={onLogout}
        showSignerControl={showSignerControl}
        onManageSigner={onManageSigner}
      />}
      {isFullscreen && <button
        type="button"
        onClick={() => setIsFullscreen(false)}
        className="fixed right-3 top-3 z-50 rounded-full bg-black/70 px-3 py-1 text-xs text-white"
      >f で戻す</button>}
      <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden" aria-label="V2 Live Canvas">
        <EmptyState status={status} hasNotes={items.length > 0} isProcessing={isProcessing} />
        {items.length > 0 && !isProcessing && <CanvasImageProvider><CanvasScene items={items} heldIds={holdSet} /></CanvasImageProvider>}
        {status === "connected" && items.length === 0 && !isProcessing && (
          <p className="py-16 text-center text-sm text-gray-500 dark:text-gray-400">
            表示するノートはまだありません。投稿ボタンから新しいノートを書けます。
          </p>
        )}
      </main>

      {profileModalPubkey && (
        <UserProfileModal
          pubkey={profileModalPubkey}
          profile={profiles.get(profileModalPubkey)}
          isOpen={!!profileModalPubkey}
          onClose={() => setProfileModalPubkey(null)}
          fetchProfiles={fetchProfiles}
          fetchUserRecentNotes={fetchUserRecentNotes}
          cache={cache}
          profiles={profiles}
          isFollowing={isFollowing(profileModalPubkey)}
          follow={follow}
          unfollow={unfollow}
          onHashtagClick={openHashtagModal}
        />
      )}
      {hashtagModalTag && (
        <HashtagModal
          tag={hashtagModalTag}
          isOpen={!!hashtagModalTag}
          onClose={() => setHashtagModalTag(null)}
          fetchHashtagNotes={fetchHashtagNotes}
          cache={cache}
          profiles={profiles}
          onHashtagClick={openHashtagModal}
        />
      )}
    </div>
  );
}
