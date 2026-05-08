import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 3000;
const MAX_HTML_BYTES = 1024 * 1024;
const ALLOWED_CONTENT_TYPES = ["text/html", "application/xhtml+xml"];

type LookupResult = { address: string; family: number };
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupResult[],
  family?: number,
) => void;

interface LinkPreviewData {
  url: string;
  domain: string;
  title: string;
  description?: string;
  image?: string;
  siteName?: string;
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function parseIPv4Bytes(address: string): number[] | null {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts;
}

function parseIPv6Bytes(address: string): number[] | null {
  const withoutZone = normalizeHostname(address).split("%")[0];
  const ipv4Match = withoutZone.match(/(\d+\.\d+\.\d+\.\d+)$/);
  const ipv4Bytes = ipv4Match ? parseIPv4Bytes(ipv4Match[1]) : null;
  if (ipv4Match && !ipv4Bytes) return null;

  const normalized = ipv4Bytes
    ? withoutZone.replace(
        ipv4Match![1],
        `${((ipv4Bytes[0] << 8) | ipv4Bytes[1]).toString(16)}:${((ipv4Bytes[2] << 8) | ipv4Bytes[3]).toString(16)}`,
      )
    : withoutZone;
  const halves = normalized.split("::");
  if (halves.length > 2) return null;

  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array(Math.max(fill, 0)).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) {
    return null;
  }

  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

function isPrivateIPv6(address: string): boolean {
  const bytes = parseIPv6Bytes(address);
  if (!bytes) return true;

  const isUnspecified = bytes.every((byte) => byte === 0);
  const isLoopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  const isIPv4Mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const isIPv4Compatible = bytes.slice(0, 12).every((byte) => byte === 0) && bytes.slice(12).some((byte) => byte !== 0);
  const mappedIPv4 = isIPv4Mapped || isIPv4Compatible ? bytes.slice(12).join(".") : null;

  return (
    isUnspecified ||
    isLoopback ||
    ((bytes[0] & 0xfe) === 0xfc) ||
    (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) ||
    bytes[0] === 0xff ||
    (mappedIPv4 ? isPrivateIPv4(mappedIPv4) : false)
  );
}

function isBlockedAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const family = net.isIP(normalized);
  if (family === 4) return isPrivateIPv4(normalized);
  if (family === 6) return isPrivateIPv6(normalized);
  return true;
}

async function resolvePublicAddresses(hostname: string): Promise<{ address: string; family: number }[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: false });
  if (addresses.length === 0 || addresses.some((entry) => isBlockedAddress(entry.address))) {
    throw new Error("blocked_resolved_ip");
  }
  return addresses;
}

async function validateUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("unsupported_protocol");
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("blocked_hostname");
  }

  if (net.isIP(hostname) && isBlockedAddress(hostname)) {
    throw new Error("blocked_ip");
  }

  if (!net.isIP(hostname)) {
    await resolvePublicAddresses(hostname);
  }
}

function publicLookup(hostname: string, options: { all?: boolean } | undefined, callback: LookupCallback): void {
  void resolvePublicAddresses(hostname)
    .then((entries) => {
      if (options?.all) {
        callback(null, entries);
        return;
      }

      const [entry] = entries;
      callback(null, entry.address, entry.family);
    })
    .catch((error: NodeJS.ErrnoException) => callback(error, "", 0));
}

async function fetchWithPublicLookup(url: URL, signal: AbortSignal): Promise<http.IncomingMessage> {
  const client = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      {
        method: "GET",
        lookup: publicLookup,
        signal,
        headers: {
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
          "accept-encoding": "identity",
          "user-agent": "my-nostr-relay-link-preview/1.0",
        },
      },
      resolve,
    );

    request.on("error", reject);
    request.end();
  });
}

function isAllowedContentType(value: string | undefined): boolean {
  const mime = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return ALLOWED_CONTENT_TYPES.includes(mime);
}

