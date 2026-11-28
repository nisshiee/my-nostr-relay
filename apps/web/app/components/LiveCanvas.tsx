"use client";

import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { CanvasScene } from "./canvas/CanvasScene";
import type { Card, CardScoreSource, NoteCard as NoteCardType, ThreadCard as ThreadCardType, NostrProfile, Reactions, YoCard as YoCardType } from "../lib/types";
import {
  SCORE_UPDATE_INTERVAL,
} from "../lib/constants";
import { scoreCards } from "../lib/scoring";
import { reconcileCardSources } from "../lib/cardSources";
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
import { YoCard } from "./YoCard";
import { UserProfileModal } from "./UserProfileModal";
import { HashtagModal } from "./HashtagModal";

import type { WatchReactions } from "../hooks/useNostrReactions";

interface LiveCanvasProps {
  diagnosticsEnabled?: boolean;
  nativeEnabled?: boolean;
  nativeUnavailableReason?: string;
  settingsContent?: React.ReactNode;
  notes: NoteCardType[];
  threadCards: ThreadCardType[];
  yoCards?: YoCardType[];
  sendYo?: (targetPubkey: string) => Promise<void>;
  profiles: Map<string, NostrProfile>;
  /** リアクション集計: eventId → (絵文字 → 件数) */
  reactions: Reactions;
  watchReactions: WatchReactions;
  status: "connecting" | "loading" | "connected" | "error";
  pubkey: string;
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

/** アカウント境界では全形式のローカル状態を同時に破棄する。 */
export function LiveCanvas(props: LiveCanvasProps) {
  return <LiveCanvasSession key={props.pubkey} {...props} />;
}

const NO_YOS: YoCardType[] = [];

function LiveCanvasSession({ diagnosticsEnabled = false, nativeEnabled = false, nativeUnavailableReason, settingsContent, notes, threadCards, yoCards = NO_YOS, sendYo, profiles, reactions, watchReactions, status, pubkey, publishEvent, publishedSlotMapRef, sendReaction, sendRepost, cache, onLogout, showSignerControl, onManageSigner, isProcessing, recentEmojis, emojiSets, looseEmojis, fetchProfiles, fetchUserRecentNotes, fetchHashtagNotes, isFollowing, follow, unfollow }: LiveCanvasProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const [holdSet, setHoldSet] = useState<Set<string>>(() => new Set());
  const [profileModalPubkey, setProfileModalPubkey] = useState<string | null>(null);
  const [hashtagModalTag, setHashtagModalTag] = useState<string | null>(null);

  useEffect(() => {
    fetchProfiles([pubkey]);
  }, [fetchProfiles, pubkey, status]);

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
  } = useReplyDrafts({ threadCards, publishedSlotMapRef });

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

    let updatedNotes = allNotes;

