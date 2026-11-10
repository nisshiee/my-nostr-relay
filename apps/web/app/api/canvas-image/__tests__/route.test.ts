import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../route";
import { fetchPublicImage, PublicImageDeadlineError } from "../../../lib/publicImageFetch";

vi.mock("../../../lib/publicImageFetch", () => ({ fetchPublicImage: vi.fn(), PublicImageDeadlineError: class extends Error {} }));
const fetchImage = vi.mocked(fetchPublicImage);
function request(url = "https://images.example/a.png", width = "64", extra = "") {
  return new Request(`http://localhost/api/canvas-image?url=${encodeURIComponent(url)}&w=${width}${extra}`);
}
beforeEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for("nlc.canvas-image.state.v1"));
  vi.stubEnv("CANVAS_IMAGE_PROXY_ENABLED", "1");
  vi.stubEnv("VERCEL_ENV", "preview");
  fetchImage.mockReset().mockResolvedValue(Buffer.from("webp"));
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
    vi.stubEnv("NODE_ENV", "production");
    expect((await GET(request())).status).toBe(503);
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });
  it("allows explicit local development", async () => {
    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubEnv("NODE_ENV", "development");
    expect((await GET(request())).status).toBe(200);
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
    expect((await GET(request("https://images.example/c.png"))).status).toBe(429);
    expect(fetchImage).toHaveBeenCalledTimes(2);
    finish(Buffer.from("done"));
    expect((await first).status).toBe(200);
    expect((await same).status).toBe(200);
    expect((await second).status).toBe(200);
  });
  it("bounds burst to ten misses, refills one per second, and permits cache hits", async () => {
    for (let i = 0; i < 10; i++) expect((await GET(request(`https://images.example/${i}.png`))).status).toBe(200);
    expect((await GET(request("https://images.example/new.png"))).status).toBe(429);
    expect((await GET(request("https://images.example/0.png"))).status).toBe(200);
    vi.mocked(Date.now).mockReturnValue(101_000);
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
    expect(await response.text()).toBe("Image unavailable");
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
  it("forwards source query unchanged for helper rejection", async () => {
    const url = "https://images.example/a.png?secret=1";
    fetchImage.mockRejectedValue(new Error("invalid"));
    expect((await GET(request(url))).status).toBe(502);
    expect(fetchImage).toHaveBeenCalledWith(url, 64);
  });
});
