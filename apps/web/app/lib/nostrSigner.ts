import type { Nostr, NostrEvent, SignedNostrEvent } from "../types/nostr";

export type NostrLoginMethod = "extension" | "remote";

interface SignerSession {
  provider: Nostr;
  pubkey: string;
  generation: number;
}

let generation = 0;
let activeSession: SignerSession | null = null;

/** 認証済み署名器を固定し、途中の window.nostr 差し替えから保護する。 */
export function activateSigner(provider: Nostr, pubkey: string): void {
  generation += 1;
  activeSession = { provider, pubkey, generation };
}

/** 保留中の署名結果を無効化して、現在の署名器を破棄する。 */
export function clearActiveSigner(): void {
  generation += 1;
  activeSession = null;
}

function invalidateSigner(message: string): never {
  clearActiveSigner();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("nostr-auth-invalidated", { detail: message }));
  }
  throw new Error(message);
}

/**
 * ログイン時に固定した署名器で署名する。
 * ログアウト後の遅延結果や別アカウントの署名結果は受け入れない。
 */
export async function signEventWithActiveSigner(
  event: NostrEvent,
): Promise<SignedNostrEvent> {
  const session = activeSession;
  if (!session) {
    throw new Error("Nostr署名器にログインしていません");
  }

  const signedEvent = await session.provider.signEvent(event);
  if (activeSession !== session || generation !== session.generation) {
    throw new Error("ログイン状態が変更されたため、署名結果を破棄しました");
  }
  if (signedEvent.pubkey !== session.pubkey) {
    return invalidateSigner(
      "署名器のアカウントが切り替わったため、安全のためログアウトしました",
    );
  }
  return signedEvent;
}