    // pendingNoteReplies から仮ThreadCard を生成
    const fakeThreads: ThreadCardType[] = Array.from(pendingNoteReplies.values()).map(
      (pending) => ({
        type: "thread" as const,
        slotId: pending.slotId,
        pubkey: pending.originalNote.pubkey,
        score: 0,
        scoreSources: [],
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

    // feedと期限内のローカル投稿を共通の保持元へ正規化する。
    const retainedSources = new Map<string, CardScoreSource>();
    for (const source of [
      ...notes, ...publishedNotes,
      ...threadCards.flatMap(card => card.scoreSources),
      ...[...pendingNoteReplies.values()].map(pending => pending.replyNote),
      ...[...pendingThreadReplies.values()].flatMap(list => list.map(pending => pending.replyNote)),
    ]) {
      if (source.eventId) retainedSources.set(source.eventId, source);
    }

    // すべての表示候補をslot単位で一度だけ構成する。実データを優先する。
    const pendingSnapshots = [...pendingThreadReplies.values()].flatMap(pending =>
      pending.length ? [{ ...pending[0].originalThread, scoreSources: [] }] : [],
    );
    const threadCandidates = new Map([...pendingSnapshots, ...fakeThreads, ...threadCards].map(card => [card.slotId, card]));
    updatedNotes = updatedNotes.filter(note => !threadCandidates.has(note.slotId));

    // 保留投稿の種類によらず、同じslotへ重複なくマージする。
    const mergedThreads: ThreadCardType[] = [...threadCandidates.values()].map((thread) => {
      const pendingNote = pendingNoteReplies.get(thread.slotId);
      const pendingReplies = [...new Map([
        ...(pendingNote ? [pendingNote.replyNote] : []),
        ...(pendingThreadReplies.get(thread.slotId) ?? []).map(p => p.replyNote),
      ].map(note => [note.eventId, note])).values()];
      let mergedThread = thread;
      if (pendingReplies.length > 0) {
        const newPending = pendingReplies.filter(note => !thread.eventIds.has(note.eventId));
        if (newPending.length > 0) {
          const latestCreatedAt = Math.max(
            thread.created_at,
            ...newPending.map(note => note.created_at),
          );
          mergedThread = {
            ...thread,
            notes: [
              ...thread.notes,
              ...newPending,
            ],
            eventIds: new Set([
              ...thread.eventIds,
              ...newPending.map(note => note.eventId),
            ]),
            created_at: latestCreatedAt,
          };
        }
      }

      return mergedThread;
    });

    const sourcedCards = reconcileCardSources<Card, CardScoreSource>([
      ...updatedNotes.map(card => ({ card, sourceIds: [card.eventId] })),
      ...mergedThreads.map(card => ({ card, sourceIds: card.eventIds })),
    ], retainedSources);
    return scoreCards([...draftNotes, ...sourcedCards, ...yoCards], pubkey, nowEpoch);
  }, [notes, publishedNotes, draftNotes, threadCards, yoCards, pendingNoteReplies, pendingThreadReplies, nowEpoch, pubkey]);

  // サイズ測定と座標は描画シーンが所有する。既存カードの通知は使用しない。
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
      note.type === "yo" ? (
        <YoCard
          card={note}
          profile={profiles.get(note.pubkey)}
          onOpenProfile={setProfileModalPubkey}
          onSendYo={note.pubkey === pubkey ? undefined : sendYo}
        />
      ) : note.type === "compose" ? (
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
          onReplyPublish={(signedEvent, noteCard) => {
            addThreadReply(signedEvent, noteCard, note);
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
        onOpenSettings={() => setSettingsOpen(true)}
        settingsOpen={settingsOpen}
        settingsTrigger={settingsTrigger}
        status={status}
        pubkey={pubkey}
        profile={profiles.get(pubkey)}
        onOpenProfile={() => setProfileModalPubkey(pubkey)}
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
      <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden" aria-label="Live Canvas">
        {(items.length === 0 || isProcessing) && <div className="pointer-events-none absolute inset-0 z-10"><EmptyState status={status} hasNotes={items.length > 0} isProcessing={isProcessing} /></div>}
        <CanvasScene showRendererStatus settingsOpen={settingsOpen} onSettingsClose={closeSettings} settingsTrigger={settingsTrigger} items={isProcessing ? [] : items} heldIds={holdSet} diagnosticsEnabled={diagnosticsEnabled} allowNative={nativeEnabled} nativeUnavailableReason={nativeUnavailableReason} settingsContent={settingsContent} />
        {status === "connected" && items.length === 0 && !isProcessing && (
          <p className="pointer-events-none absolute inset-x-0 top-0 py-16 text-center text-sm text-gray-500 dark:text-gray-400">
            表示するノートはまだありません。投稿ボタンから新しいノートを書けます。
          </p>
        )}
      </main>

      {profileModalPubkey && (
        <UserProfileModal
          key={profileModalPubkey}
          pubkey={profileModalPubkey}
          onSendYo={sendYo}
          reactions={reactions}
          watchReactions={watchReactions}
          sendReaction={sendReaction}
          myPubkey={pubkey}
          recentEmojis={recentEmojis}
          emojiSets={emojiSets}
          looseEmojis={looseEmojis}
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
