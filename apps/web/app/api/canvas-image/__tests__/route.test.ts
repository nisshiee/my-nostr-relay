vi.mock('server-only', () => ({}));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "../route";
import { fetchInlineImage, fetchPublicImage, PublicImageDeadlineError } from "../../../lib/publicImageFetch";

vi.mock("../../../lib/publicImageFetch", () => ({ fetchInlineImage: vi.fn(), fetchPublicImage: vi.fn(), PublicImageDeadlineError: class extends Error {
  constructor(message: string, public readonly nativeWorkMayRemain = true) { super(message); }
} }));
const fetchImage = vi.mocked(fetchPublicImage);
function request(url = "https://images.example/a.png", width = "64", extra = "") {
  return new Request(`http://localhost/api/canvas-image?url=${encodeURIComponent(url)}&w=${width}${extra}`);
}
beforeEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for("nlc.canvas-image.state.v1"));
  vi.stubEnv("CANVAS_IMAGE_PROXY_ENABLED", "1");
  vi.stubEnv("CANVAS_IMAGE_PROXY_SCOPE", "protected-preview");
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("VERCEL_TARGET_ENV", undefined);
  fetchImage.mockReset().mockResolvedValue(Buffer.from("webp"));
  vi.mocked(fetchInlineImage).mockReset().mockResolvedValue(Buffer.from("inline-webp"));
  vi.spyOn(Date, "now").mockReturnValue(100_000);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("canvas-image default-off route", () => {
  it.each([undefined, "0", "true"])("does not call the helper when flag is %s", async flag => {
    vi.stubEnv("CANVAS_IMAGE_PROXY_ENABLED", flag);
    expect((await GET(request())).status).toBe(503);
    expect(fetchImage).not.toHaveBeenCalled();
  });
  it("blocks production even when enabled, including cache hits", async () => {
    expect((await GET(request())).status).toBe(200);
    vi.stubEnv("VERCEL_ENV", "production");
    expect((await GET(request())).status).toBe(503);
    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubEnv("VERCEL_TARGET_ENV", "production");
    expect((await GET(request())).status).toBe(503);
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, "", "preview", "protected-production"])("requires exact scope %s", async scope => {
    vi.stubEnv("CANVAS_IMAGE_PROXY_SCOPE", scope);
    expect((await GET(request())).status).toBe(503);
    expect(fetchImage).not.toHaveBeenCalled();
  });
  it.each(["development", "test", "production"])("accepts scoped missing platform env with NODE_ENV %s", async nodeEnv => {
    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubEnv("NODE_ENV", nodeEnv);
    expect((await GET(request())).status).toBe(200);
  });
  const platforms = [undefined, "", "preview", "development", "production", "staging"];
  it.each(platforms.flatMap(env => platforms.map(target => [env, target] as const)))(
    "validates both platform values: %s / %s", async (env, target) => {
      vi.stubEnv("VERCEL_ENV", env);
      vi.stubEnv("VERCEL_TARGET_ENV", target);
      const allowed = [env, target].every(v => !v || v === "preview" || v === "development");
      expect((await GET(request())).status).toBe(allowed ? 200 : 503);
      expect(fetchImage).toHaveBeenCalledTimes(allowed ? 1 : 0);
    },
  );
  it("does not accept request headers as deployment scope", async () => {
    vi.stubEnv("CANVAS_IMAGE_PROXY_SCOPE", undefined);
    const spoofed = new Request(request(), { headers: {
      "CANVAS_IMAGE_PROXY_SCOPE": "protected-preview", "VERCEL_ENV": "preview",
      "x-vercel-env": "preview", "x-vercel-target-env": "preview",
    } });
    expect((await GET(spoofed)).status).toBe(503);
    expect(fetchImage).not.toHaveBeenCalled();
  });
  it.each(["0", "65", "064", "640.0", "Infinity"])("rejects width %s", async w => {
    expect((await GET(request(undefined, w))).status).toBe(400);
    expect(fetchImage).not.toHaveBeenCalled();
  });
  it.each(["&q=90", "&w=32", "&url=x", "&other=x"])("rejects query %s", async extra => {
    expect((await GET(request(undefined, "64", extra))).status).toBe(400);
    expect(fetchImage).not.toHaveBeenCalled();
  });
  it.each([32, 64, 128, 640, 1280])("accepts fixed width %s and quality75", async width => {
    expect((await GET(request(undefined, String(width), "&q=75"))).status).toBe(200);
    expect(fetchImage).toHaveBeenCalledWith("https://images.example/a.png", width);
  });
  it("returns only safe headers and WebP bytes, with no reusable HTTP cache", async () => {
    const response = await GET(request());
    expect(await response.text()).toBe("webp");
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
  });
  it("deduplicates inflight work and limits distinct work to two", async () => {
    let finish!: (value: Buffer) => void;
    fetchImage.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const first = GET(request());
    const same = GET(request());
    const second = GET(request("https://images.example/b.png"));
    const limited = await GET(request("https://images.example/c.png"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1");
    expect(fetchImage).toHaveBeenCalledTimes(2);
    finish(Buffer.from("done"));
    expect((await first).status).toBe(200);
    expect((await same).status).toBe(200);
    expect((await second).status).toBe(200);
    fetchImage.mockResolvedValue(Buffer.from("recovered"));
    expect((await GET(request("https://images.example/c.png"))).status).toBe(200);
  });
  it("bounds burst to sixty misses, refills four per second, and permits cache hits", async () => {
    for (let i = 0; i < 60; i++) expect((await GET(request(`https://images.example/${i}.png`))).status).toBe(200);
    expect((await GET(request("https://images.example/new.png"))).status).toBe(429);
    expect((await GET(request("https://images.example/0.png"))).status).toBe(200);
    vi.mocked(Date.now).mockReturnValue(100_250);
    expect((await GET(request("https://images.example/new.png"))).status).toBe(200);
  });
  it("expires cached entries after five minutes", async () => {
    await GET(request());
    await GET(request());
    expect(fetchImage).toHaveBeenCalledTimes(1);
    vi.mocked(Date.now).mockReturnValue(400_000);
    await GET(request());
    expect(fetchImage).toHaveBeenCalledTimes(2);
  });
  it("evicts LRU entries at 64 and refreshes on hits", async () => {
    for (let i = 0; i < 64; i++) {
      vi.mocked(Date.now).mockReturnValue(100_000 + i * 1000);
      await GET(request(`https://images.example/${i}.png`));
    }
    await GET(request("https://images.example/0.png"));
    await GET(request("https://images.example/64.png"));
    await GET(request("https://images.example/0.png"));
    expect(fetchImage).toHaveBeenCalledTimes(65);
    await GET(request("https://images.example/1.png"));
    expect(fetchImage).toHaveBeenCalledTimes(66);
  });
  it("bounds cached bytes to 16 MiB", async () => {
    fetchImage.mockResolvedValue(Buffer.alloc(2 * 1024 * 1024));
    for (let i = 0; i < 9; i++) await GET(request(`https://images.example/${i}.png`));
    await GET(request("https://images.example/0.png"));
    expect(fetchImage).toHaveBeenCalledTimes(10);
  });
  it("does not disclose upstream errors and retains uncertain native work slots", async () => {
    fetchImage.mockRejectedValue(new PublicImageDeadlineError("secret upstream URL https://private.example/token"));
    const response = await GET(request());
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Image unavailable (502)");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await GET(request())).status).toBe(502);
    expect((await GET(request())).status).toBe(429);
    expect(fetchImage).toHaveBeenCalledTimes(2);
  });
  it("releases slots for settled validation and upstream failures", async () => {
    fetchImage.mockRejectedValueOnce(new Error("invalid URL"))
      .mockRejectedValueOnce(new Error("upstream 404"));
    expect((await GET(request())).status).toBe(502);
    expect((await GET(request())).status).toBe(502);
    expect((await GET(request())).status).toBe(200);
    expect(fetchImage).toHaveBeenCalledTimes(3);
  });
  it("releases DNS and HTTP deadline slots so later images can load", async () => {
    fetchImage.mockRejectedValueOnce(new PublicImageDeadlineError("DNS timeout", false))
      .mockRejectedValueOnce(new PublicImageDeadlineError("HTTP timeout", false));
    expect((await GET(request())).status).toBe(502);
    expect((await GET(request())).status).toBe(502);
    expect((await GET(request())).status).toBe(200);
    expect(fetchImage).toHaveBeenCalledTimes(3);
  });
  it("forwards source query unchanged for helper rejection", async () => {
    const url = "https://images.example/a.png?secret=1";
    fetchImage.mockRejectedValue(new Error("invalid"));
    expect((await GET(request(url))).status).toBe(502);
    expect(fetchImage).toHaveBeenCalledWith(url, 64);
  });
});


describe("inline canvas images", () => {
  const data = "data:image/png;base64,aGVsbG8=";
  function post(body: unknown = { data, width: 64 }, headers: Record<string, string> = {}) {
    return new Request("http://localhost/api/canvas-image", {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    });
  }
  it("uses inline helper only and reuses a hashed cache entry", async () => {
    const response = await POST(post());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(await response.text()).toBe("inline-webp");
    expect((await POST(post())).status).toBe(200);
    expect(fetchInlineImage).toHaveBeenCalledExactlyOnceWith(data, 64);
    expect(fetchImage).not.toHaveBeenCalled();
    const cache = Reflect.get(globalThis, Symbol.for("nlc.canvas-image.state.v1")).cache as Map<string, unknown>;
    expect([...cache.keys()][0]).toMatch(/^inline:64:[a-f0-9]{64}$/);
  });
  it.each(["production", "staging"])("rejects %s before consuming a body", async env => {
    vi.stubEnv("VERCEL_ENV", env);
    const request = post();
    expect((await POST(request)).status).toBe(503);
    expect(request.bodyUsed).toBe(false);
    expect(fetchInlineImage).not.toHaveBeenCalled();
  });
  it("rejects disabled scope before body reads", async () => {
    vi.stubEnv("CANVAS_IMAGE_PROXY_SCOPE", undefined);
    const request = post();
    expect((await POST(request)).status).toBe(503);
    expect(request.bodyUsed).toBe(false);
  });
  it("rejects explicit cross origin but accepts same origin", async () => {
    expect((await POST(post(undefined, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await POST(post(undefined, { origin: "null" }))).status).toBe(403);
    expect((await POST(post(undefined, { origin: "http://localhost" }))).status).toBe(200);
  });
  it("requires JSON content type", async () => {
    expect((await POST(post(undefined, { "content-type": "text/plain" }))).status).toBe(415);
    expect(fetchInlineImage).not.toHaveBeenCalled();
  });
  it.each([{}, { data }, { data, w: 64 }, { data, width: "64" }, { data, width: 65 },
    { data, width: 64, extra: true }, { data: "https://example.com/a.png", width: 64 }, null, []])(
    "rejects invalid fields %j", async body => {
      expect((await POST(post(body))).status).toBe(400);
      expect(fetchInlineImage).not.toHaveBeenCalled();
    },
  );
  it("caps declared and streamed bytes before inline decoding", async () => {
    const declared = post(undefined, { "content-length": String(3 * 1024 * 1024 + 1) });
    expect((await POST(declared)).status).toBe(413);
    expect(declared.bodyUsed).toBe(false);
    expect((await POST(post({ data: "data:" + "A".repeat(3 * 1024 * 1024), width: 64 }))).status).toBe(413);
    expect(fetchInlineImage).not.toHaveBeenCalled();
  });
  it("rejects invalid base64 before invoking the helper", async () => {
    const response = await POST(post({ data: "data:image/png;base64,!!", width: 64 }));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Image unavailable (400)");
    expect(fetchImage).not.toHaveBeenCalled();
    expect(fetchInlineImage).not.toHaveBeenCalled();
  });
  it("shares concurrent work budget with GET", async () => {
    let finish!: (b: Buffer) => void;
    fetchImage.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const a = GET(request());
    const b = GET(request("https://images.example/b.png"));
    const response = await POST(post());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(fetchInlineImage).not.toHaveBeenCalled();
    finish(Buffer.from("ok"));
    await Promise.all([a, b]);
    expect((await POST(post())).status).toBe(200);
  });
  it("normalizes ASCII whitespace before inline cache keys and helper calls", async () => {
    expect((await POST(post({ data: "data:image/png;base64,aG V\tsbG8=\r\n", width: 64 }))).status).toBe(200);
    expect((await POST(post())).status).toBe(200);
    expect(fetchInlineImage).toHaveBeenCalledExactlyOnceWith(data, 64);
  });
  it("rejects non-ASCII whitespace without helper work", async () => {
    expect((await POST(post({ data: "data:image/png;base64,aG\u00a0VsbG8=", width: 64 }))).status).toBe(400);
    expect(fetchInlineImage).not.toHaveBeenCalled();
  });
  it("deduplicates identical inline work", async () => {
    let finish!: (b: Buffer) => void;
    vi.mocked(fetchInlineImage).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const a = POST(post());
    const b = POST(post());
    await vi.waitFor(() => expect(fetchInlineImage).toHaveBeenCalledTimes(1));
    finish(Buffer.from("ok"));
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
  });
  it("caps concurrent slow bodies and cancels them at the body deadline", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const slow = () => new Request("http://localhost/api/canvas-image", {
      method: "POST", headers: { "content-type": "application/json" },
      body: new ReadableStream({ cancel }), duplex: "half",
    } as RequestInit);
    try {
      const a = POST(slow());
      const b = POST(slow());
      expect((await POST(post())).status).toBe(429);
      await vi.advanceTimersByTimeAsync(5000);
      expect((await a).status).toBe(400);
      expect((await b).status).toBe(400);
      expect(cancel).toHaveBeenCalledTimes(2);
      expect((await POST(post())).status).toBe(200);
    } finally { vi.useRealTimers(); }
  });
  it("limits invalid-body parsing before reading and refills the separate body budget", async () => {
    for (let i = 0; i < 10; i++) expect((await POST(post({ bad: true }))).status).toBe(400);
    const rejected = post();
    const response = await POST(rejected);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(rejected.bodyUsed).toBe(false);
    expect(fetchInlineImage).not.toHaveBeenCalled();
    expect((await GET(request())).status).toBe(200);
    vi.mocked(Date.now).mockReturnValue(101_000);
    expect((await POST(post())).status).toBe(200);
    const next = post();
    expect((await POST(next)).status).toBe(429);
    expect(next.bodyUsed).toBe(false);
  });
  it("shares token budget with GET", async () => {
    for (let i = 0; i < 60; i++) await GET(request(`https://images.example/${i}.png`));
    expect((await POST(post())).status).toBe(429);
    expect(fetchInlineImage).not.toHaveBeenCalled();
  });
});
