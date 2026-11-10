import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolve4: vi.fn(), resolve6: vi.fn(), cancel: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ Resolver: class {
  resolve4 = mocks.resolve4;
  resolve6 = mocks.resolve6;
  cancel = mocks.cancel;
} }));
vi.mock("node:https", () => ({ request: mocks.request }));
import { fetchPublicImage, isPublicImageAddress, validatePublicImageUrl, PublicImageDeadlineError } from "../publicImageFetch";

function response(body: Buffer, headers: Record<string, string> = {}, status = 200) {
  mocks.request.mockImplementationOnce((_url, _options, callback) => {
    const req = new EventEmitter() as EventEmitter & { end(): void };
    req.end = () => {
      const res = Object.assign(new PassThrough(), {
        statusCode: status,
        headers: { "content-type": "image/png", ...headers },
      });
      callback(res);
      if (!res.destroyed) res.end(body);
    };
    return req;
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolve4.mockResolvedValue(["8.8.8.8"]);
  mocks.resolve6.mockResolvedValue([]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("public image policy", () => {
  it.each([
    "http://example.com/a", "https://example.com:444/a", "https://a:b@example.com/a",
    "https://example.com/a?", "https://example.com/a#", "https://127.0.0.1/a",
    "https://2130706433/a", "https://[::1]/a", "https://localhost/a", "https://x.local/a",
    "https://example.com./a", "https://example.com\\a",
  ])("rejects URL %s", url => expect(() => validatePublicImageUrl(url)).toThrow());
  it("accepts public domain HTTPS", () => expect(validatePublicImageUrl("https://cdn.example.com:443/a.png").hostname).toBe("cdn.example.com"));
  it.each(["127.0.0.1", "10.1.1.1", "169.254.169.254", "100.64.0.1", "192.0.2.1", "198.18.0.1", "224.0.0.1", "240.0.0.1", "::1", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1", "2001:db8::1", "fc00::1", "fe80::1", "ff02::1", "invalid"])("rejects address %s", address => expect(isPublicImageAddress(address)).toBe(false));
  it.each(["8.8.8.8", "2606:4700:4700::1111"])("accepts address %s", address => expect(isPublicImageAddress(address)).toBe(true));
});

describe("public image fetch", () => {
  it("pins DNS while preserving TLS hostname and produces bounded WebP", async () => {
    const png = await sharp({ create: { width: 80, height: 40, channels: 3, background: "red" } }).png().toBuffer();
    response(png);
    const output = await fetchPublicImage("https://cdn.example.com/a.png", 32);
    const metadata = await sharp(output).metadata();
    expect(metadata).toMatchObject({ format: "webp", width: 32, height: 16 });
    const options = mocks.request.mock.calls[0][1];
    expect(options).toMatchObject({ agent: false, servername: "cdn.example.com", family: 4 });
    const callback = vi.fn();
    options.lookup("cdn.example.com", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "8.8.8.8", 4);
    expect(mocks.resolve4).toHaveBeenCalledTimes(1);
    expect(mocks.resolve6).toHaveBeenCalledTimes(1);
  });
  it("rejects any private answer even alongside public answers", async () => {
    mocks.resolve6.mockResolvedValue(["::1"]);
    await expect(fetchPublicImage("https://cdn.example.com/a", 32)).rejects.toThrow("DNS address");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("rejects DNS errors other than absent records", async () => {
    mocks.resolve6.mockRejectedValue(Object.assign(new Error("DNS failure"), { code: "ETIMEOUT" }));
    await expect(fetchPublicImage("https://cdn.example.com/a", 32)).rejects.toThrow("DNS failure");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("rechecks redirect DNS and rejects private destination", async () => {
    response(Buffer.alloc(0), { location: "https://other.example.com/b" }, 302);
    mocks.resolve4.mockResolvedValueOnce(["8.8.8.8"]).mockResolvedValueOnce(["10.0.0.1"]);
    await expect(fetchPublicImage("https://cdn.example.com/a", 32)).rejects.toThrow("DNS address");
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it.each(["https://user:pass@example.com/a", "https://example.com/a?q=1", "https://example.com:444/a", "http://example.com/a", "https://127.0.0.1/a"])("rejects redirect target %s", async target => {
    response(Buffer.alloc(0), { location: target }, 302);
    await expect(fetchPublicImage("https://cdn.example.com/a", 32)).rejects.toThrow();
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it("permits at most two redirects", async () => {
    for (let i = 0; i < 3; i++) response(Buffer.alloc(0), { location: "/again" }, 302);
    await expect(fetchPublicImage("https://cdn.example.com/a", 32)).rejects.toThrow("redirect limit");
    expect(mocks.request).toHaveBeenCalledTimes(3);
  });
  it.each([
    [{ "content-encoding": "gzip" }, "encoding"],
    [{ "content-type": "image/svg+xml" }, "MIME"],
    [{ "content-length": "5242881" }, "length"],
  ])("rejects unsafe response %j", async (headers, reason) => {
    response(Buffer.from("bad"), headers);
    await expect(fetchPublicImage("https://cdn.example.com/a", 32)).rejects.toThrow(reason);
  });
  it.each([
    ["image/jpg", "image-jpg"],
    ["application/octet-stream", "octet-stream"],
    ["image/avif", "avif"],
    ["image/gif", "gif"],
    ["text/html; charset=utf-8", "text-html"],
    ["image/svg+xml", "svg"],
    ["", "other"],
    ["application/x-private-header-value", "other"],
    ["constructor", "other"],
    ["__proto__", "other"],
  ])("reports bounded MIME category for %s without allowing it", async (mime, category) => {
    response(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), { "content-type": mime });
    await expect(fetchPublicImage("https://cdn.example.com/a", 32)).rejects.toThrow(`Public image rejected: MIME ${category}`);
  });
  it("rejects oversized streaming body without content-length", async () => {
    response(Buffer.alloc(5 * 1024 * 1024 + 1));
    await expect(fetchPublicImage("https://cdn.example.com/a", 32)).rejects.toThrow("input size");
  });
  it("requires magic bytes to match MIME", async () => {
    response(Buffer.from("<svg></svg>"));
    await expect(fetchPublicImage("https://cdn.example.com/a", 32)).rejects.toThrow("magic bytes");
  });
  it("rejects malformed raster input", async () => {
    response(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await expect(fetchPublicImage("https://cdn.example.com/a", 32)).rejects.toThrow();
  });
  it("rejects decoded pixel count above 16 million", async () => {
    const png = await sharp({ create: { width: 4001, height: 4000, channels: 3, background: "red" } }).png().toBuffer();
    response(png);
    await expect(fetchPublicImage("https://cdn.example.com/a", 32)).rejects.toThrow();
  });
  it("rejects APNG animation chunks before decoding", async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
    const chunk = Buffer.alloc(20);
    chunk.writeUInt32BE(8, 0);
    chunk.write("acTL", 4);
    chunk.writeUInt32BE(2, 8);
    response(Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]));
    await expect(fetchPublicImage("https://cdn.example.com/a", 32)).rejects.toThrow("animation");
  });
  it("rejects animated WebP chunks before decoding", async () => {
    const webp = Buffer.alloc(26);
    webp.write("RIFF", 0);
    webp.writeUInt32LE(18, 4);
    webp.write("WEBPANIM", 8);
    webp.writeUInt32LE(6, 16);
    response(webp, { "content-type": "image/webp" });
    await expect(fetchPublicImage("https://cdn.example.com/a", 32)).rejects.toThrow("animation");
  });
  it("fails on truncated HTTP body", async () => {
    mocks.request.mockImplementationOnce((_url, _options, callback) => {
      const req = new EventEmitter() as EventEmitter & { end(): void };
      req.end = () => {
        const res = Object.assign(new PassThrough(), { statusCode: 200, headers: { "content-type": "image/png" } });
        callback(res);
        res.emit("aborted");
        res.destroy();
      };
      return req;
    });
    await expect(fetchPublicImage("https://cdn.example.com/a", 32)).rejects.toThrow("aborted");
  });
  it("deadline covers stalled response body and aborts request signal", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    mocks.request.mockImplementationOnce((_url, options, callback) => {
      signal = options.signal;
      const req = new EventEmitter() as EventEmitter & { end(): void };
      req.end = () => callback(Object.assign(new PassThrough(), { statusCode: 200, headers: { "content-type": "image/png" } }));
      return req;
    });
    const pending = expect(fetchPublicImage("https://cdn.example.com/a", 32)).rejects.toMatchObject({ nativeWorkMayRemain: false });
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    expect(signal?.aborted).toBe(true);
  });
  it("deadline includes DNS and cancels pending resolution", async () => {
    vi.useFakeTimers();
    mocks.resolve4.mockImplementation(() => new Promise(() => {}));
    const pending = expect(fetchPublicImage("https://cdn.example.com/a", 32)).rejects.toMatchObject({ nativeWorkMayRemain: false });
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    expect(mocks.cancel).toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("retains native-work marker when sharp metadata is still pending", async () => {
    vi.useFakeTimers();
    vi.spyOn(sharp.prototype, "metadata").mockImplementation(() => new Promise(() => {}));
    response(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const outcome = fetchPublicImage("https://cdn.example.com/a", 32).catch(error => error);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(PublicImageDeadlineError);
    expect(error.nativeWorkMayRemain).toBe(true);
  });
  it("rejects arbitrary widths before DNS", async () => {
    await expect(fetchPublicImage("https://cdn.example.com/a", 100 as 32)).rejects.toThrow("width");
    expect(mocks.resolve4).not.toHaveBeenCalled();
  });
});
