import type React from "react";
import { useEffect, useRef, useState, useCallback } from "react";
import { Relay } from "nostr-tools/relay";
import { SimplePool } from "nostr-tools/pool";
import type { Event } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import type { Subscription } from "nostr-tools/abstract-relay";
import type { SubCloser } from "nostr-tools/abstract-pool";
import { RELAY_URL, MAX_NOTES, INITIAL_NOTES_LIMIT } from "../lib/constants";
import { calcFreshnessScore, sortByScore } from "../lib/scoring";
import type { NoteCard, NostrProfile } from "../lib/types";

type ConnectionStatus = "connecting" | "loading" | "connected" | "error";

interface UseNostrRelayResult {
  notes: NoteCard[];
  profiles: Map<string, NostrProfile>;
  status: ConnectionStatus;
  relayUrls: string[];
  publishEvent: (event: NostrEvent) => Promise<void>;
}

/**
 * Nostrリレーに接続し、フォロー中ユーザーのノートとプロフィールを取得するhook
 *
 * 接続フロー:
 * 1. 自分のリレーに接続してkind:10002（NIP-65リレーリスト）とkind:3（フォローリスト）を取得
 * 2. 取得したリレーリスト全体にSimplePoolで接続
 * 3. フォロー中ユーザーのkind:1（ノート）とkind:0（プロフィール）をsubscribe
 */
