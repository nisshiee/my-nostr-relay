import React, { useEffect, useRef, useState, useCallback } from "react";
import { SimplePool } from "nostr-tools/pool";
import type { Event } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import type { SubCloser } from "nostr-tools/abstract-pool";
import {
  BOOTSTRAP_RELAYS,
  BOOTSTRAP_EOSE_TIMEOUT,
  MAX_WAIT_FOR_CONNECTION,
  MAX_NOTES,
  INITIAL_NOTES_LIMIT,
  OWNER_SCORE_HALF_LIFE,
  REACTION_POLL_INTERVAL,
  REACTION_SINCE_SAFETY_MARGIN,
  SCORE_HALF_LIFE,
} from "../lib/constants";
import { calcFreshnessScore, sortByScore } from "../lib/scoring";
import type { NoteCard, NostrProfile, Reactions } from "../lib/types";

type ConnectionStatus = "connecting" | "loading" | "connected" | "error";

/** NIP-07拡張(window.nostr)の署名済みイベント型 */
type SignedNostrEvent = NostrEvent & { id: string; sig: string };

interface UseNostrRelayResult {
  notes: NoteCard[];
  profiles: Map<string, NostrProfile>;
  reactions: Reactions;
  status: ConnectionStatus;
  relayUrls: string[];
  publishEvent: (event: NostrEvent) => Promise<void>;
  sendReaction: (targetEventId: string, targetPubkey: string, emoji: string, imageUrl?: string) => Promise<void>;
}

/** カスタム絵文字（:shortcode: 形式）のイベントタグから画像URLを取得する */
const extractCustomEmojiUrl = (emoji: string, tags: string[][]): string | undefined => {
  if (!emoji.startsWith(":") || !emoji.endsWith(":") || emoji.length <= 2) return undefined;
  const shortcode = emoji.slice(1, -1);
  const emojiTag = tags.find(tag => tag[0] === "emoji" && tag[1] === shortcode && tag[2]);
  return emojiTag?.[2];
};

/**
 * Nostrリレーに接続し、フォロー中ユーザーのノートとプロフィールを取得するhook
 *
 * 接続フロー:
 * 1. BOOTSTRAP_RELAYSにSimplePoolで接続してkind:10002（NIP-65リレーリスト）とkind:3（フォローリスト）を取得
 * 2. 取得したリレーリスト（またはBOOTSTRAP_RELAYSフォールバック）で接続
 * 3. フォロー中ユーザーのkind:1（ノート）とkind:0（プロフィール）をsubscribe
 */
