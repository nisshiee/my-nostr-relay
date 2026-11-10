import { hasAllowedPublicImageQuery } from "./publicImageQuery";
import { Resolver } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import sharp from "sharp";

// 公開時には別途、共有レート制限と同時実行数制限が必要。
export const PUBLIC_IMAGE_WIDTHS = [32, 64, 128, 640, 1280] as const;
export type PublicImageWidth = (typeof PUBLIC_IMAGE_WIDTHS)[number];
const MAX_INPUT = 5 * 1024 * 1024;
const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
const DEADLINE_MS = 10_000;

export class PublicImageDeadlineError extends Error {
  constructor(message: string, readonly nativeWorkMayRemain: boolean = true) {
    super(message);
  }
}

function reject(reason: string): never {
  throw new Error(`Public image rejected: ${reason}`);
}

export function validatePublicImageUrl(raw: string): URL {
  if (raw.length > 2048 || /[\s\\]/.test(raw)) reject("URL");
  const url = new URL(raw);
  if (url.protocol !== "https:" || (url.port && url.port !== "443")) reject("HTTPS 443 required");
  if (url.username || url.password || (raw.includes("?") && !url.search) || !hasAllowedPublicImageQuery(url) || raw.includes("#")) reject("URL credentials/query/fragment");
  if (isIP(url.hostname.replace(/^\[|\]$/g, ""))) reject("IP literal");
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host.endsWith(".") || !/^[a-z0-9.-]+$/.test(host) ||
      ["localhost", "local", "internal", "home.arpa"].some(s => host === s || host.endsWith(`.${s}`))) reject("hostname");
  return url;
}

export function isPublicImageAddress(address: string): boolean {
  if (!isIP(address)) return false;
  const parsed = ipaddr.parse(address);
  if (parsed.kind() === "ipv6") {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress() || !v6.match(ipaddr.IPv6.parseCIDR("2000::/3"))) return false;
  }
  return parsed.range() === "unicast";
}

async function resolvePublic(host: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const resolver = new Resolver();
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const resolve = async (family: 4 | 6) => {
      try {
        const values = await (family === 4 ? resolver.resolve4(host) : resolver.resolve6(host));
        return values.map(address => ({ address, family }));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENODATA" || code === "ENOTFOUND") return [];
        throw error;
      }
    };
    const addresses = (await Promise.all([resolve(4), resolve(6)])).flat();
    signal.throwIfAborted();
    if (!addresses.length || addresses.some(a => !isPublicImageAddress(a.address))) reject("DNS address");
    return addresses[0];
  } finally {
    signal.removeEventListener("abort", cancel);
    resolver.cancel();
  }
}

type Response = { redirect: string } | { body: Buffer; mime: string };
async function download(url: URL, signal: AbortSignal): Promise<Response> {
  const target = await resolvePublic(url.hostname, signal);
  signal.throwIfAborted();
  return new Promise((resolve, rejectPromise) => {
    const req = request(url, {
      agent: false,
      signal,
      servername: url.hostname,
      family: target.family,
      // DNS 再問い合わせを避け、検査済みアドレスだけに接続する。TLS/Host は元のホスト名。
      lookup: (_host, _options, callback) => callback(null, target.address, target.family),
      headers: { Accept: "image/jpeg,image/png,image/webp,image/avif", "Accept-Encoding": "identity" },
    }, res => {
      const fail = (reason: string) => {
        res.destroy();
        rejectPromise(new Error(`Public image rejected: ${reason}`));
      };
      res.on("error", rejectPromise);
      if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
        const location = res.headers.location;
        res.destroy();
        if (!location) return fail("redirect location");
        resolve({ redirect: location });
        return;
      }
      if (res.statusCode !== 200) return fail("status");
      if (res.headers["content-encoding"] && res.headers["content-encoding"].toLowerCase() !== "identity") return fail("encoding");
      const mime = (res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (!["image/jpeg", "image/png", "image/webp", "image/avif", "application/octet-stream"].includes(mime)) {
        // 診断には固定カテゴリのみを使い、上流ヘッダの任意文字列を露出させない。
        const category: Record<string, string> = {
          "image/jpg": "image-jpg",
          "application/octet-stream": "octet-stream",
          "image/avif": "avif",
          "image/gif": "gif",
          "text/html": "text-html",
          "image/svg+xml": "svg",
        };
        return fail(`MIME ${Object.hasOwn(category, mime) ? category[mime] : "other"}`);
      }
      const length = res.headers["content-length"];
      if (length && (!/^\d+$/.test(length) || Number(length) > MAX_INPUT)) return fail("length");
      let size = 0;
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_INPUT) return fail("input size");
        chunks.push(chunk);
      });
      res.on("aborted", () => rejectPromise(new Error("Public image response aborted")));
      res.on("end", () => resolve({ body: Buffer.concat(chunks), mime }));
    });
    req.on("error", rejectPromise);
    req.end();
  });
}

