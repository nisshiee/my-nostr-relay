import { isCanvasImageProxyEnabled as enabled, canvasImageAccessStatus } from "../../lib/canvasImageDeployment";
import { createHash } from "node:crypto";
import { normalizeCanvasInlineImage } from "../../lib/canvasInlineImage";
import { fetchInlineImage, fetchPublicImage, PublicImageDeadlineError, type PublicImageWidth } from "../../lib/publicImageFetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WIDTHS = new Set([32, 64, 128, 640, 1280]);
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 64;
const TTL_MS = 5 * 60 * 1000;
const STATE_KEY = Symbol.for("nlc.canvas-image.state.v1");
type Entry = { bytes: Buffer; expires: number };
type State = {
  cache: Map<string, Entry>;
  bytes: number;
  inflight: Map<string, Promise<Buffer>>;
  active: number;
  bodyReads: number;
  bodyTokens: number;
  bodyRefillAt: number;
  tokens: number;
  refillAt: number;
};
const processState = globalThis as typeof globalThis & { [STATE_KEY]?: State };
function state(): State {
  return processState[STATE_KEY] ??= {
    cache: new Map(), bytes: 0, inflight: new Map(), active: 0, bodyReads: 0,
    tokens: 60, refillAt: Date.now(), bodyTokens: 10, bodyRefillAt: Date.now(),
  };
}



const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
};
function failure(status: number): Response {
  return new Response(`Image unavailable (${status})`, {
    status, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8", ...(status === 429 ? { "Retry-After": "1" } : {}) },
  });
}
function image(bytes: Buffer): Response {
  return new Response(new Uint8Array(bytes), {
    headers: { ...headers, "Content-Type": "image/webp" },
  });
}
function remove(s: State, key: string): void {
  const entry = s.cache.get(key);
  if (entry) s.bytes -= entry.bytes.length;
  s.cache.delete(key);
}
function store(s: State, key: string, bytes: Buffer): void {
  if (bytes.length > MAX_BYTES) return;
  remove(s, key);
  while (s.cache.size >= MAX_ENTRIES || s.bytes + bytes.length > MAX_BYTES) {
    const oldest = s.cache.keys().next().value;
    if (oldest === undefined) break;
    remove(s, oldest);
  }
  s.cache.set(key, { bytes, expires: Date.now() + TTL_MS });
  s.bytes += bytes.length;
}

let reportedDisabled = false;

export async function GET(request: Request): Promise<Response> {
  // 認証は本文/cache/DNSより先。署名やcookieの値をログへ出さない。
  const access = canvasImageAccessStatus(request);
  if (access !== 200) return failure(access);
  // キャッシュ参照より先に判定し、無効時はDNS・外部通信を一切開始しない。
  if (!enabled()) {
    if (!reportedDisabled) console.warn("canvas-image: disabled", { flag: process.env.CANVAS_IMAGE_PROXY_ENABLED === "1", scope: process.env.CANVAS_IMAGE_PROXY_SCOPE === "protected-preview", platformPresent: Boolean(process.env.VERCEL_ENV || process.env.VERCEL_TARGET_ENV) });
    reportedDisabled = true;
    return failure(503);
  }
  reportedDisabled = false;
  let params: URLSearchParams;
  try { params = new URL(request.url).searchParams; } catch { return failure(400); }
  if ([...params.keys()].some((key) => !["url", "w", "q"].includes(key)) ||
      ["url", "w", "q"].some((key) => params.getAll(key).length > 1)) return failure(400);
  const url = params.get("url");
  const widthText = params.get("w") ?? "";
  const width = Number(widthText);
  if (!url || url.length > 2048 || !WIDTHS.has(width) || String(width) !== widthText ||
      (params.has("q") && params.get("q") !== "75")) return failure(400);
  return serve(request, JSON.stringify([url, width]), () => fetchPublicImage(url, width as PublicImageWidth));
}

