import { describe, expect, it } from "vitest";
import {
  MAX_EXTERNAL_RELAY_HINTS,
  resolveRelayTargets,
  validateExternalRelayCandidate,
  type ExternalRelayCandidate,
} from "../relayUrlPolicy";

const origin = { kind: "nevent" } as const;

function candidate(rawUrl: unknown): ExternalRelayCandidate {
  return { rawUrl, origin };
}

describe("validateExternalRelayCandidate", () => {
  it.each([
    "wss://relay.example.com/",
    "wss://8.8.8.8/",
    "wss://[2606:4700:4700::1111]/",
    "wss://192.0.0.9/",
    "wss://192.0.0.10/",
    "wss://[::ffff:8.8.8.8]/",
    "wss://[64:ff9b::808:808]/",
    "wss://[2001:1::1]/",
  ])("allows public wss relay %s", (rawUrl) => {
    const decision = validateExternalRelayCandidate(candidate(rawUrl));
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.value.origin).toEqual(origin);
    }
  });

  it.each([
    "ws://relay.example.com/",
    "https://relay.example.com/",
    "http://relay.example.com/",
    "relay.example.com",
    "ftp://relay.example.com/",
  ])("rejects external relay with unsupported scheme %s", (rawUrl) => {
    expect(validateExternalRelayCandidate(candidate(rawUrl))).toMatchObject({
      ok: false,
      reason: rawUrl === "relay.example.com" ? "invalid-url" : "scheme",
    });
  });

  it.each([
    "wss://10.0.0.1/",
    "wss://172.16.0.1/",
    "wss://192.168.1.1/",
    "wss://127.0.0.1/",
    "wss://169.254.1.1/",
    "wss://100.64.0.1/",
    "wss://0.0.0.0/",
    "wss://198.18.0.1/",
    "wss://192.0.2.1/",
    "wss://198.51.100.1/",
    "wss://203.0.113.1/",
    "wss://224.0.0.1/",
    "wss://255.255.255.255/",
    "wss://127.1/",
    "wss://127.0.1/",
    "wss://2130706433/",
    "wss://0x7f000001/",
    "wss://0177.0.0.1/",
    "wss://%31%32%37.0.0.1/",
  ])("rejects non-public and alternate IPv4 relay %s", (rawUrl) => {
    expect(validateExternalRelayCandidate(candidate(rawUrl))).toMatchObject({
      ok: false,
      reason: "non-public-ip",
    });
  });

  it.each([
    "wss://[::]/",
    "wss://[::1]/",
    "wss://[fe80::1]/",
    "wss://[fc00::1]/",
    "wss://[fd00::1]/",
    "wss://[ff02::1]/",
    "wss://[2001:db8::1]/",
    "wss://[2002::1]/",
    "wss://[::ffff:127.0.0.1]/",
    "wss://[::ffff:c0a8:101]/",
    "wss://[64:ff9b::7f00:1]/",
  ])("rejects non-public IPv6 relay %s", (rawUrl) => {
    expect(validateExternalRelayCandidate(candidate(rawUrl))).toMatchObject({
      ok: false,
      reason: "non-public-ip",
    });
  });

  it.each([
    "wss://localhost/",
    "wss://LOCALHOST./",
    "wss://relay.localhost/",
    "wss://relay.local/",
    "wss://printer/",
    "wss://home.arpa/",
    "wss://relay.home.arpa/",
  ])("rejects local hostname %s", (rawUrl) => {
    expect(validateExternalRelayCandidate(candidate(rawUrl))).toMatchObject({
      ok: false,
      reason: "hostname",
    });
  });

  it.each([
    [undefined, "invalid-type"],
    [null, "invalid-type"],
    [{}, "invalid-type"],
    ["", "too-long"],
    [" wss://relay.example.com/", "too-long"],
    ["wss://relay.example.com/\n", "too-long"],
    ["wss://", "invalid-url"],
    ["wss://[:::1]/", "invalid-url"],
    ["wss://127.0.0.999/", "invalid-url"],
    ["wss://relay.example.com:-1/", "invalid-url"],
    ["wss://relay..example.com/", "hostname"],
    ["wss://-relay.example.com/", "hostname"],
    ["wss://relay_.example.com/", "hostname"],
    ["wss://user:password@relay.example.com/", "userinfo"],
    ["wss://relay.example.com/#", "fragment"],
    ["wss://relay.example.com/#fragment", "fragment"],
  ])("rejects invalid external relay %s", (rawUrl, reason) => {
    expect(validateExternalRelayCandidate(candidate(rawUrl))).toMatchObject({
      ok: false,
      reason,
      origin,
    });
  });

  it("does not include the rejected raw URL in its result", () => {
    const rawUrl = "wss://secret:password@127.0.0.1/private?token=secret";
    const decision = validateExternalRelayCandidate(candidate(rawUrl));
    expect(JSON.stringify(decision)).not.toContain(rawUrl);
    expect(JSON.stringify(decision)).not.toContain("password");
    expect(JSON.stringify(decision)).not.toContain("token");
  });
});

describe("resolveRelayTargets", () => {
  it("keeps configured local relays while rejecting equivalent external hints", () => {
    const configured = [
      "ws://127.0.0.1:8080/",
      "wss://[::1]/",
      "ws://relay.local/",
    ];
    const resolved = resolveRelayTargets(configured, configured.map(candidate));

    expect(resolved.relayUrls).toEqual(configured);
    expect(resolved.accepted).toEqual([]);
    expect(resolved.rejected).toHaveLength(3);
  });

  it("keeps the configured fallback when only some hints are accepted", () => {
    const resolved = resolveRelayTargets(
      ["wss://default.example/"],
      [
        candidate("wss://127.0.0.1/"),
        candidate("wss://relay.example.com/"),
        candidate("not a URL"),
      ],
    );

    expect(resolved.relayUrls).toEqual([
      "wss://default.example/",
      "wss://relay.example.com/",
    ]);
    expect(resolved.accepted).toEqual([
      { url: "wss://relay.example.com/", origin },
    ]);
    expect(resolved.rejected).toHaveLength(2);
  });

  it("deduplicates canonical URLs without losing accepted provenance", () => {
    const resolved = resolveRelayTargets(
      ["wss://relay.example.com/"],
      [
        candidate("wss://relay.example.com"),
        candidate("wss://other.example.com/?b=2&a=1"),
        candidate("wss://other.example.com?a=1&b=2"),
      ],
    );

    expect(resolved.relayUrls).toEqual([
      "wss://relay.example.com/",
      "wss://other.example.com/?a=1&b=2",
    ]);
    expect(resolved.accepted).toHaveLength(3);
    expect(resolved.accepted.every((value) => value.origin === origin)).toBe(true);
  });

  it("limits unique external connections without dropping configured relays", () => {
    const hints = Array.from(
      { length: MAX_EXTERNAL_RELAY_HINTS + 2 },
      (_, index) => candidate(`wss://relay-${index}.example.com/`),
    );
    const resolved = resolveRelayTargets(["wss://default.example/"], hints);

    expect(resolved.relayUrls).toHaveLength(MAX_EXTERNAL_RELAY_HINTS + 1);
    expect(resolved.accepted).toHaveLength(MAX_EXTERNAL_RELAY_HINTS);
    expect(resolved.rejected.filter(({ reason }) => reason === "limit")).toHaveLength(2);
  });
});