function charsetFromContentType(value: string | undefined): string | undefined {
  const match = value?.match(/(?:^|;)\s*charset\s*=\s*["']?([^;"']+)/i);
  return match?.[1]?.trim().toLowerCase();
}

function charsetFromMeta(buffer: Buffer): string | undefined {
  const head = buffer.toString("latin1", 0, Math.min(buffer.byteLength, 4096));
  const match = head.match(/<meta\b[^>]+charset\s*=\s*["']?([^\s"'>;]+)/i);
  return match?.[1]?.trim().toLowerCase();
}

function normalizeCharset(charset: string | undefined): string {
  if (!charset) return "utf-8";
  if (charset === "shift_jis" || charset === "shift-jis" || charset === "x-sjis" || charset === "sjis") {
    return "shift_jis";
  }
  return charset;
}

function decodeHtml(buffer: Buffer, contentType: string | undefined): string {
  const charset = normalizeCharset(charsetFromContentType(contentType) ?? charsetFromMeta(buffer));
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  }
}

async function fetchHtml(inputUrl: URL): Promise<{ html: string; finalUrl: URL }> {
  let currentUrl = inputUrl;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    await validateUrl(currentUrl);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetchWithPublicLookup(currentUrl, controller.signal);

      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        response.resume();
        const location = response.headers.location;
        if (!location) throw new Error("redirect_without_location");
        if (redirectCount === MAX_REDIRECTS) throw new Error("too_many_redirects");
        currentUrl = new URL(Array.isArray(location) ? location[0] : location, currentUrl);
        continue;
      }

      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        throw new Error("fetch_failed");
      }

      const contentType = Array.isArray(response.headers["content-type"])
        ? response.headers["content-type"][0]
        : response.headers["content-type"];
      if (!isAllowedContentType(contentType)) {
        response.resume();
        throw new Error("unsupported_content_type");
      }

      const chunks: Uint8Array[] = [];
      let received = 0;

      for await (const chunk of response) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buffer.byteLength;
        if (received > MAX_HTML_BYTES) {
          response.destroy();
          throw new Error("html_too_large");
        }
        chunks.push(buffer);

        const currentBuffer = Buffer.concat(chunks);
        if (/<\/head\s*>/i.test(currentBuffer.toString("latin1"))) {
          response.destroy();
          return { html: decodeHtml(currentBuffer, contentType), finalUrl: currentUrl };
        }
      }

      const htmlBuffer = Buffer.concat(chunks);
      return { html: decodeHtml(htmlBuffer, contentType), finalUrl: currentUrl };
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("too_many_redirects");
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };

  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    }
    if (lower.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    }
    return named[lower] ?? entity;
  });
}

function normalizeText(value?: string): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized ? decodeHtmlEntities(normalized) : undefined;
}

function getAttribute(tag: string, name: string): string | undefined {
  const pattern = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = tag.match(pattern);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function findMetaContent(html: string, names: string[]): string | undefined {
  const metaPattern = /<meta\b[^>]*>/gi;
  for (const tag of html.match(metaPattern) ?? []) {
    const property = getAttribute(tag, "property")?.toLowerCase();
    const name = getAttribute(tag, "name")?.toLowerCase();
    if (property && names.includes(property)) return normalizeText(getAttribute(tag, "content"));
    if (name && names.includes(name)) return normalizeText(getAttribute(tag, "content"));
  }
  return undefined;
}

function findTitle(html: string): string | undefined {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return normalizeText(match?.[1]);
}

async function safeImageUrl(rawImage: string | undefined, finalUrl: URL): Promise<string | undefined> {
  if (!rawImage) return undefined;

  try {
    const imageUrl = new URL(rawImage, finalUrl);
    await validateUrl(imageUrl);
    return imageUrl.toString();
  } catch {
    return undefined;
  }
}

async function extractPreview(html: string, finalUrl: URL): Promise<LinkPreviewData | null> {
  const title =
    findMetaContent(html, ["og:title"]) ??
    findMetaContent(html, ["twitter:title"]) ??
    findTitle(html);

  if (!title) return null;

  const description =
    findMetaContent(html, ["og:description"]) ??
    findMetaContent(html, ["twitter:description"]) ??
    findMetaContent(html, ["description"]);
  const rawImage = findMetaContent(html, ["og:image", "og:image:url", "twitter:image", "twitter:image:src"]);
  const siteName = findMetaContent(html, ["og:site_name"]);
  const image = await safeImageUrl(rawImage, finalUrl);

  return {
    url: finalUrl.toString(),
    domain: finalUrl.hostname.replace(/^www\./, ""),
    title,
    ...(description ? { description } : {}),
    ...(image ? { image } : {}),
    ...(siteName ? { siteName } : {}),
  };
}

export async function GET(request: Request) {
  const rawUrl = new URL(request.url).searchParams.get("url");
  if (!rawUrl || rawUrl.length > 2048) {
    return NextResponse.json({ error: "invalid_url" }, { status: 400 });
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(rawUrl);
  } catch {
    return NextResponse.json({ error: "invalid_url" }, { status: 400 });
  }

  try {
    const { html, finalUrl } = await fetchHtml(targetUrl);
    const preview = await extractPreview(html, finalUrl);
    if (!preview) {
      return NextResponse.json({ error: "no_preview" }, { status: 404 });
    }

    return NextResponse.json(preview, {
      headers: {
        "Cache-Control": "s-maxage=86400, stale-while-revalidate=604800",
      },
    });
  } catch {
    return NextResponse.json({ error: "preview_failed" }, { status: 502 });
  }
}