export async function POST(request: Request): Promise<Response> {
  const access = canvasImageAccessStatus(request);
  if (access !== 200) return failure(access);
  // 無効時は本文すら読み込まず、デコードも開始しない。
  if (!enabled()) return failure(503);
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin) return failure(403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return failure(415);
  const maxBody = 3 * 1024 * 1024;
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBody)) return failure(413);
  if (!request.body) return failure(400);
  const s = state();
  // JSON読み込みにも同時数・サイズ・時間上限を設ける。
  const now = Date.now();
  s.bodyTokens = Math.min(10, s.bodyTokens + Math.max(0, now - s.bodyRefillAt) / 1000);
  s.bodyRefillAt = now;
  // 不正JSONでも消費する独立した本文予算: バースト10件、毎秒1件補充。
  if (s.bodyReads >= 2 || s.bodyTokens < 1) return failure(429);
  s.bodyTokens -= 1;
  s.bodyReads += 1;
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let body: unknown;
  try {
    const read = async () => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > maxBody) throw new RangeError();
        chunks.push(result.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    };
    body = await Promise.race([read(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("body deadline")), 5000);
    })]);
  } catch (error) {
    return failure(error instanceof RangeError ? 413 : 400);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    s.bodyReads -= 1;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return failure(400);
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || typeof record.data !== "string" ||
      typeof record.width !== "number" || !WIDTHS.has(record.width) ||
      !record.data.startsWith("data:")) return failure(400);
  if (!enabled()) return failure(503);
  const data = normalizeCanvasInlineImage(record.data);
  if (data === null) return failure(400);
  const width = record.width as PublicImageWidth;
  const key = `inline:${width}:${createHash("sha256").update(data).digest("hex")}`;
  return serve(request, key, () => fetchInlineImage(data, width));
}

async function serve(request: Request, key: string, fetchImage: () => Promise<Buffer>): Promise<Response> {
  const access = canvasImageAccessStatus(request);
  if (access !== 200) return failure(access);
  const s = state();
  const now = Date.now();
  for (const [oldKey, entry] of s.cache) if (entry.expires <= now) remove(s, oldKey);
  const cached = s.cache.get(key);
  if (cached) {
    s.cache.delete(key);
    s.cache.set(key, cached);
    const access = canvasImageAccessStatus(request);
    return access === 200 ? image(cached.bytes) : failure(access);
  }
  let job = s.inflight.get(key);
  if (!job) {
    // 同一プロセス内のみ: 同時2件、バースト60件、毎分240ミス。
    // 分散環境全体の費用・濫用対策ではないため、本番の公開許可には使用しない。
    s.tokens = Math.min(60, s.tokens + Math.max(0, now - s.refillAt) / 250);
    s.refillAt = now;
    if (s.active >= 2 || s.tokens < 1) {
      console.warn("canvas-image: rate-limited", s.active >= 2 ? "concurrency" : "tokens");
      return failure(429);
    }
    s.tokens -= 1;
    s.active += 1;
    job = Promise.resolve().then(fetchImage).then((bytes) => {
      store(s, key, bytes);
      s.active -= 1;
      return bytes;
    }).catch((error: unknown) => {
      // ネイティブ処理中の締切だけは終了を証明できず、再起動まで枠を保持する。
      if (!(error instanceof PublicImageDeadlineError) || !error.nativeWorkMayRemain) s.active -= 1;
      throw error;
    }).finally(() => {
      s.inflight.delete(key);
    });
    s.inflight.set(key, job);
  }
  try {
    const bytes = await job;
    // 処理中に無効化された場合も画像を返さない。
    const access = canvasImageAccessStatus(request);
    return access === 200 ? image(bytes) : failure(access);
  } catch (error) {
    // URL・上流messageは出さず、自前の固定reasonだけを診断に残す。
    const message = error instanceof Error ? error.message : "";
    const reasons = ["URL", "HTTPS 443 required", "URL credentials/query/fragment", "IP literal", "hostname", "DNS address", "redirect location", "status", "encoding", "MIME", "MIME image-jpg", "MIME octet-stream", "MIME avif", "MIME gif", "MIME text-html", "MIME svg", "MIME other", "length", "input size", "magic bytes", "pixels/frames", "output size", "redirect limit", "animation", "width"];
    const reason = reasons.find(value => message === `Public image rejected: ${value}`);
    console.warn("canvas-image: failed", error instanceof PublicImageDeadlineError ? "deadline" : reason ?? "network-or-decode");
    return failure(502);
  }
}
