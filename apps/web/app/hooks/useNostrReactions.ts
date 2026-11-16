import React, { useEffect, useRef, useState, useCallback } from "react";
import type { SimplePool } from "nostr-tools/pool";
import type { Event } from "nostr-tools/core";
import type { SubCloser } from "nostr-tools/abstract-pool";
import {
  BOOTSTRAP_EOSE_TIMEOUT,
  REACTION_POLL_INTERVAL,
  REACTION_SINCE_SAFETY_MARGIN,
} from "../lib/constants";
import type { NoteCard, Reactions } from "../lib/types";
import { aggregateReactionEvent } from "../lib/reactions";

export type ReactionLoadState = "loading" | "settled" | "error";
export type WatchReactions = (eventIds: string[], onState: (state: ReactionLoadState) => void) => () => void;

export interface UseNostrReactionsResult {
  reactions: Reactions;
  addReaction: (event: Event) => void;
  watchReactions: WatchReactions;
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
  const extraSubscriptionsRef = useRef(new Set<() => void>());
  const reactionSubRef = useRef<SubCloser | null>(null);
  const reactionIntervalRef = useRef<number | null>(null);
  const lastReactionSubClosedAtRef = useRef<number | undefined>(undefined);

  /** 履歴の一括反映とライブ更新で同じ重複除去を使う。 */
  const addReactions = useCallback((events: Event[]) => {
    const unseen = events.filter(event => {
      if (seenReactionIdsRef.current.has(event.id)) return false;
      seenReactionIdsRef.current.add(event.id);
      return true;
    });
    if (unseen.length) setReactions(prev => unseen.reduce(aggregateReactionEvent, prev));
  }, []);
  const addReaction = useCallback((event: Event) => addReactions([event]), [addReactions]);

  // 集計は接続セッションに属し、表示対象の購読を切り替えても保持する。
  useEffect(() => {
    const seen = seenReactionIdsRef.current;
    const extras = extraSubscriptionsRef.current;
    return () => {
      for (const stop of extras) stop();
      seen.clear();
      setReactions(new Map());
    };
  }, [pool, relayUrls]);

  // プロフィールの投稿を一括購読する。フィード・送信結果と同じ重複除去と集計を使う。
  const watchReactions = useCallback<WatchReactions>((eventIds, onState) => {
    const ids = [...new Set(eventIds)];
    if (ids.length === 0) return () => {};
    if (!pool || relayUrls.length === 0) {
      onState("error");
      return () => {};
    }
    let cancelled = false;
    let sub: SubCloser | undefined;
    let initialLoading = true;
    const buffer: Event[] = [];
    const flush = () => {
      initialLoading = false;
      addReactions(buffer.splice(0));
    };
    onState("loading");
    const timer = setTimeout(() => {
      if (cancelled) return;
      flush();
      onState("error");
      stop();
    }, BOOTSTRAP_EOSE_TIMEOUT);
    const stop = () => {
      if (cancelled) return;
      cancelled = true;
      clearTimeout(timer);
      sub?.close();
      extraSubscriptionsRef.current.delete(stop);
    };
    extraSubscriptionsRef.current.add(stop);
    try {
      sub = pool.subscribeMany(relayUrls, { kinds: [7], "#e": ids }, {
        // SDKの擬似EOSEより先にアプリ側でタイムアウトを表示する。
        maxWait: BOOTSTRAP_EOSE_TIMEOUT + 1_000,
        eoseTimeout: BOOTSTRAP_EOSE_TIMEOUT + 1_000,
        onevent(event) {
          if (cancelled) return;
          if (initialLoading) buffer.push(event);
          else addReaction(event);
        },
        oneose() {
          if (cancelled) return;
          clearTimeout(timer);
          flush();
          onState("settled");
        },
        onclose() {
          if (cancelled) return;
          clearTimeout(timer);
          flush();
          onState("error");
          stop();
        },
      });
      if (cancelled) sub.close();
    } catch {
      clearTimeout(timer);
      flush();
      onState("error");
      stop();
    }
    return stop;
  }, [pool, relayUrls, addReaction, addReactions]);

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
          if (cancelled || !reactionInitialLoading) return;
          reactionInitialLoading = false;
          addReactions(reactionBuffer.splice(0));

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
    };
  }, [pool, relayUrls, initialEventIds, addReaction, addReactions, notesRef, newNotesMinCreatedAtRef]);

  return { reactions, addReaction, watchReactions };
}
