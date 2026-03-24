"use client";

import { useState, useEffect, useCallback } from "react";
import type {
  NoteCard as NoteCardType,
  ThreadCard as ThreadCardType,
  ThreadNote,
} from "../lib/types";
import type { NostrEvent } from "../types/nostr";

/** NoteCardからのリプライで生成する仮ThreadCard */
interface PendingNoteReply {
  /** 元のNoteCardの情報 */
  originalNote: NoteCardType;
  /** リプライのThreadNote */
  replyNote: ThreadNote;
  /** 仮ThreadCardのslotId（元のNoteCardのslotIdを引き継ぐ） */
  slotId: string;
  /** リプライのeventId（リレー到着検出用） */
  replyEventId: string;
  /** 作成時刻（タイムアウト用） */
  createdAt: number;
}

/** ThreadCardからのリプライで追加する仮ノート */
interface PendingThreadReply {
  /** 対象ThreadCardのslotId */
  threadSlotId: string;
  /** 追加する仮ノート */
  replyNote: ThreadNote;
  /** リプライのeventId（リレー到着検出用） */
  replyEventId: string;
  /** 作成時刻（タイムアウト用） */
  createdAt: number;
}

interface UseReplyDraftsProps {
  /** useThreadCards から返される threadCards（リレー到着検出用） */
  threadCards: ThreadCardType[];
  /** 自分のpubkey */
  pubkey: string;
  /** publishedSlotMapRef（eventId → slotId マッピング、リレー到着時にslotIdを引き継ぐため） */
  publishedSlotMapRef: React.RefObject<Map<string, string>>;
}

interface UseReplyDraftsResult {
  /** NoteCardからのリプライで生成された仮ThreadCard（slotId → PendingNoteReply） */
  pendingNoteReplies: Map<string, PendingNoteReply>;
  /** ThreadCardからのリプライで追加された仮ノート（threadSlotId → PendingThreadReply[]） */
  pendingThreadReplies: Map<string, PendingThreadReply[]>;
  /** NoteCardからのリプライPublish時に呼ぶ */
  addNoteReply: (
    signedEvent: NostrEvent & { id: string; sig: string },
    noteCard: {
      eventId: string;
      pubkey: string;
      content: string;
      tags: string[][];
      created_at: number;
    },
    originalNote: NoteCardType,
  ) => void;
  /** ThreadCardからのリプライPublish時に呼ぶ */
  addThreadReply: (
    signedEvent: NostrEvent & { id: string; sig: string },
    noteCard: {
      eventId: string;
      pubkey: string;
      content: string;
      tags: string[][];
      created_at: number;
    },
    threadSlotId: string,
  ) => void;
}

/**
 * リプライPublish後の仮データ管理hook。
 *
 * - NoteCardからのリプライ → 仮ThreadCardを生成（元のNoteCard + リプライ）
 * - ThreadCardからのリプライ → 既存ThreadCardに仮ノートを追加
 * - リレーから本物のデータが到着したら仮データを消去
 * - 60秒タイムアウトでフォールバック消去
 */
