import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { AuthProvider, useAuth } from "../AuthContext";

afterEach(() => vi.unstubAllGlobals());

function AvailabilityProbe() {
  const { nip07Available } = useAuth();
  return createElement(
    "span",
    null,
    nip07Available === null ? "pending" : String(nip07Available),
  );
}

describe("AuthProvider hydration compatibility", () => {
  it("NIP-07拡張が存在しても初回renderはSSRと同じ未検出状態にする", () => {
    vi.stubGlobal("window", {
      nostr: {
        getPublicKey: vi.fn(async () => "a".repeat(64)),
        signEvent: vi.fn(),
      },
    });

    const html = renderToString(
      createElement(
        AuthProvider,
        null,
        createElement(AvailabilityProbe),
      ),
    );

    expect(html).toContain(">pending<");
  });
});
