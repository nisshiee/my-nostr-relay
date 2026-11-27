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
const now = Math.floor(Date.now() / 1000);
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
beforeEach(() => { signer.mockReset(); signer.mockImplementation(async event => finalizeEvent(event, me)); });
afterEach(cleanup);

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
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.result.current.yoCards).toEqual([]);
  });

  it("最新の有効なプロフィールに署名し、二重操作でも一度だけ送信する", async () => {
    const f = fixture();
    const latest = profile(other, now - 10);
    const forged = { ...profile(other, now), sig: "0".repeat(128) };
    f.querySync.mockResolvedValue([profile(other, now - 60), forged, latest]);
    const first = f.result.current.sendYo(otherPubkey);
    expect(f.result.current.sendYo(otherPubkey)).toBe(first);
    await first;
    expect(signer).toHaveBeenCalledOnce();
    expect(f.publishEvent).toHaveBeenCalledOnce();
    expect(f.publishEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 7, content: ":yo:", tags: expect.arrayContaining([
      ["e", latest.id, "", otherPubkey], ["p", otherPubkey], ["k", "0"], ["t", "yo"],
    ]) }));
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
