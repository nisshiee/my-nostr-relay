// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "nostr-tools/core";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { SimplePool } from "nostr-tools/pool";
import { signEventWithActiveSigner } from "../../lib/nostrSigner";
import { buildYo } from "../../lib/yo";
import { useYo } from "../useYo";

vi.mock("../../lib/nostrSigner", () => ({ signEventWithActiveSigner: vi.fn() }));
const me = generateSecretKey(), other = generateSecretKey();
const pubkey = getPublicKey(me), otherPubkey = getPublicKey(other);
const now = 1_795_823_950;
const profile = (key: Uint8Array, created_at: number) => finalizeEvent({ kind: 0, content: "{}", tags: [], created_at }, key);
const relays = ["wss://relay.example"];
const signer = vi.mocked(signEventWithActiveSigner);
function fixture() {
  const callbacks: ((event: Event) => void)[] = [];
  const close = vi.fn();
  const subscribeMany = vi.fn((_urls, _filter, params: { onevent: (event: Event) => void }) => {
    callbacks.push(params.onevent);
    return { close };
  });
  const querySync = vi.fn<() => Promise<Event[]>>();
  const fetchProfiles = vi.fn();
  const publishEvent = vi.fn().mockResolvedValue(undefined);
  const pool = { subscribeMany, querySync } as unknown as SimplePool;
  const hook = renderHook(({ account }) => useYo({ pubkey: account, pool, relayUrls: relays, fetchProfiles, publishEvent }),
    { initialProps: { account: pubkey } });
  return { ...hook, callbacks, close, subscribeMany, querySync, fetchProfiles, publishEvent };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now * 1000);
  signer.mockReset();
  signer.mockImplementation(async event => finalizeEvent(event, me));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Yoの購読と送信", () => {
  it("タグのない互換Yoを受け付け、リレーの重複は1枚、署名不正・別宛先・通常リアクションは表示しない", () => {
    const f = fixture();
    const template = buildYo(profile(me, now - 10), now);
    const legacy = finalizeEvent({ ...template, tags: template.tags.filter(tag => tag[0] !== "t") }, other);
    const modified = { ...finalizeEvent({ ...template, created_at: now - 1 }, other), sig: "0".repeat(128) };
    const normal = finalizeEvent({ ...template, content: "👍" }, other);
    const notForMe = finalizeEvent(buildYo(profile(other, now - 20), now), other);
    const future = finalizeEvent({ ...template, created_at: now + 601 }, other);
    const invalidUrl = finalizeEvent({ ...template, tags: template.tags.map(t => t[0] === "emoji" ? ["emoji", "yo", "http://example.test/x"] : t) }, other);
    expect(f.subscribeMany).toHaveBeenCalledWith(relays, { kinds: [7], "#p": [pubkey], "#k": ["0"], limit: 30 }, expect.anything());
    act(() => { for (const event of [legacy, legacy, modified, normal, notForMe, future, invalidUrl]) f.callbacks[0](event); });
    expect(f.result.current.yoCards).toEqual([expect.objectContaining({ type: "yo", eventId: legacy.id, pubkey: otherPubkey, emojiUrl: template.tags.find(tag => tag[0] === "emoji")?.[2] })]);
    expect(f.fetchProfiles).toHaveBeenCalledTimes(1);
    f.rerender({ account: otherPubkey });
    act(() => f.callbacks[0](legacy));
    expect(f.close).toHaveBeenCalledTimes(2);
    expect(f.result.current.yoCards).toEqual([]);
  });

  it("最新の有効なプロフィールに署名し、二重操作でも一度だけ送信する", async () => {
    const f = fixture();
    const latest = profile(other, now - 10);
    const forged = { ...profile(other, now), sig: "0".repeat(128) };
    f.querySync.mockResolvedValue([profile(other, now - 60), forged, latest]);
    const first = f.result.current.sendYo(otherPubkey);
    expect(f.result.current.sendYo(otherPubkey)).toBe(first);
    await act(async () => { await first; });
    expect(signer).toHaveBeenCalledOnce();
    expect(f.publishEvent).toHaveBeenCalledOnce();
    expect(f.publishEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 7, content: ":yo:", tags: expect.arrayContaining([
      ["e", latest.id, "", otherPubkey], ["p", otherPubkey], ["k", "0"], ["t", "yo"],
    ]) }));
  });

  it("送信済みYoをリレーから復元し、自分以外の署名や複数宛先、通常リアクションを除外する", () => {
    const f = fixture();
    const template = buildYo(profile(other, now), now - 5);
    const sent = finalizeEvent(template, me);
    expect(f.subscribeMany).toHaveBeenCalledWith(relays, { kinds: [7], authors: [pubkey], "#k": ["0"], limit: 30 }, expect.anything());
    act(() => {
      for (const event of [sent, sent, finalizeEvent({ ...template }, other),
        { ...sent, id: "0".repeat(64) },
        finalizeEvent({ ...template, tags: [...template.tags, ["p", pubkey]] }, me),
        finalizeEvent({ ...template, content: "👍" }, me),
        finalizeEvent(buildYo(profile(me, now), now), me)]) {
        f.callbacks[1](event);
      }
    });
    expect(f.result.current.yoCards).toEqual([expect.objectContaining({
      direction: "outgoing", recipientPubkey: otherPubkey, pubkey, eventId: sent.id, created_at: now - 5,
    })]);
    expect(f.fetchProfiles).toHaveBeenCalledExactlyOnceWith([otherPubkey]);
  });

  it("リレーの受理後にだけ表示し、購読で同じイベントが来ても1枚にする", async () => {
    const f = fixture();
    f.querySync.mockResolvedValue([profile(other, now)]);
    let acknowledge!: () => void;
    f.publishEvent.mockImplementation(() => new Promise<void>(resolve => { acknowledge = resolve; }));
    const sending = f.result.current.sendYo(otherPubkey);
    await vi.waitFor(() => expect(f.publishEvent).toHaveBeenCalledOnce());
    expect(f.result.current.yoCards).toEqual([]);
    await act(async () => { acknowledge(); await sending; });
    const sent = f.publishEvent.mock.calls[0][0] as Event;
    act(() => f.callbacks[1](sent));
    expect(f.result.current.yoCards).toEqual([expect.objectContaining({ direction: "outgoing", eventId: sent.id })]);
    expect(f.fetchProfiles).toHaveBeenCalledExactlyOnceWith([otherPubkey]);
  });

  it("送信失敗ではカードを作らず、アカウント変更前の送信結果も混ぜない", async () => {
    const f = fixture();
    f.querySync.mockResolvedValue([profile(other, now)]);
    f.publishEvent.mockRejectedValueOnce(new Error("リレーに拒否された"));
    await expect(f.result.current.sendYo(otherPubkey)).rejects.toThrow("リレーに拒否された");
    expect(f.result.current.yoCards).toEqual([]);
    let acknowledge!: () => void;
    f.publishEvent.mockImplementation(() => new Promise<void>(resolve => { acknowledge = resolve; }));
    const sending = f.result.current.sendYo(otherPubkey);
    await vi.waitFor(() => expect(f.publishEvent).toHaveBeenCalledTimes(2));
    f.rerender({ account: otherPubkey });
    await act(async () => { acknowledge(); await sending; });
    expect(f.result.current.yoCards).toEqual([]);
  });

  it("送信Yoの件数上限で受信Yoが消えない", () => {
    const f = fixture();
    const incoming = finalizeEvent(buildYo(profile(me, now), now - 100), other);
    const target = profile(other, now);
    act(() => {
      f.callbacks[0](incoming);
      for (let offset = 0; offset <= 30; offset++) {
        f.callbacks[1](finalizeEvent(buildYo(target, now - offset), me));
      }
    });
    expect(f.result.current.yoCards).toHaveLength(31);
    expect(f.result.current.yoCards.at(-1)?.eventId).toBe(incoming.id);
    expect(f.result.current.yoCards.some(item => item.created_at === now - 30)).toBe(false);
  });

  it("署名器が宛先を書き換えたら、正しく署名されていても送らない", async () => {
    const f = fixture();
    f.querySync.mockResolvedValue([profile(other, now)]);
    signer.mockImplementation(async event => {
      event.tags.find(t => t[0] === "p")![1] = pubkey;
      return finalizeEvent(event, me);
    });
    await expect(f.result.current.sendYo(otherPubkey)).rejects.toThrow("署名結果");
    expect(f.publishEvent).not.toHaveBeenCalled();
  });

  it("プロフィールがなければ署名せず、自分向けも送らない", async () => {
    const f = fixture();
    f.querySync.mockResolvedValue([]);
    await expect(f.result.current.sendYo(pubkey)).rejects.toThrow("送れません");
    await expect(f.result.current.sendYo(otherPubkey)).rejects.toThrow("プロフィール");
    expect(signer).not.toHaveBeenCalled();
  });
});
