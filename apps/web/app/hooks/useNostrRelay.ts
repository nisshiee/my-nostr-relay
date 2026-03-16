import { useEffect, useRef, useState, useCallback } from "react";
import { Relay } from "nostr-tools/relay";
import type { Event } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import type { Subscription } from "nostr-tools/abstract-relay";
import { RELAY_URL, MAX_NOTES } from "../lib/constants";
import { calcFreshnessScore, sortByScore } from "../lib/scoring";
import type { CanvasNote, NostrProfile } from "../lib/types";

type ConnectionStatus = "connecting" | "connected" | "error";

interface UseNostrRelayResult {
  notes: CanvasNote[];
  profiles: Map<string, NostrProfile>;
  status: ConnectionStatus;
}

/**
 * Nostrリレーに接続し、フォロー中ユーザーのノートとプロフィールを取得するhook
 */
export function useNostrRelay(pubkey: string | null): UseNostrRelayResult {
  const [notes, setNotes] = useState<CanvasNote[]>([]);
  const [profiles, setProfiles] = useState<Map<string, NostrProfile>>(
    new Map(),
  );
  const [status, setStatus] = useState<ConnectionStatus>("connecting");

  // クリーンアップ用のref
  const relayRef = useRef<Relay | null>(null);
  const subsRef = useRef<Subscription[]>([]);

  /** ノートを追加（重複排除・スコア計算・prune込み） */
  const addNote = useCallback((event: Event) => {
    setNotes((prev) => {
      // 重複チェック
      if (prev.some((n) => n.id === event.id)) return prev;

      const now = Math.floor(Date.now() / 1000);
      const newNote: CanvasNote = {
        id: event.id,
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
  }, []);

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
      setStatus("connecting");
      setNotes([]);
      setProfiles(new Map());
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
    };

    /** リレー接続を閉じる */
    const closeRelay = () => {
      closeSubs();
      if (relayRef.current) {
        try {
          relayRef.current.close();
        } catch {
          // 既に閉じている場合は無視
        }
        relayRef.current = null;
      }
    };

    const connect = async () => {
      setStatus("connecting");

      try {
        // リレーに接続
        const relay = await Relay.connect(RELAY_URL);
        if (cancelled) {
          relay.close();
          return;
        }
        relayRef.current = relay;
        setStatus("connected");

        // ステップ1: Contact List（kind:3）を取得してフォローリストを抽出
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

        // ステップ2: フォロー中ユーザーのテキストノート（kind:1）をsubscribe
        const notesSub = relay.subscribe(
          [{ kinds: [1], authors: followPubkeys } as Filter],
          {
            onevent(event: Event) {
              if (!cancelled) {
                addNote(event);
              }
            },
            oneose() {
              // 過去ノートの取得完了、以降はリアルタイム受信
            },
          },
        );
        subsRef.current.push(notesSub);

        // ステップ3: フォロー中ユーザーのプロフィール（kind:0）を取得
        const profileSub = relay.subscribe(
          [{ kinds: [0], authors: followPubkeys } as Filter],
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
        subsRef.current.push(profileSub);
      } catch {
        if (!cancelled) {
          setStatus("error");
        }
      }
    };

    connect();

    // クリーンアップ
    return () => {
      cancelled = true;
      closeRelay();
    };
  }, [pubkey, addNote, upsertProfile]);

  return { notes, profiles, status };
}
