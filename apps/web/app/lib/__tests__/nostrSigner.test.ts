import { afterEach, describe, expect, it, vi } from "vitest";
import type { Nostr, NostrEvent, SignedNostrEvent } from "../../types/nostr";
import {
  activateSigner,
  clearActiveSigner,
  signEventWithActiveSigner,
} from "../nostrSigner";

const unsignedEvent: NostrEvent = {
  kind: 1,
  created_at: 1,
  tags: [],
  content: "test",
};

function signed(pubkey: string): SignedNostrEvent {
  return { ...unsignedEvent, id: "id", sig: "sig", pubkey };
}

afterEach(() => clearActiveSigner());

describe("signEventWithActiveSigner", () => {
  it("ログインした公開鍵の署名結果を返す", async () => {
    const pubkey = "a".repeat(64);
    const signer: Nostr = {
      getPublicKey: vi.fn(async () => pubkey),
      signEvent: vi.fn(async () => signed(pubkey)),
    };
    activateSigner(signer, pubkey);

    await expect(signEventWithActiveSigner(unsignedEvent)).resolves.toEqual(signed(pubkey));
  });

  it("署名中にログアウトした場合は遅延結果を破棄する", async () => {
    const pubkey = "a".repeat(64);
    let finish: (event: SignedNostrEvent) => void = () => undefined;
    const signer: Nostr = {
      getPublicKey: vi.fn(async () => pubkey),
      signEvent: vi.fn(
        () => new Promise<SignedNostrEvent>((resolve) => {
          finish = resolve;
        }),
      ),
    };
    activateSigner(signer, pubkey);
    const result = signEventWithActiveSigner(unsignedEvent);

    clearActiveSigner();
    finish(signed(pubkey));

    await expect(result).rejects.toThrow("ログイン状態が変更");
  });

  it("別アカウントの署名結果を拒否してセッションを無効化する", async () => {
    const pubkey = "a".repeat(64);
    const signer: Nostr = {
      getPublicKey: vi.fn(async () => pubkey),
      signEvent: vi.fn(async () => signed("b".repeat(64))),
    };
    activateSigner(signer, pubkey);

    await expect(signEventWithActiveSigner(unsignedEvent)).rejects.toThrow(
      "アカウントが切り替わった",
    );
    await expect(signEventWithActiveSigner(unsignedEvent)).rejects.toThrow(
      "ログインしていません",
    );
  });
});