function rejectAnimation(body: Buffer, mime: string): void {
  if (mime === "image/png") {
    let offset = 8;
    while (offset + 12 <= body.length) {
      const size = body.readUInt32BE(offset);
      if (size > body.length - offset - 12) reject("PNG chunk");
      const kind = body.toString("ascii", offset + 4, offset + 8);
      if (["acTL", "fcTL", "fdAT"].includes(kind)) reject("animation");
      offset += size + 12;
      if (kind === "IEND") break;
    }
  } else if (mime === "image/webp") {
    let offset = 12;
    while (offset + 8 <= body.length) {
      const size = body.readUInt32LE(offset + 4);
      if (size > body.length - offset - 8) reject("WebP chunk");
      const kind = body.toString("ascii", offset, offset + 4);
      if (["ANIM", "ANMF"].includes(kind) || (kind === "VP8X" && size > 0 && (body[offset + 8] & 2))) reject("animation");
      offset += 8 + size + (size % 2);
    }
  }
}

function isStaticAvif(body: Buffer): boolean {
  // ftyp は先頭の通常サイズ箱のみ許可し、未知の互換ブランドや動画トラックを拒否する。
  if (body.length < 24 || body.toString("ascii", 4, 8) !== "ftyp") return false;
  const size = body.readUInt32BE(0);
  if (size < 24 || size > body.length || size % 4 !== 0) return false;
  const brands = [body.toString("ascii", 8, 12)];
  for (let offset = 16; offset < size; offset += 4) brands.push(body.toString("ascii", offset, offset + 4));
  if (!brands.includes("avif") || brands.some(brand => !["avif", "mif1", "miaf", "MA1A", "MA1B"].includes(brand))) return false;
  let offset = size;
  while (offset < body.length) {
    if (body.length - offset < 8) return false;
    const boxSize = body.readUInt32BE(offset);
    const kind = body.toString("ascii", offset + 4, offset + 8);
    if (boxSize < 8 || boxSize > body.length - offset || kind === "moov" || kind === "ftyp") return false;
    offset += boxSize;
  }
  return true;
}

function magicMime(body: Buffer): string | undefined {
  if (isStaticAvif(body)) return "image/avif";
  if (body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (body.length >= 12 && body.toString("ascii", 0, 4) === "RIFF" && body.toString("ascii", 8, 12) === "WEBP") return "image/webp";
}

async function decode(body: Buffer, mime: string, width: PublicImageWidth, signal: AbortSignal, end: number, onNativeStart: () => void): Promise<Buffer> {
  signal.throwIfAborted();
  const detectedMime = magicMime(body);
  if (mime === "application/octet-stream" && detectedMime && detectedMime !== "image/avif") mime = detectedMime;
  if (!detectedMime || detectedMime !== mime) reject("magic bytes");
  rejectAnimation(body, mime);
  onNativeStart();
  const image = sharp(body, { limitInputPixels: MAX_PIXELS, failOn: "warning", animated: false });
  const destroy = () => { image.destroy(); };
  signal.addEventListener("abort", destroy, { once: true });
  try {
    const metadata = await image.metadata();
    signal.throwIfAborted();
    if (mime === "image/avif" && (metadata.format !== "heif" || metadata.compression !== "av1" || metadata.pages !== 1)) reject("AVIF format");
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_PIXELS || (metadata.pages ?? 1) !== 1) reject("pixels/frames");
    // libvips の協調的タイムアウトであり、ネイティブ処理の強制停止を保証しない。
    image.timeout({ seconds: Math.max(1, Math.ceil((end - Date.now()) / 1000)) });
    image.rotate().resize({ width, height: width, fit: "inside", withoutEnlargement: true }).webp({ quality: 75 });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of image) {
      signal.throwIfAborted();
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_OUTPUT) reject("output size");
      chunks.push(buffer);
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener("abort", destroy);
    image.destroy();
  }
}