export function useReplyDrafts({
  threadCards,
  pubkey,
  publishedSlotMapRef,
}: UseReplyDraftsProps): UseReplyDraftsResult {
  const [pendingNoteReplies, setPendingNoteReplies] = useState<
    Map<string, PendingNoteReply>
  >(() => new Map());
  const [pendingThreadReplies, setPendingThreadReplies] = useState<
    Map<string, PendingThreadReply[]>
  >(() => new Map());

  // NoteCardからのリプライPublish時に呼ぶ
  const addNoteReply = useCallback(
    (
      signedEvent: NostrEvent & { id: string; sig: string },
      noteCard: {
        eventId: string;
        pubkey: string;
        content: string;
        tags: string[][];
        created_at: number;
      },
      originalNote: NoteCardType,
    ) => {
      const replyEventId = signedEvent.id;
      const replyNote: ThreadNote = {
        eventId: noteCard.eventId,
        pubkey: noteCard.pubkey,
        content: noteCard.content,
        created_at: noteCard.created_at,
        tags: noteCard.tags,
        replyTo: {
          eventId: originalNote.eventId,
          pubkey: originalNote.pubkey,
        },
      };

      const pending: PendingNoteReply = {
        originalNote,
        replyNote,
        slotId: originalNote.slotId,
        replyEventId,
        createdAt: Math.floor(Date.now() / 1000),
      };

      // リレー到着時にslotIdを引き継ぐためのマッピング登録
      publishedSlotMapRef.current?.set(replyEventId, originalNote.slotId);

      setPendingNoteReplies((prev) => {
        const next = new Map(prev);
        next.set(originalNote.slotId, pending);
        return next;
      });
    },
    [publishedSlotMapRef],
  );

  // ThreadCardからのリプライPublish時に呼ぶ
  const addThreadReply = useCallback(
    (
      signedEvent: NostrEvent & { id: string; sig: string },
      noteCard: {
        eventId: string;
        pubkey: string;
        content: string;
        tags: string[][];
        created_at: number;
      },
      threadSlotId: string,
    ) => {
      const replyEventId = signedEvent.id;
      const replyNote: ThreadNote = {
        eventId: noteCard.eventId,
        pubkey: noteCard.pubkey,
        content: noteCard.content,
        created_at: noteCard.created_at,
        tags: noteCard.tags,
      };

      const pending: PendingThreadReply = {
        threadSlotId,
        replyNote,
        replyEventId,
        createdAt: Math.floor(Date.now() / 1000),
      };

      // リレー到着時にslotIdを引き継ぐためのマッピング登録
      publishedSlotMapRef.current?.set(replyEventId, threadSlotId);

      setPendingThreadReplies((prev) => {
        const next = new Map(prev);
        const existing = next.get(threadSlotId) ?? [];
        next.set(threadSlotId, [...existing, pending]);
        return next;
      });
    },
    [publishedSlotMapRef],
  );

  // リレー到着検出: threadCards の eventIds に含まれる pending を除去
  useEffect(() => {
    if (pendingNoteReplies.size === 0 && pendingThreadReplies.size === 0)
      return;

    // threadCards の全 eventIds を収集
    const allEventIds = new Set<string>();
    for (const tc of threadCards) {
      for (const eid of tc.eventIds) {
        allEventIds.add(eid);
      }
    }

    // pendingNoteReplies のリレー到着チェック
    let noteChanged = false;
    const nextNoteReplies = new Map(pendingNoteReplies);
    for (const [slotId, pending] of nextNoteReplies) {
      if (allEventIds.has(pending.replyEventId)) {
        nextNoteReplies.delete(slotId);
        publishedSlotMapRef.current?.delete(pending.replyEventId);
        noteChanged = true;
      }
    }
    if (noteChanged) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- threadCards変更に連動してpendingを整理する派生ステート更新
      setPendingNoteReplies(nextNoteReplies);
    }

    // pendingThreadReplies のリレー到着チェック
    let threadChanged = false;
    const nextThreadReplies = new Map(pendingThreadReplies);
    for (const [slotId, pendingList] of nextThreadReplies) {
      const remaining = pendingList.filter((p) => {
        if (allEventIds.has(p.replyEventId)) {
          publishedSlotMapRef.current?.delete(p.replyEventId);
          threadChanged = true;
          return false;
        }
        return true;
      });
      if (remaining.length === 0) {
        nextThreadReplies.delete(slotId);
      } else if (remaining.length !== pendingList.length) {
        nextThreadReplies.set(slotId, remaining);
      }
    }
    if (threadChanged) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- threadCards変更に連動してpendingを整理する派生ステート更新
      setPendingThreadReplies(nextThreadReplies);
    }
  }, [
    threadCards,
    pendingNoteReplies,
    pendingThreadReplies,
    publishedSlotMapRef,
  ]);

  // 60秒タイムアウト: 古い pending をクリーンアップ
  useEffect(() => {
    if (pendingNoteReplies.size === 0 && pendingThreadReplies.size === 0)
      return;

    const timer = setInterval(() => {
      const now = Math.floor(Date.now() / 1000);

      setPendingNoteReplies((prev) => {
        let changed = false;
        const next = new Map<string, PendingNoteReply>();
        for (const [slotId, pending] of prev) {
          if (now - pending.createdAt >= 60) {
            publishedSlotMapRef.current?.delete(pending.replyEventId);
            changed = true;
          } else {
            next.set(slotId, pending);
          }
        }
        return changed ? next : prev;
      });

      setPendingThreadReplies((prev) => {
        let changed = false;
        const next = new Map<string, PendingThreadReply[]>();
        for (const [slotId, pendingList] of prev) {
          const remaining = pendingList.filter((p) => {
            if (now - p.createdAt >= 60) {
              publishedSlotMapRef.current?.delete(p.replyEventId);
              changed = true;
              return false;
            }
            return true;
          });
          if (remaining.length > 0) {
            next.set(slotId, remaining);
          } else if (remaining.length !== pendingList.length) {
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 10_000);

    return () => clearInterval(timer);
  }, [
    pendingNoteReplies,
    pendingThreadReplies,
    publishedSlotMapRef,
  ]);

  return {
    pendingNoteReplies,
    pendingThreadReplies,
    addNoteReply,
    addThreadReply,
  };
}
