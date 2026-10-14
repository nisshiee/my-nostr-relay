import ipaddr from "ipaddr.js";
import { normalizeURL } from "nostr-tools/utils";

// Extend this union only when another external relay-hint source is implemented.
export type ExternalRelayOrigin = { kind: "nevent" };

export interface ExternalRelayCandidate {
  rawUrl: unknown;
  origin: ExternalRelayOrigin;
}

declare const canonicalRelayUrlBrand: unique symbol;
export type CanonicalRelayUrl = string & {
  readonly [canonicalRelayUrlBrand]: true;
};

export type RelayRejectReason =
  | "invalid-type"
  | "too-long"
  | "invalid-url"
  | "scheme"
  | "userinfo"
  | "fragment"
  | "hostname"
  | "non-public-ip"
  | "limit";

export type ExternalRelayDecision =
  | {
      ok: true;
      value: {
        url: CanonicalRelayUrl;
        origin: ExternalRelayOrigin;
      };
    }
  | {
      ok: false;
      reason: RelayRejectReason;
      origin: ExternalRelayOrigin;
    };

export interface ResolvedRelayTargets {
  relayUrls: string[];
  accepted: Array<Extract<ExternalRelayDecision, { ok: true }>["value"]>;
  rejected: Array<Extract<ExternalRelayDecision, { ok: false }>>;
}

export const MAX_EXTERNAL_RELAY_HINTS = 8;
const MAX_RELAY_URL_LENGTH = 2048;

// IANA Special-Purpose Address Registries. Globally reachable exceptions take
// precedence over the containing special-purpose range.
const nonPublicIpv4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
].map((cidr) => ipaddr.IPv4.parseCIDR(cidr));

const publicIpv4Exceptions = ["192.0.0.9/32", "192.0.0.10/32"].map(
  (cidr) => ipaddr.IPv4.parseCIDR(cidr),
);

const nonPublicIpv6 = [
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "2d00::/8",
  "2e00::/7",
  "3000::/4",
].map((cidr) => ipaddr.IPv6.parseCIDR(cidr));

const publicIpv6Exceptions = [
  "2001:1::1/128",
  "2001:1::2/128",
  "2001:1::3/128",
  "2001:3::/32",
  "2001:4:112::/48",
  "2001:20::/28",
  "2001:30::/28",
].map((cidr) => ipaddr.IPv6.parseCIDR(cidr));

const globalIpv6 = ipaddr.IPv6.parseCIDR("2000::/3");
const translatedIpv6 = ipaddr.IPv6.parseCIDR("64:ff9b::/96");

function isPublicIpv4(address: ipaddr.IPv4): boolean {
  return (
    publicIpv4Exceptions.some((cidr) => address.match(cidr)) ||
    !nonPublicIpv4.some((cidr) => address.match(cidr))
  );
}

function isBlockedLocalHostname(hostname: string): boolean {
  const labels = hostname.split(".");
  if (labels.length < 2) return true;

  return ["localhost", "local", "home.arpa"].some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
}

function isValidDnsHostname(hostname: string): boolean {
  if (hostname.length > 253) return false;
  return hostname.split(".").every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
  );
}

function isPublicHostname(hostname: string): boolean {
  const host = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

  if (ipaddr.isValid(host)) {
    const address = ipaddr.parse(host);
    if (address instanceof ipaddr.IPv4) {
      return isPublicIpv4(address);
    }
    if (address.isIPv4MappedAddress()) {
      return isPublicIpv4(address.toIPv4Address());
    }
    if (address.match(translatedIpv6)) {
      return isPublicIpv4(new ipaddr.IPv4(address.toByteArray().slice(-4)));
    }
    return (
      publicIpv6Exceptions.some((cidr) => address.match(cidr)) ||
      (address.match(globalIpv6) &&
        !nonPublicIpv6.some((cidr) => address.match(cidr)))
    );
  }

  return isValidDnsHostname(host) && !isBlockedLocalHostname(host);
}

function reject(
  candidate: ExternalRelayCandidate,
  reason: RelayRejectReason,
): ExternalRelayDecision {
  return { ok: false, reason, origin: candidate.origin };
}

/** Validate a relay URL that arrived without an explicit user choice. */
export function validateExternalRelayCandidate(
  candidate: ExternalRelayCandidate,
): ExternalRelayDecision {
  if (typeof candidate.rawUrl !== "string") {
    return reject(candidate, "invalid-type");
  }

  const rawUrl = candidate.rawUrl;
  if (
    rawUrl.length === 0 ||
    rawUrl.length > MAX_RELAY_URL_LENGTH ||
    rawUrl.trim() !== rawUrl
  ) {
    return reject(candidate, "too-long");
  }
  if (/\p{Cc}/u.test(rawUrl)) {
    return reject(candidate, "invalid-url");
  }
  // URL.hash is empty for a trailing '#', so inspect the raw value as well.
  if (rawUrl.includes("#")) {
    return reject(candidate, "fragment");
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return reject(candidate, "invalid-url");
  }

  // Do not let normalizeURL promote http(s) or a scheme-less hint to wss.
  if (url.protocol !== "wss:") {
    return reject(candidate, "scheme");
  }
  if (url.username || url.password) {
    return reject(candidate, "userinfo");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (!hostname) {
    return reject(candidate, "hostname");
  }
  if (!isPublicHostname(hostname)) {
    return reject(
      candidate,
      ipaddr.isValid(hostname.replace(/^\[|\]$/g, ""))
        ? "non-public-ip"
        : "hostname",
    );
  }

  try {
    return {
      ok: true,
      value: {
        url: normalizeURL(rawUrl) as CanonicalRelayUrl,
        origin: candidate.origin,
      },
    };
  } catch {
    return reject(candidate, "invalid-url");
  }
}

/**
 * Merge configured relays with individually validated external candidates.
 * Configured relays are deliberately not subjected to the public-host policy.
 */
export function resolveRelayTargets(
  configuredRelays: readonly string[],
  candidates: readonly ExternalRelayCandidate[] = [],
  maxAccepted = MAX_EXTERNAL_RELAY_HINTS,
): ResolvedRelayTargets {
  const relayUrls = [...configuredRelays];
  const accepted: ResolvedRelayTargets["accepted"] = [];
  const rejected: ResolvedRelayTargets["rejected"] = [];
  const seen = new Set<string>();

  for (const relayUrl of configuredRelays) {
    try {
      seen.add(normalizeURL(relayUrl));
    } catch {
      // Keep configured relay behavior unchanged; SimplePool remains authoritative.
    }
  }

  let acceptedConnections = 0;
  for (const candidate of candidates) {
    const decision = validateExternalRelayCandidate(candidate);
    if (!decision.ok) {
      rejected.push(decision);
      continue;
    }

    if (seen.has(decision.value.url)) {
      accepted.push(decision.value);
      continue;
    }
    if (acceptedConnections >= maxAccepted) {
      rejected.push({
        ok: false,
        reason: "limit",
        origin: candidate.origin,
      });
      continue;
    }

    accepted.push(decision.value);
    seen.add(decision.value.url);
    relayUrls.push(decision.value.url);
    acceptedConnections += 1;
  }

  return { relayUrls, accepted, rejected };
}