export function useNostrRelay(
  pubkey: string | null,
  publishedIdsRef?: React.RefObject<Set<string>>,
): UseNostrRelayResult {
  const [notes, setNotes] = useState<NoteCard[]>([]);
  const [profiles, setProfiles] = useState<Map<string, NostrProfile>>(
    new Map(),
  );
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [relayUrls, setRelayUrls] = useState<string[]>([]);

  // クリーンアップ用のref
  const relayRef = useRef<Relay | null>(null);
  const poolRef = useRef<SimplePool | null>(null);
  const subsRef = useRef<Subscription[]>([]);
  const poolSubsRef = useRef<SubCloser[]>([]);

  /** ノートを追加（重複排除・スコア計算・prune込み） */
  const addNote = useCallback((event: Event) => {
    setNotes((prev) => {
      // eventIDで重複チェック
      if (prev.some((n) => n.eventId === event.id)) return prev;
      // Publish済みノートはスキップ（二重追加防止）
      if (publishedIdsRef?.current?.has(event.id)) return prev;

      const now = Math.floor(Date.now() / 1000);
      const newNote: NoteCard = {
        type: "note",
        slotId: crypto.randomUUID(),
        eventId: event.id,
        pubkey: event.pubkey,
        content: event.content,
        created_at: event.created_at,
        score: calcFreshnessScore(event.created_at, now),
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
  }, [publishedIdsRef]);

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

  useEffect(() => {
    if (!pubkey) {
      return;
    }

    let cancelled = false;

    /** 全subscriptionを閉じる */
    const closeSubs = () => {
      for (const sub of subsRef.current) {
        try {
          sub.close();
        } catch {
          // 既に閉じている場合は無視
        }
      }
      subsRef.current = [];
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
      if (relayRef.current) {
        try {
          relayRef.current.close();
        } catch {
          // 既に閉じている場合は無視
        }
        relayRef.current = null;
      }
      if (poolRef.current) {
        try {
          poolRef.current.close([]);
        } catch {
          // 既に閉じている場合は無視
        }
        poolRef.current = null;
      }
    };

    const connect = async () => {
      setStatus("connecting");

      try {
        // 自分のリレーに接続してメタデータを取得
        const relay = await Relay.connect(RELAY_URL, { enableReconnect: true });
        if (cancelled) {
          relay.close();
          return;
        }
        relayRef.current = relay;

        // ステップ1: Relay List Metadata（NIP-65, kind:10002）を取得
        const relayUrls = await new Promise<string[]>(
          (resolve) => {
            let found = false;
            const sub = relay.subscribe(
              [{ kinds: [10002], authors: [pubkey], limit: 1 } as Filter],
              {
                onevent(event: Event) {
                  if (found) return;
                  found = true;
                  // "r"タグからリレーURLを抽出（read/write問わず）
                  const urls = event.tags
                    .filter((tag) => tag[0] === "r" && tag[1])
                    .map((tag) => tag[1]!);
                  resolve(urls);
                },
                oneose() {
                  if (!found) resolve([]);
                },
              },
            );
            subsRef.current.push(sub);
          },
        );

        if (cancelled) return;

        // ステップ2: Contact List（kind:3）を取得してフォローリストを抽出
        const followPubkeys = await new Promise<string[]>(
          (resolve) => {
            let found = false;
            const sub = relay.subscribe(
              [{ kinds: [3], authors: [pubkey], limit: 1 } as Filter],
              {
                onevent(event: Event) {
                  if (found) return;
                  found = true;
                  // "p"タグからフォロー中のpubkeyを抽出
                  const pks = event.tags
                    .filter((tag) => tag[0] === "p" && tag[1])
                    .map((tag) => tag[1]!);
                  resolve(pks);
                },
                oneose() {
                  // kind:3が見つからなかった場合は空配列
                  if (!found) resolve([]);
                },
              },
            );
            subsRef.current.push(sub);
          },
        );

        if (cancelled || followPubkeys.length === 0) return;

        // ステップ3: リレーリストを使ってSimplePoolで複数リレーに接続
        // 自分のリレーも含める（重複はSimplePoolが処理）
        const allRelays = relayUrls.length > 0
          ? [...new Set([RELAY_URL, ...relayUrls])]
          : [RELAY_URL];

        console.log("接続リレー一覧:", allRelays);
        setRelayUrls(allRelays);

        const pool = new SimplePool({ enableReconnect: true });
        poolRef.current = pool;
        setStatus("loading");

        // ステップ4: フォロー中ユーザーのテキストノート（kind:1）をsubscribe
        // 初期ロード中はバッファに溜めて oneose でまとめて state に反映する
        const initialBuffer: Event[] = [];
        let initialLoading = true;

        const notesSub = pool.subscribeMany(
          allRelays,
          { kinds: [1], authors: followPubkeys, limit: INITIAL_NOTES_LIMIT },
          {
            onevent(event: Event) {
              if (cancelled) return;
              if (initialLoading) {
                initialBuffer.push(event);
              } else {
                addNote(event);
              }
            },
            oneose() {
              if (cancelled) return;
              initialLoading = false;
              // バッファを一括で state に反映
              if (initialBuffer.length > 0) {
                const now = Math.floor(Date.now() / 1000);
                const seen = new Set<string>();
                const batchNotes: NoteCard[] = [];
                for (const event of initialBuffer) {
                  if (seen.has(event.id)) continue;
                  seen.add(event.id);
                  batchNotes.push({
                    type: "note",
                    slotId: crypto.randomUUID(),
                    eventId: event.id,
                    pubkey: event.pubkey,
                    content: event.content,
                    created_at: event.created_at,
                    score: calcFreshnessScore(event.created_at, now),
                    fadingOut: false,
                  });
                }
                const sorted = sortByScore(batchNotes);
                setNotes(sorted.slice(0, MAX_NOTES));
              }
              setStatus("connected");
              // 以降のイベントは addNote でリアルタイム処理
            },
          },
        );
        poolSubsRef.current.push(notesSub);

        // ステップ5: フォロー中ユーザーのプロフィール（kind:0）を取得
        const profileSub = pool.subscribeMany(
          allRelays,
          { kinds: [0], authors: followPubkeys },
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

    // クリーンアップ（pubkey変更時にステートもリセット）
    return () => {
      cancelled = true;
      closeAll();
      setStatus("connecting");
      setNotes([]);
      setProfiles(new Map());
    };
  }, [pubkey, addNote, upsertProfile]);

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

  return { notes, profiles, status, relayUrls, publishEvent };
}