export async function fetchPublicImage(rawUrl: string, width: PublicImageWidth): Promise<Buffer> {
  if (!(PUBLIC_IMAGE_WIDTHS as readonly number[]).includes(width)) reject("width");
  let url = validatePublicImageUrl(rawUrl);
  const controller = new AbortController();
  const end = Date.now() + DEADLINE_MS;
  let nativeWorkMayRemain = false;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, rejectPromise) => {
    timer = setTimeout(() => {
      controller.abort(new PublicImageDeadlineError("Public image deadline exceeded", nativeWorkMayRemain));
      rejectPromise(controller.signal.reason);
    }, DEADLINE_MS);
  });
  const operation = async () => {
    for (let redirects = 0; ; redirects++) {
      const response = await download(url, controller.signal);
      if ("redirect" in response) {
        if (redirects >= 2) reject("redirect limit");
        url = validatePublicImageUrl(new URL(response.redirect, url).href);
      } else {
        try {
          return await decode(response.body, response.mime, width, controller.signal, end, () => {
            nativeWorkMayRemain = true;
          });
        } finally {
          nativeWorkMayRemain = false;
        }
      }
    }
  };
  try {
    return await Promise.race([operation(), deadline]);
  } catch (error) {
    // abort による副次的エラーが先行しても、呼び出し側には期限超過を明示する。
    if (controller.signal.reason instanceof PublicImageDeadlineError) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer!);
    controller.abort();
  }
}

export async function fetchInlineImage(dataUri: string, width: PublicImageWidth): Promise<Buffer> {
  if (!(PUBLIC_IMAGE_WIDTHS as readonly number[]).includes(width)) reject("width");
  const maxInlineInput = 2 * 1024 * 1024;
  // 巨大入力を先に拒否し、デコード後サイズを計算してから Buffer を確保する。
  if (typeof dataUri !== "string" || dataUri.length > Math.ceil(maxInlineInput / 3) * 4 + 32) reject("inline size");
  const comma = dataUri.indexOf(",");
  const header = dataUri.slice(0, comma);
  const match = /^data:(image\/(?:jpeg|png|webp|avif));base64$/.exec(header);
  if (!match) reject("inline format");
  const encoded = dataUri.slice(comma + 1);
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const content = encoded.slice(0, encoded.length - padding);
  if (!encoded.length || encoded.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(content)) reject("inline base64");
  const size = encoded.length / 4 * 3 - padding;
  if (size > maxInlineInput) reject("inline size");
  const body = Buffer.from(encoded, "base64");
  if (body.length !== size || body.toString("base64") !== encoded) reject("inline base64");
  const controller = new AbortController();
  const end = Date.now() + DEADLINE_MS;
  let nativeWorkMayRemain = false;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, rejectPromise) => {
    timer = setTimeout(() => {
      controller.abort(new PublicImageDeadlineError("Public image deadline exceeded", nativeWorkMayRemain));
      rejectPromise(controller.signal.reason);
    }, DEADLINE_MS);
  });
  try {
    return await Promise.race([
      decode(body, match[1], width, controller.signal, end, () => { nativeWorkMayRemain = true; }),
      deadline,
    ]);
  } catch (error) {
    if (controller.signal.reason instanceof PublicImageDeadlineError) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer!);
    controller.abort();
  }
}
