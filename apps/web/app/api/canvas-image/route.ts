import { fetchPublicImage, PublicImageDeadlineError, type PublicImageWidth } from "../../lib/publicImageFetch";

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
  tokens: number;
  refillAt: number;
};
const processState = globalThis as typeof globalThis & { [STATE_KEY]?: State };
function state(): State {
  return processState[STATE_KEY] ??= {
    cache: new Map(), bytes: 0, inflight: new Map(), active: 0,
    tokens: 10, refillAt: Date.now(),
  };
}

function enabled(): boolean {
  if (process.env.CANVAS_IMAGE_PROXY_ENABLED !== "1") return false;
  // 本番は必ず無効。明示したプレビューと開発・テスト環境だけを許可する。
  if (process.env.VERCEL_ENV) {
    return process.env.VERCEL_ENV === "preview" || process.env.VERCEL_ENV === "development";
  }
  return process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
}

const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
};
function failure(status: number): Response {
  return new Response(`Image unavailable (${status})`, {
    status, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
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
  // キャッシュ参照より先に判定し、無効時はDNS・外部通信を一切開始しない。
  if (!enabled()) {
    if (!reportedDisabled) console.warn("canvas-image: disabled", { flag: process.env.CANVAS_IMAGE_PROXY_ENABLED === "1", preview: process.env.VERCEL_ENV === "preview" });
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
  const key = JSON.stringify([url, width]);
  const s = state();
  const now = Date.now();
  for (const [oldKey, entry] of s.cache) if (entry.expires <= now) remove(s, oldKey);
  const cached = s.cache.get(key);
  if (cached) {
    s.cache.delete(key);
    s.cache.set(key, cached);
    return image(cached.bytes);
  }
  let job = s.inflight.get(key);
  if (!job) {
    // 同一プロセス内のみ: 同時2件、バースト10件、毎分60ミス。
    // 分散環境全体の費用・濫用対策ではないため、本番の公開許可には使用しない。
    s.tokens = Math.min(10, s.tokens + Math.max(0, now - s.refillAt) / 1000);
    s.refillAt = now;
    if (s.active >= 2 || s.tokens < 1) return failure(429);
    s.tokens -= 1;
    s.active += 1;
    job = Promise.resolve().then(() => fetchPublicImage(url, width as PublicImageWidth)).then((bytes) => {
      store(s, key, bytes);
      s.active -= 1;
      return bytes;
    }).catch((error: unknown) => {
      // 締切時だけはネイティブ処理終了を証明できず、再起動まで枠を保持する。
      if (!(error instanceof PublicImageDeadlineError)) s.active -= 1;
      throw error;
    }).finally(() => {
      s.inflight.delete(key);
    });
    s.inflight.set(key, job);
  }
  try {
    const bytes = await job;
    // 処理中に無効化された場合も画像を返さない。
    return enabled() ? image(bytes) : failure(503);
  } catch (error) {
    // URL・上流messageは出さず、自前の固定reasonだけを診断に残す。
    const message = error instanceof Error ? error.message : "";
    const reasons = ["URL", "HTTPS 443 required", "URL credentials/query/fragment", "IP literal", "hostname", "DNS address", "redirect location", "status", "encoding", "MIME", "length", "input size", "magic bytes", "pixels/frames", "output size", "redirect limit", "animation", "width"];
    const reason = reasons.find(value => message === `Public image rejected: ${value}`);
    console.warn("canvas-image: failed", error instanceof PublicImageDeadlineError ? "deadline" : reason ?? "network-or-decode");
    return failure(502);
  }
}
