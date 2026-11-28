import { useCallback, useEffect, useRef, useState } from "react";
import type { Event } from "nostr-tools/core";
import type { SimplePool } from "nostr-tools/pool";
import { signEventWithActiveSigner } from "../lib/nostrSigner";
import type { YoCard } from "../lib/types";
import type { NostrEvent } from "../types/nostr";
import { BOOTSTRAP_EOSE_TIMEOUT } from "../lib/constants";
import { buildYo, getOutgoingYoRecipient, isExpectedSignedYo, isIncomingYo, isYoPubkey, newestYoProfile } from "../lib/yo";

const MAX_CARDS = 30;
const EMPTY: YoCard[] = [];
type Session = { pubkey: string; pool: SimplePool; relayUrls: string[]; pending: Map<string, Promise<void>>; profilesRequested: Set<string> };
type Options = {
  pubkey: string | null;
  pool: SimplePool | null;
  relayUrls: string[];
  fetchProfiles: (pubkeys: string[]) => void;
  publishEvent: (event: NostrEvent) => Promise<void>;
};

export function useYo({ pubkey, pool, relayUrls, fetchProfiles, publishEvent }: Options) {
  const sessionRef = useRef<Session | null>(null);
  const [timeline, setTimeline] = useState<{ session: Session; cards: YoCard[] } | null>(null);

  const addCard = useCallback((session: Session, event: Event, recipientPubkey?: string) => {
    if (sessionRef.current !== session) return;
    const base = {
      type: "yo" as const, slotId: "yo:" + event.id, eventId: event.id, pubkey: event.pubkey,
      created_at: event.created_at, score: 0,
      emojiUrl: event.tags.find(tag => tag[0] === "emoji" && tag[1] === "yo")?.[2],
    };
    const card: YoCard = recipientPubkey
      ? { ...base, direction: "outgoing", recipientPubkey }
      : { ...base, direction: "incoming" };
    const participant = recipientPubkey ?? event.pubkey;
    const requested = session.profilesRequested;
    if (!requested.has(participant)) {
      if (requested.size >= MAX_CARDS * 8) requested.delete(requested.values().next().value!);
      requested.add(participant);
      fetchProfiles([participant]);
    }
    setTimeline(previous => {
      const cards = previous?.session === session ? previous.cards : EMPTY;
      if (cards.some(item => item.eventId === card.eventId)) return previous;
      const sorted = [...cards, card].sort((a, b) => b.created_at - a.created_at || a.eventId.localeCompare(b.eventId));
      const counts = { incoming: 0, outgoing: 0 };
      return { session, cards: sorted.filter(item => ++counts[item.direction] <= MAX_CARDS) };
    });
  }, [fetchProfiles]);

  useEffect(() => {
    if (!pubkey || !pool || relayUrls.length === 0) return;
    const session: Session = { pubkey, pool, relayUrls, pending: new Map(), profilesRequested: new Set() };
    sessionRef.current = session;
    const seen = new Set<string>();
    function accept(event: Event, recipientPubkey?: string) {
      if (seen.size >= MAX_CARDS * 8) seen.delete(seen.values().next().value!);
      seen.add(event.id);
      addCard(session, event, recipientPubkey);
    }
    const incoming = pool.subscribeMany(relayUrls, {
      kinds: [7], "#p": [pubkey], "#k": ["0"], limit: MAX_CARDS,
    }, {
      onevent(event) {
        if (sessionRef.current !== session || seen.has(event.id) || !isIncomingYo(event, pubkey)) return;
        accept(event);
      },
    });
    const outgoing = pool.subscribeMany(relayUrls, {
      kinds: [7], authors: [pubkey], "#k": ["0"], limit: MAX_CARDS,
    }, {
      onevent(event) {
        if (sessionRef.current !== session || seen.has(event.id)) return;
        const recipient = getOutgoingYoRecipient(event, pubkey);
        if (recipient) accept(event, recipient);
      },
    });
    return () => {
      if (sessionRef.current === session) sessionRef.current = null;
      session.pending.clear();
      incoming.close();
      outgoing.close();
    };
  }, [pubkey, pool, relayUrls, addCard]);

  const sendYo = useCallback((target: string): Promise<void> => {
    const session = sessionRef.current;
    if (!pubkey || !pool || !session || session.pubkey !== pubkey || session.pool !== pool || session.relayUrls !== relayUrls) {
      return Promise.reject(new Error("リレーに接続されていません。"));
    }
    if (!isYoPubkey(target) || target === pubkey) return Promise.reject(new Error("この相手にはYoを送れません。"));
    const existing = session.pending.get(target);
    if (existing) return existing;
    const sending = (async () => {
      const profiles = await pool.querySync(relayUrls, { kinds: [0], authors: [target], limit: 5 }, {
        maxWait: BOOTSTRAP_EOSE_TIMEOUT,
      });
      if (sessionRef.current !== session) throw new Error("接続が変わったためYoの送信を中止しました。");
      const profile = newestYoProfile(profiles, target);
      if (!profile) throw new Error("相手のプロフィールを確認できないためYoを送れませんでした。");
      const template = buildYo(profile);
      // 署名器に渡すオブジェクトが書き換えられても元の要求内容を保つ。
      const signed: Event = await signEventWithActiveSigner({ ...template, tags: template.tags.map(tag => [...tag]) });
      if (sessionRef.current !== session || !isExpectedSignedYo(signed, template, pubkey)) {
        throw new Error("署名結果を確認できないためYoを送信しませんでした。");
      }
      await publishEvent(signed);
      addCard(session, signed, target);
    })();
    session.pending.set(target, sending);
    const clear = () => { if (session.pending.get(target) === sending) session.pending.delete(target); };
    void sending.then(clear, clear);
    return sending;
  }, [pubkey, pool, relayUrls, publishEvent, addCard]);

  const current = timeline?.session;
  return { yoCards: current?.pubkey === pubkey && current?.pool === pool && current?.relayUrls === relayUrls ? timeline!.cards : EMPTY, sendYo };
}