export function useNostrRelay(
  pubkey: string | null,
  publishedSlotMapRef: React.RefObject<Map<string, string>>,
): UseNostrRelayResult {
  const [notes, setNotes] = useState<NoteCard[]>([]);
  const [profiles, setProfiles] = useState<Map<string, NostrProfile>>(
    new Map(),
  );
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [relayUrls, setRelayUrls] = useState<string[]>([]);
  const [reactions, setReactions] = useState<Reactions>(new Map());

  // クリーンアップ用のref
  const poolRef = useRef<SimplePool | null>(null);
  const poolSubsRef = useRef<SubCloser[]>([]);

  // リアルタイムリポスト: 元ノート取得中のeventIDを管理（重複REQ防止）
  const inflightOriginalNotesRef = useRef<Set<string>>(new Set());

  // リアクション定期再subscribe用のref
  const reactionSubRef = useRef<SubCloser | null>(null);
  const reactionIntervalRef = useRef<number | null>(null);
  const lastReactionSubClosedAtRef = useRef<number | undefined>(undefined);
  const newNotesMinCreatedAtRef = useRef<number | undefined>(undefined);
  const seenReactionIdsRef = useRef<Set<string>>(new Set());
  const notesRef = useRef<NoteCard[]>([]);

  /** リアクションのcontentを正規化する。カスタム絵文字（:shortcode:）もそのまま返す */
  const normalizeReactionContent = useCallback((content: string): string | null => {
    // "+" または空文字 → 👍
    if (content === "+" || content === "") return "👍";
    // "-" → 👎
    if (content === "-") return "👎";
    // NIP-30カスタム絵文字（:shortcode: 形式）→ そのまま返す
    if (content.startsWith(":") && content.endsWith(":") && content.length > 2) return content;
    // 通常の絵文字はそのまま
    return content;
  }, []);

  /** kind:7リアクションイベントを集計に追加する */
  const addReaction = useCallback((event: Event) => {
    // 受信済みリアクションの重複排除
    if (seenReactionIdsRef.current.has(event.id)) return;
    seenReactionIdsRef.current.add(event.id);

    // リアクション対象のeventIdを "e" タグから取得（最後の "e" タグが対象）
    const eTags = event.tags.filter((tag) => tag[0] === "e" && tag[1]);
    if (eTags.length === 0) return;
    const targetEventId = eTags[eTags.length - 1]![1]!;

    const emoji = normalizeReactionContent(event.content);
    if (emoji === null) return;

    // カスタム絵文字の画像URLを取得
    const imageUrl = extractCustomEmojiUrl(emoji, event.tags);

    setReactions((prev) => {
      const next = new Map(prev);
      const eventReactions = next.get(targetEventId);
      if (eventReactions) {
        const updated = new Map(eventReactions);
        const existing = updated.get(emoji);
        if (existing) {
          const newPubkeys = new Set(existing.pubkeys);
          newPubkeys.add(event.pubkey);
          updated.set(emoji, { count: existing.count + 1, imageUrl: existing.imageUrl ?? imageUrl, pubkeys: newPubkeys });
        } else {
          updated.set(emoji, { count: 1, imageUrl, pubkeys: new Set([event.pubkey]) });
        }
        next.set(targetEventId, updated);
      } else {
        next.set(targetEventId, new Map([[emoji, { count: 1, imageUrl, pubkeys: new Set([event.pubkey]) }]]));
      }
      return next;
    });
  }, [normalizeReactionContent]);

  /** ノートを追加（重複排除・スコア計算・prune込み） */
  const addNote = useCallback((event: Event) => {
    // 新規ノートのcreated_atを追跡（リアクション再subscribe時のsince計算用）
    if (
      newNotesMinCreatedAtRef.current === undefined ||
      event.created_at < newNotesMinCreatedAtRef.current
    ) {
      newNotesMinCreatedAtRef.current = event.created_at;
    }

    setNotes((prev) => {
      // eventIDで重複チェック
      if (prev.some((n) => n.eventId === event.id)) return prev;

      const now = Math.floor(Date.now() / 1000);
      const halfLife = event.pubkey === pubkey ? OWNER_SCORE_HALF_LIFE : SCORE_HALF_LIFE;
      // publishedSlotMapにマッピングがあればそのslotIdを使う（同じスロットを維持する）
      const slotId = publishedSlotMapRef.current?.get(event.id) ?? crypto.randomUUID();
      const newNote: NoteCard = {
        type: "note",
        slotId,
        eventId: event.id,
        pubkey: event.pubkey,
        content: event.content,
        created_at: event.created_at,
        score: calcFreshnessScore(event.created_at, now, halfLife),
        fadingOut: false,
      };

      const updated = [...prev, newNote];

      // MAX_NOTES超過時はスコアが低いものを削除
      if (updated.length > MAX_NOTES) {
        const sorted = sortByScore(updated);
        return sorted.slice(0, MAX_NOTES);
      }

      return updated;
    });
  }, [pubkey, publishedSlotMapRef]);

  /**
   * 元ノートイベントをNoteCardに変換してstateに追加する（既存カードがあればrepostInfoを付与）
   * 初期ロードとリアルタイム処理の両方で使用する共通処理
   */
  const processOriginalNote = useCallback((origEvent: Event, repostEvent: Event) => {
    if (origEvent.kind !== 1) return;

    setNotes((prev) => {
      // 既にカードが存在する場合はrepostInfoを付与して更新
      const existingIndex = prev.findIndex((n) => n.eventId === origEvent.id);
      if (existingIndex !== -1) {
        const existing = prev[existingIndex]!;
        // 既にrepostInfoがある場合は、より新しいリポストで上書き
        if (existing.repostInfo && existing.repostInfo.repostedAt >= repostEvent.created_at) {
          return prev;
        }
        const updated = [...prev];
        updated[existingIndex] = {
          ...existing,
          repostInfo: {
            reposterPubkey: repostEvent.pubkey,
            repostedAt: repostEvent.created_at,
          },
        };
        return updated;
      }

      // 新規カードとして追加（repostInfo付き）
      const now = Math.floor(Date.now() / 1000);
      const halfLife = origEvent.pubkey === pubkey ? OWNER_SCORE_HALF_LIFE : SCORE_HALF_LIFE;
      const slotId = publishedSlotMapRef.current?.get(origEvent.id) ?? crypto.randomUUID();
      const newNote: NoteCard = {
        type: "note",
        slotId,
        eventId: origEvent.id,
        pubkey: origEvent.pubkey,
        content: origEvent.content,
        created_at: origEvent.created_at,
        score: calcFreshnessScore(origEvent.created_at, now, halfLife),
        fadingOut: false,
        repostInfo: {
          reposterPubkey: repostEvent.pubkey,
          repostedAt: repostEvent.created_at,
        },
      };

      const updated = [...prev, newNote];
      if (updated.length > MAX_NOTES) {
        return sortByScore(updated).slice(0, MAX_NOTES);
      }
      return updated;
    });
  }, [pubkey, publishedSlotMapRef]);

  /** プロフィールを追加・更新（kind:0イベントから） */
  const upsertProfile = useCallback((event: Event) => {
    try {
      const data = JSON.parse(event.content) as NostrProfile;
      setProfiles((prev) => {
        const next = new Map(prev);
        next.set(event.pubkey, data);
        return next;
      });
    } catch {
      // JSONパース失敗は無視
    }
  }, []);

  // notesの最新値をrefで同期（タイマーコールバックからアクセスするため）
  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  useEffect(() => {
    if (!pubkey) {
      return;
    }

    let cancelled = false;

    /** 全subscriptionを閉じる */
    const closeSubs = () => {
      for (const sub of poolSubsRef.current) {
        try {
          sub.close();
        } catch {
          // 既に閉じている場合は無視
        }
      }
      poolSubsRef.current = [];
    };

    /** リレー接続を閉じる */
    const closeAll = () => {
      closeSubs();
      if (poolRef.current) {
        try {
          poolRef.current.destroy();
        } catch {
          // 既に閉じている場合は無視
        }
        poolRef.current = null;
      }
    };

    const connect = async () => {
      setStatus("connecting");

      try {
        // SimplePoolを作成（ブートストラップ取得とメインfeedで使い回す）
        const pool = new SimplePool({
          enableReconnect: true,
          enablePing: true,
        });
        pool.maxWaitForConnection = MAX_WAIT_FOR_CONNECTION;
        poolRef.current = pool;

        // ステップ1: kind:10002（リレーリスト）とkind:3（フォローリスト）を1リクエストで取得
        // querySync + maxWait でEOSEタイムアウトをnostr-tools側に委譲
        const bootstrapEvents = await pool.querySync(
          BOOTSTRAP_RELAYS,
          { kinds: [10002, 3], authors: [pubkey], limit: 2 } as Filter,
          { maxWait: BOOTSTRAP_EOSE_TIMEOUT },
        );

        if (cancelled) return;

        // 最新のkind:10002イベントを取得（created_atが最大のもの）
        const relayListEvent = bootstrapEvents
          .filter((e) => e.kind === 10002)
          .reduce<Event | null>((a, b) => (!a || b.created_at > a.created_at ? b : a), null);

        // kind:10002から"r"タグのリレーURLを抽出
        const relayUrls = relayListEvent
          ? relayListEvent.tags
              .filter((tag) => tag[0] === "r" && tag[1])
              .map((tag) => tag[1]!)
          : [];

        // 最新のkind:3イベントを取得（created_atが最大のもの）
        const contactEvent = bootstrapEvents
          .filter((e) => e.kind === 3)
          .reduce<Event | null>((a, b) => (!a || b.created_at > a.created_at ? b : a), null);

        // "p"タグからフォロー中のpubkeyを抽出
        const followPubkeys = contactEvent
          ? contactEvent.tags
              .filter((tag) => tag[0] === "p" && tag[1])
              .map((tag) => tag[1]!)
          : [];

        if (followPubkeys.length === 0) return;

        // ステップ3: リレーリスト決定（kind:10002から取得 or BOOTSTRAP_RELAYSフォールバック）
        const allRelays = relayUrls.length > 0
          ? [...new Set([...BOOTSTRAP_RELAYS, ...relayUrls])]
          : [...BOOTSTRAP_RELAYS];

        setRelayUrls(allRelays);

        setStatus("loading");

        /**
         * リアルタイムリポスト処理: EOSE後に受信したkind:6イベントの元ノートを個別REQで取得する
         * インフライト管理により、同じeventIDの重複REQ発行を防止する
         */
        const handleRealtimeRepost = async (repostEvent: Event, pool: SimplePool, relays: string[]) => {
          // "e" タグから元ノートのeventIDを抽出
          const eTags = repostEvent.tags.filter((tag) => tag[0] === "e" && tag[1]);
          if (eTags.length === 0) return;
          const originalEventId = eTags[eTags.length - 1]![1]!;

          // インフライトチェック: 既にREQ中なら重複発行しない
          if (inflightOriginalNotesRef.current.has(originalEventId)) return;
          inflightOriginalNotesRef.current.add(originalEventId);

          try {
            // 個別REQで元ノートを取得（単一eventIDでの迅速取得）
            const originalEvents = await pool.querySync(
              relays,
              { kinds: [1], ids: [originalEventId] } as Filter,
              { maxWait: BOOTSTRAP_EOSE_TIMEOUT },
            );

            if (cancelled) return;

            if (originalEvents.length > 0) {
              const origEvent = originalEvents[0]!;
              processOriginalNote(origEvent, repostEvent);
              console.log(`[useNostrRelay] リアルタイムリポスト処理完了: 元ノート ${originalEventId.slice(0, 8)}...`);
            } else {
              console.warn(`[useNostrRelay] リアルタイムリポスト: 元ノートが見つかりません ${originalEventId.slice(0, 8)}...`);
            }
          } catch (err) {
            console.error(`[useNostrRelay] リアルタイムリポスト元ノート取得エラー:`, err);
            // 元ノート取得失敗はフィード表示を止めない
          } finally {
            // 完了後にインフライトから除去（成功・失敗問わず）
            inflightOriginalNotesRef.current.delete(originalEventId);
          }
        };

        // ステップ4: フォロー中ユーザーのテキストノート（kind:1）とリポスト（kind:6）を決定したリレーでsubscribe
        // 初期ロード中はバッファに溜めて oneose でまとめて state に反映する
        const initialBuffer: Event[] = [];
        const initialRepostBuffer: Event[] = []; // kind:6リポスト用の初期ロードバッファ
        let initialLoading = true;

        const notesSub = pool.subscribeMany(
          allRelays,
          { kinds: [1, 6], authors: followPubkeys, limit: INITIAL_NOTES_LIMIT } as Filter,
          {
            onevent(event: Event) {
              if (cancelled) return;
              if (initialLoading) {
                if (event.kind === 6) {
                  // kind:6はリポスト用バッファに蓄積（次タスクで処理）
                  initialRepostBuffer.push(event);
                } else {
                  initialBuffer.push(event);
                }
              } else {
                // リアルタイム処理
                if (event.kind === 1) {
                  addNote(event);
                } else if (event.kind === 6) {
                  // リアルタイムリポスト処理: 個別REQで元ノートを取得
                  handleRealtimeRepost(event, pool, allRelays);
                }
              }
            },
            async oneose() {
              if (cancelled) return;
              initialLoading = false;
              // バッファを一括で state に反映
              let displayedNotes: NoteCard[] = [];
              if (initialBuffer.length > 0) {
                const now = Math.floor(Date.now() / 1000);
                const seen = new Set<string>();
                const batchNotes: NoteCard[] = [];
                for (const event of initialBuffer) {
                  if (seen.has(event.id)) continue;
                  seen.add(event.id);
                  const halfLife = event.pubkey === pubkey ? OWNER_SCORE_HALF_LIFE : SCORE_HALF_LIFE;
                  // publishedSlotMapにマッピングがあればそのslotIdを使う
                  const slotId = publishedSlotMapRef.current?.get(event.id) ?? crypto.randomUUID();
                  batchNotes.push({
                    type: "note",
                    slotId,
                    eventId: event.id,
                    pubkey: event.pubkey,
                    content: event.content,
                    created_at: event.created_at,
                    score: calcFreshnessScore(event.created_at, now, halfLife),
                    fadingOut: false,
                  });
                }
                displayedNotes = sortByScore(batchNotes).slice(0, MAX_NOTES);
                setNotes(displayedNotes);
              }
              console.log(`[useNostrRelay] 初期ロード完了: kind:1=${initialBuffer.length}件, kind:6(リポスト)=${initialRepostBuffer.length}件`);

              // kind:6リポストから元ノートのeventIDを集約して一括取得
              if (initialRepostBuffer.length > 0) {
                // kind:6の "e" タグから最後のeventIDを抽出（リポスト対象の元ノートID）
                // 同じkind:6イベントが複数ある場合、元ノートIDごとに最後のリポスト情報を保持する
                const repostMap = new Map<string, Event>(); // 元ノートID → 最後のkind:6イベント
                for (const repostEvent of initialRepostBuffer) {
                  const eTags = repostEvent.tags.filter((tag) => tag[0] === "e" && tag[1]);
                  if (eTags.length === 0) continue;
                  const originalEventId = eTags[eTags.length - 1]![1]!;
                  // 同じ元ノートに対する複数リポストは、最新のリポストで上書き
                  const existing = repostMap.get(originalEventId);
                  if (!existing || repostEvent.created_at > existing.created_at) {
                    repostMap.set(originalEventId, repostEvent);
                  }
                }

                // 既にdisplayedNotesに含まれている元ノートIDを除外
                const existingEventIds = new Set(displayedNotes.map((n) => n.eventId));
                const missingEventIds = [...repostMap.keys()].filter((id) => !existingEventIds.has(id));

                // 既存カードのrepostInfo更新（displayedNotesに既にある元ノート）
                const existingUpdates = [...repostMap.entries()].filter(([id]) => existingEventIds.has(id));
                if (existingUpdates.length > 0) {
                  const updatedNotes = displayedNotes.map((note) => {
                    const repostEvent = repostMap.get(note.eventId);
                    if (!repostEvent) return note;
                    return {
                      ...note,
                      repostInfo: {
                        reposterPubkey: repostEvent.pubkey,
                        repostedAt: repostEvent.created_at,
                      },
                    };
                  });
                  displayedNotes = updatedNotes;
                  setNotes(displayedNotes);
                }

                // 未取得の元ノートを一括REQで取得
                if (missingEventIds.length > 0) {
                  console.log(`[useNostrRelay] リポスト元ノート取得開始: ${missingEventIds.length}件`);
                  try {
                    const originalEvents = await pool.querySync(
                      allRelays,
                      { kinds: [1], ids: missingEventIds } as Filter,
                      { maxWait: BOOTSTRAP_EOSE_TIMEOUT },
                    );
                    if (!cancelled && originalEvents.length > 0) {
                      const now = Math.floor(Date.now() / 1000);
                      const newCards: NoteCard[] = [];
                      for (const origEvent of originalEvents) {
                        // kind:1以外は無視
                        if (origEvent.kind !== 1) continue;
                        // 重複チェック（他のリポストが同じ元ノートを参照している場合）
                        if (displayedNotes.some((n) => n.eventId === origEvent.id)) continue;
                        const repostEvent = repostMap.get(origEvent.id);
                        if (!repostEvent) continue;
                        const halfLife = origEvent.pubkey === pubkey ? OWNER_SCORE_HALF_LIFE : SCORE_HALF_LIFE;
                        const slotId = publishedSlotMapRef.current?.get(origEvent.id) ?? crypto.randomUUID();
                        newCards.push({
                          type: "note",
                          slotId,
                          eventId: origEvent.id,
                          pubkey: origEvent.pubkey,
                          content: origEvent.content,
                          created_at: origEvent.created_at,
                          score: calcFreshnessScore(origEvent.created_at, now, halfLife),
                          fadingOut: false,
                          repostInfo: {
                            reposterPubkey: repostEvent.pubkey,
                            repostedAt: repostEvent.created_at,
                          },
                        });
                      }
                      if (newCards.length > 0) {
                        displayedNotes = sortByScore([...displayedNotes, ...newCards]).slice(0, MAX_NOTES);
                        setNotes(displayedNotes);
                        console.log(`[useNostrRelay] リポスト元ノート追加: ${newCards.length}件`);
                      }
                    }
                  } catch (err) {
                    console.error("[useNostrRelay] リポスト元ノート取得エラー:", err);
                    // 元ノート取得失敗はフィード表示を止めない（kind:1のノートは既に表示済み）
                  }
                }
              }

              setStatus("connected");

              // ステップ4b: 表示中ノートのリアクション（kind:7）をsubscribe
              const eventIds = displayedNotes.map((n) => n.eventId);
              if (eventIds.length > 0) {
                // リアクション初期ロード用バッファ（oneoseでまとめてstateに反映する）
                const reactionBuffer: Event[] = [];
                let reactionInitialLoading = true;
                const reactionSub = pool.subscribeMany(
                  allRelays,
                  { kinds: [7], "#e": eventIds },
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
                        const batchReactions: Reactions = new Map();
                        for (const evt of reactionBuffer) {
                          if (seenReactionIdsRef.current.has(evt.id)) continue;
                          seenReactionIdsRef.current.add(evt.id);
                          const eTags = evt.tags.filter((tag) => tag[0] === "e" && tag[1]);
                          if (eTags.length === 0) continue;
                          const targetId = eTags[eTags.length - 1]![1]!;
                          const emoji = normalizeReactionContent(evt.content);
                          if (emoji === null) continue;
                          
                          // カスタム絵文字の画像URLを取得
                          const imageUrl = extractCustomEmojiUrl(emoji, evt.tags);
                          
                          const eventReactions = batchReactions.get(targetId);
                          if (eventReactions) {
                            const existing = eventReactions.get(emoji);
                            if (existing) {
                              existing.pubkeys.add(evt.pubkey);
                              eventReactions.set(emoji, { count: existing.count + 1, imageUrl: existing.imageUrl ?? imageUrl, pubkeys: existing.pubkeys });
                            } else {
                              eventReactions.set(emoji, { count: 1, imageUrl, pubkeys: new Set([evt.pubkey]) });
                            }
                          } else {
                            batchReactions.set(targetId, new Map([[emoji, { count: 1, imageUrl, pubkeys: new Set([evt.pubkey]) }]]));
                          }
                        }
                        setReactions(batchReactions);
                      }
                      // リアクション初期ロード完了 — 定期再subscribeタイマーを開始
                      lastReactionSubClosedAtRef.current = Math.floor(Date.now() / 1000);
                      reactionIntervalRef.current = window.setInterval(() => {
                        if (cancelled) return;

                        // 1. 現在のリアクションsubを閉じる & poolSubsRefから除去
                        if (reactionSubRef.current) {
                          const closingSub = reactionSubRef.current;
                          closingSub.close();
                          poolSubsRef.current = poolSubsRef.current.filter((s) => s !== closingSub);
                          reactionSubRef.current = null;
                        }

                        // 2. sinceを計算（前回の閉じた時刻ベース）
                        let since = (lastReactionSubClosedAtRef.current ?? Math.floor(Date.now() / 1000)) - REACTION_SINCE_SAFETY_MARGIN;
                        if (newNotesMinCreatedAtRef.current !== undefined) {
                          since = Math.min(since, newNotesMinCreatedAtRef.current);
                        }

                        // 3. 閉じた時刻を記録（since計算の後に更新）
                        lastReactionSubClosedAtRef.current = Math.floor(Date.now() / 1000);

                        // 4. newNotesMinCreatedAtRefをリセット
                        newNotesMinCreatedAtRef.current = undefined;

                        // 5. 現在のnotesからeventIdを収集
                        const currentEventIds = notesRef.current.map((n) => n.eventId);
                        if (currentEventIds.length === 0) return;

                        // 6. 新しいリアクションsubscriptionを発行
                        const newReactionSub = pool.subscribeMany(
                          allRelays,
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
                        poolSubsRef.current.push(newReactionSub);
                      }, REACTION_POLL_INTERVAL);
                    },
                  },
                );
                reactionSubRef.current = reactionSub;
                poolSubsRef.current.push(reactionSub);
              }

              // 以降のイベントは addNote でリアルタイム処理
            },
          },
        );
        poolSubsRef.current.push(notesSub);

        // ステップ5: フォロー中ユーザーのプロフィール（kind:0）を取得
        const profileSub = pool.subscribeMany(
          allRelays,
          { kinds: [0], authors: followPubkeys } as Filter,
          {
            onevent(event: Event) {
              if (!cancelled) {
                upsertProfile(event);
              }
            },
            oneose() {
              // プロフィール取得完了
            },
          },
        );
        poolSubsRef.current.push(profileSub);
      } catch {
        if (!cancelled) {
          setStatus("error");
        }
      }
    };

    connect();

    // クリーンアップ用にrefの値をキャプチャ
    const seenReactionIds = seenReactionIdsRef.current;

    // クリーンアップ（pubkey変更時にステートもリセット）
    return () => {
      cancelled = true;
      // リアクション定期再subscribeタイマーを停止
      if (reactionIntervalRef.current !== null) {
        clearInterval(reactionIntervalRef.current);
        reactionIntervalRef.current = null;
      }
      seenReactionIds.clear();
      inflightOriginalNotesRef.current.clear();
      closeAll();
      setStatus("connecting");
      setNotes([]);
      setProfiles(new Map());
      setReactions(new Map());
    };
  }, [pubkey, addNote, addReaction, processOriginalNote, upsertProfile, normalizeReactionContent, publishedSlotMapRef]);

  /** 署名済みイベントを全リレーにpublishする（1つ以上のリレーに成功すればOK） */
  const publishEvent = useCallback(
    async (event: NostrEvent) => {
      const pool = poolRef.current;
      if (!pool || relayUrls.length === 0) {
        throw new Error("リレーに接続されていません");
      }
      const results = await Promise.allSettled(
        pool.publish(relayUrls, event as Event),
      );
      const hasSuccess = results.some((r) => r.status === "fulfilled");
      if (!hasSuccess) {
        throw new Error("すべてのリレーへの送信に失敗しました");
      }
    },
    [relayUrls],
  );

  /** NIP-25準拠のリアクションイベントを構築・署名・送信し、楽観的にUIを更新する */
  const sendReaction = useCallback(
    async (targetEventId: string, targetPubkey: string, emoji: string, imageUrl?: string) => {
      // NIP-07拡張の存在チェック
      const nostrExt = (window as unknown as { nostr?: { signEvent: (event: Record<string, unknown>) => Promise<SignedNostrEvent> } }).nostr;
      if (!nostrExt) {
        throw new Error("NIP-07拡張（window.nostr）が見つかりません");
      }

      // NIP-25準拠のkind:7イベントを構築
      const tags: string[][] = [
        ["e", targetEventId, "", targetPubkey],
        ["p", targetPubkey],
        ["k", "1"],
      ];

      // カスタム絵文字（:shortcode: 形式）の場合はemojiタグを追加
      let content = emoji;
      if (emoji.startsWith(":") && emoji.endsWith(":") && emoji.length > 2 && imageUrl) {
        const shortcode = emoji.slice(1, -1);
        tags.push(["emoji", shortcode, imageUrl]);
        content = emoji;
      }

      const unsignedEvent = {
        kind: 7,
        content,
        tags,
        created_at: Math.floor(Date.now() / 1000),
      };

      // NIP-07拡張で署名
      const signedEvent = await nostrExt.signEvent(unsignedEvent);

      // リレーに送信
      await publishEvent(signedEvent as unknown as NostrEvent);

      // 楽観的にローカルのreactions stateを更新
      addReaction(signedEvent as unknown as Event);
    },
    [publishEvent, addReaction],
  );

  return { notes, profiles, reactions, status, relayUrls, publishEvent, sendReaction };
}
