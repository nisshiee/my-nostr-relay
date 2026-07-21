import React, { useEffect, useRef, useState, useCallback } from "react";
import type { SimplePool } from "nostr-tools/pool";
import type { Event } from "nostr-tools/core";
import type { SubCloser } from "nostr-tools/abstract-pool";
import {
  REACTION_POLL_INTERVAL,
  REACTION_SINCE_SAFETY_MARGIN,
} from "../lib/constants";
import type { NoteCard, Reactions } from "../lib/types";
import { aggregateReactionEvent } from "../lib/reactions";

export interface UseNostrReactionsResult {
  reactions: Reactions;
  addReaction: (event: Event) => void;
}

/**
 * kind:7 subscribe、リアクション集計・定期再subscribe
 */
export function useNostrReactions(
  pool: SimplePool | null,
  relayUrls: string[],
  notesRef: React.RefObject<NoteCard[]>,
  newNotesMinCreatedAtRef: React.MutableRefObject<number | undefined>,
  initialEventIds: string[],
): UseNostrReactionsResult {
  const [reactions, setReactions] = useState<Reactions>(new Map());

  const seenReactionIdsRef = useRef<Set<string>>(new Set());
  const reactionSubRef = useRef<SubCloser | null>(null);
  const reactionIntervalRef = useRef<number | null>(null);
  const lastReactionSubClosedAtRef = useRef<number | undefined>(undefined);

  /** kind:7リアクションイベントを集計に追加する */
  const addReaction = useCallback((event: Event) => {
    if (seenReactionIdsRef.current.has(event.id)) return;
    seenReactionIdsRef.current.add(event.id);

    setReactions((prev) => aggregateReactionEvent(prev, event));
  }, []);

  // kind:7 subscribe（initialEventIdsが空でなくなったら開始）
  useEffect(() => {
    if (!pool || relayUrls.length === 0 || initialEventIds.length === 0) return;

    let cancelled = false;

    // リアクション初期ロード用バッファ
    const reactionBuffer: Event[] = [];
    let reactionInitialLoading = true;

    const reactionSub = pool.subscribeMany(
      relayUrls,
      { kinds: [7], "#e": initialEventIds },
      {
        onevent(event: Event) {
          if (cancelled) return;
          if (reactionInitialLoading) {
            reactionBuffer.push(event);
          } else {
            addReaction(event);
          }
        },
        oneose() {
          reactionInitialLoading = false;
          // バッファを一括でstateに反映
          if (reactionBuffer.length > 0) {
            let batchReactions: Reactions = new Map();
            for (const evt of reactionBuffer) {
              if (seenReactionIdsRef.current.has(evt.id)) continue;
              seenReactionIdsRef.current.add(evt.id);
              batchReactions = aggregateReactionEvent(batchReactions, evt);
            }
            setReactions(batchReactions);
          }

          // リアクション初期ロード完了 — 定期再subscribeタイマーを開始
          lastReactionSubClosedAtRef.current = Math.floor(Date.now() / 1000);
          reactionIntervalRef.current = window.setInterval(() => {
            if (cancelled) return;

            // 1. 現在のリアクションsubを閉じる
            if (reactionSubRef.current) {
              const closingSub = reactionSubRef.current;
              closingSub.close();
              reactionSubRef.current = null;
            }

            // 2. sinceを計算
            let since = (lastReactionSubClosedAtRef.current ?? Math.floor(Date.now() / 1000)) - REACTION_SINCE_SAFETY_MARGIN;
            if (newNotesMinCreatedAtRef.current !== undefined) {
              since = Math.min(since, newNotesMinCreatedAtRef.current);
            }

            // 3. 閉じた時刻を記録
            lastReactionSubClosedAtRef.current = Math.floor(Date.now() / 1000);

            // 4. newNotesMinCreatedAtRefをリセット
            newNotesMinCreatedAtRef.current = undefined;

            // 5. 現在のnotesからeventIdを収集
            const currentEventIds = notesRef.current.map((n) => n.eventId);
            if (currentEventIds.length === 0) return;

            // 6. 新しいリアクションsubscriptionを発行
            const newReactionSub = pool.subscribeMany(
              relayUrls,
              { kinds: [7], "#e": currentEventIds, since },
              {
                onevent(event: Event) {
                  if (!cancelled) addReaction(event);
                },
                oneose() {
                  // リアクション再subscribe完了
                },
              },
            );
            reactionSubRef.current = newReactionSub;
          }, REACTION_POLL_INTERVAL);
        },
      },
    );
    reactionSubRef.current = reactionSub;

    return () => {
      cancelled = true;
      // リアクション定期再subscribeタイマーを停止
      if (reactionIntervalRef.current !== null) {
        clearInterval(reactionIntervalRef.current);
        reactionIntervalRef.current = null;
      }
      // リアクションsubを閉じる
      if (reactionSubRef.current) {
        try {
          reactionSubRef.current.close();
        } catch {
          // 既に閉じている場合は無視
        }
        reactionSubRef.current = null;
      }
      seenReactionIdsRef.current.clear();
      setReactions(new Map());
    };
  }, [pool, relayUrls, initialEventIds, addReaction, notesRef, newNotesMinCreatedAtRef]);

  return { reactions, addReaction };
}
