"use client";

import React, { useState, useEffect, useCallback } from "react";
import type { NoteCard as NoteCardType, ComposeCard as ComposeCardType } from "../lib/types";

interface UseDraftNotesProps {
  pubkey: string;
  notes: NoteCardType[];
  publishedSlotMapRef: React.RefObject<Map<string, string>>;
}

interface UseDraftNotesResult {
  draftNotes: ComposeCardType[];
  publishedNotes: NoteCardType[];
  addDraft: (opts?: { quotedEvent?: ComposeCardType["quotedEvent"] }) => void;
  handleDraftInput: (slotId: string) => void;
  handleDraftClose: (slotId: string) => void;
  handleDraftPublish: (slotId: string, noteCard: NoteCardType) => void;
}

/**
 * 下書きカードとPublish済みノートの管理hook。
 *
 * - 下書きカードの追加・編集・削除・Publish
 * - Publish済みノートの一時保持（リレー到着で自動除去）
 * - `n` キーによる下書き追加ショートカット
 */
export function useDraftNotes({
  pubkey,
  notes,
  publishedSlotMapRef,
}: UseDraftNotesProps): UseDraftNotesResult {
  // 下書きカード管理
  const [draftNotes, setDraftNotes] = useState<ComposeCardType[]>([]);

  // Publish済みノートの一時保持（リレーから到着するまでの繋ぎ）
  const [publishedNotes, setPublishedNotes] = useState<NoteCardType[]>([]);

  // 下書きカードを追加する共通関数（nキー & ボタン共用）
  const addDraft = useCallback((opts?: { quotedEvent?: ComposeCardType["quotedEvent"] }) => {
    setDraftNotes((prev) => {
      const newDraft: ComposeCardType = {
        type: "compose",
        slotId: crypto.randomUUID(),
        pubkey,
        created_at: Math.floor(Date.now() / 1000),
        score: 1,
        fadingOut: false,
        ...(opts?.quotedEvent ? { quotedEvent: opts.quotedEvent } : {}),
      };
      return [...prev, newDraft];
    });
  }, [pubkey]);

  // `n` キーで下書きカードを追加
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // input/textarea にフォーカスがある場合は無視
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (e.key !== "n") return;
      e.preventDefault();
      addDraft();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [addDraft]);

  // リレーから到着した notes に含まれる publishedNotes を除去し、マッピングもクリーンアップ
  useEffect(() => {
    if (publishedNotes.length === 0) return;
    const noteEventIds = new Set(notes.map((n) => n.eventId));

    // リレーから到着済みの publishedNotes のマッピングを削除
    const arrivedNotes = publishedNotes.filter((n) => noteEventIds.has(n.eventId));
    for (const arrived of arrivedNotes) {
      publishedSlotMapRef.current?.delete(arrived.eventId);
    }

    // publishedNotes から除去
    // eslint-disable-next-line react-hooks/set-state-in-effect -- notes変更に連動してpublishedNotesを整理する派生ステート更新
    setPublishedNotes((prev) => {
      const filtered = prev.filter((n) => !noteEventIds.has(n.eventId));
      if (filtered.length === prev.length) return prev;
      return filtered;
    });
  }, [notes, publishedNotes.length, publishedSlotMapRef]);

  // 60秒経過したpublished noteをクリーンアップ（リレー未到着のフォールバック）
  useEffect(() => {
    if (publishedNotes.length === 0) return;
    const timer = setInterval(() => {
      const now = Math.floor(Date.now() / 1000);
      setPublishedNotes((prev) => {
        const stale = prev.filter((n) => now - n.created_at >= 60);
        if (stale.length === 0) return prev;
        // staleなノートのマッピングも削除
        for (const n of stale) {
          publishedSlotMapRef.current?.delete(n.eventId);
        }
        return prev.filter((n) => now - n.created_at < 60);
      });
    }, 10_000);
    return () => clearInterval(timer);
  }, [publishedNotes.length, publishedSlotMapRef]);

  // スコアリセット: ComposeCard の onInput
  const handleDraftInput = useCallback((slotId: string) => {
    setDraftNotes((prev) =>
      prev.map((d) =>
        d.slotId === slotId
          ? { ...d, created_at: Math.floor(Date.now() / 1000) }
          : d,
      ),
    );
  }, []);

  // 下書きカードを閉じる: ComposeCard の onClose
  const handleDraftClose = useCallback((slotId: string) => {
    setDraftNotes((prev) => prev.filter((d) => d.slotId !== slotId));
  }, []);

  // Publish 完了: ComposeCard の onPublish
  const handleDraftPublish = useCallback(
    (slotId: string, noteCard: NoteCardType) => {
      // eventId → slotId のマッピングを登録（addNote時にslotIdを引き継ぐため）
      publishedSlotMapRef.current?.set(noteCard.eventId, noteCard.slotId);
      // ドラフトを削除し、同じslotIdのNoteCardをpublishedNotesに追加
      setDraftNotes((prev) => prev.filter((d) => d.slotId !== slotId));
      setPublishedNotes((prev) => [...prev, noteCard]);
    },
    [publishedSlotMapRef],
  );

  return {
    draftNotes,
    publishedNotes,
    addDraft,
    handleDraftInput,
    handleDraftClose,
    handleDraftPublish,
  };
}
