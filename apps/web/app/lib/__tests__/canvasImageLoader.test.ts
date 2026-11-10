import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvasImageLoader, type CanvasImageLoad } from '../canvasImageLoader';
const source = (n = 0) => `/api/canvas-image?url=https%3A%2F%2Fimage.test%2F${n}.png&w=64&q=75`;
const image = () => ({ ok: true, status: 200, blob: async () => new Blob(['image'], { type: 'image/png' }) });
let loader: ReturnType<typeof createCanvasImageLoader>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test-${Math.random()}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  loader = createCanvasImageLoader();
});
afterEach(() => { loader.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('canvas image queue', () => {
  it('20-image bursts never exceed two active fetches', async () => {
    let active = 0; let maximum = 0; let ready = 0;
    const fetcher = vi.fn(async () => {
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active--; return image();
    });
    vi.stubGlobal('fetch', fetcher);
    for (let n = 0; n < 20; n++) loader.subscribe(source(n), state => { if (state.status === 'ready') ready++; });
    await vi.runAllTimersAsync();
    expect(maximum).toBe(2); expect(ready).toBe(20);
    expect(fetcher.mock.calls).toHaveLength(20);
  });
  it('all 20 images recover against a ten-token burst and one-token-per-second server', async () => {
    let tokens = 10; let last = Date.now(); let ready = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      const now = Date.now(); tokens = Math.min(10, tokens + (now - last) / 1000); last = now;
      if (tokens < 1) return new Response('', { status: 429 });
      tokens--; return image();
    }));
    for (let n = 0; n < 20; n++) loader.subscribe(source(n), state => { if (state.status === 'ready') ready++; });
    await vi.runAllTimersAsync(); expect(ready).toBe(20);
  });
  it('inline data uses the same queue and dedupes POST bodies without exposing data in URLs', async () => {
    const fetcher = vi.fn(async () => image()); vi.stubGlobal('fetch', fetcher);
    const request = { data: 'data:image/png;base64,aGVsbG8=', width: 64 };
    const one = vi.fn(); const two = vi.fn();
    loader.subscribe(request, one); loader.subscribe({ ...request, data: 'data:image/png;base64, aG\tVs\nbG8=\r\f' }, two);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('/api/canvas-image', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    }));
    expect(one).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'ready' }));
    expect(one.mock.calls.at(-1)).toEqual(two.mock.calls.at(-1));
    loader.subscribe({ ...request, width: 65 }, one);
    loader.subscribe({ data: 'data:image/svg+xml;base64,PHN2Zz4=', width: 64 }, one);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('recovers from 429 and respects Retry-After without direct-origin fallback', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '3' } })).mockImplementation(async () => image());
    vi.stubGlobal('fetch', fetcher);
    const listener = vi.fn(); loader.subscribe(source(), listener);
    await vi.advanceTimersByTimeAsync(2999); expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'ready' }));
    for (const [url, options] of fetcher.mock.calls) {
      expect(url).toBe(source()); expect(options.credentials).toBe('same-origin'); expect(options.redirect).toBe('error');
    }
  });
  it('503 is terminal and does not poll', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 503 })); vi.stubGlobal('fetch', fetcher);
    const listener = vi.fn(); loader.subscribe(source(), listener); await vi.runAllTimersAsync();
    expect(fetcher).toHaveBeenCalledTimes(1); expect(listener).toHaveBeenLastCalledWith({ status: 'disabled' });
  });
  it('deduplicates both in-flight and cached avatars without revoking a used URL', async () => {
    const fetcher = vi.fn(async () => image()); vi.stubGlobal('fetch', fetcher);
    const one = vi.fn(); const two = vi.fn();
    const off = loader.subscribe(source(), one); loader.subscribe(source(), two);
    await vi.runAllTimersAsync(); off();
    expect(one.mock.calls.at(-1)).toEqual(two.mock.calls.at(-1));
    expect(fetcher).toHaveBeenCalledTimes(1); expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });
  it('cancels queued nodes but holds running slots until their responses settle', async () => {
    const signals: AbortSignal[] = [];
    const releases: Array<(value: ReturnType<typeof image>) => void> = [];
    const fetcher = vi.fn((_url, options) => {
      signals.push(options.signal);
      return new Promise(resolve => releases.push(resolve));
    });
    vi.stubGlobal('fetch', fetcher);
    const a = loader.subscribe(source(1), () => {}); loader.subscribe(source(2), () => {});
    const queued = loader.subscribe(source(3), () => {}); queued(); a();
    loader.subscribe(source(4), () => {});
    expect(signals[0].aborted).toBe(false); expect(fetcher).toHaveBeenCalledTimes(2);
    releases[0](image()); await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[2][0]).toBe(source(4));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    releases[1](image()); releases[2](image()); await vi.advanceTimersByTimeAsync(0);
  });
  it('reuses an orphaned running request when the same avatar remounts', async () => {
    let resolve!: (value: ReturnType<typeof image>) => void;
    const fetcher = vi.fn(() => new Promise(done => { resolve = done; })); vi.stubGlobal('fetch', fetcher);
    const off = loader.subscribe(source(), () => {}); off();
    const listener = vi.fn(); loader.subscribe(source(), listener);
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve(image()); await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'ready' }));
  });
  it('cache eviction never removes a running orphan from deduplication', async () => {
    let resolveOrphan!: (value: ReturnType<typeof image>) => void;
    const fetcher = vi.fn((url: string) => url === source(99)
      ? new Promise(resolve => { resolveOrphan = resolve; })
      : Promise.resolve(image()));
    vi.stubGlobal('fetch', fetcher);
    const offOrphan = loader.subscribe(source(99), () => {}); offOrphan();
    for (let n = 0; n < 34; n++) {
      const off = loader.subscribe(source(n), () => {});
      await vi.advanceTimersByTimeAsync(0); off();
    }
    const listener = vi.fn(); loader.subscribe(source(99), listener);
    expect(fetcher.mock.calls.filter(([url]) => url === source(99))).toHaveLength(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    resolveOrphan(image()); await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'ready' }));
  });
  it('revokes idle blobs after cache expiry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => image()));
    let state: CanvasImageLoad = { status: 'loading' };
    const off = loader.subscribe(source(), value => { state = value; });
    await vi.runAllTimersAsync(); expect(state.status).toBe('ready'); off();
    await vi.advanceTimersByTimeAsync(30_000); expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
  it('ordinary failures retry only once and rejects external endpoints', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 502 })); vi.stubGlobal('fetch', fetcher);
    const listener = vi.fn(); loader.subscribe(source(), listener); await vi.runAllTimersAsync();
    expect(fetcher).toHaveBeenCalledTimes(2); expect(listener).toHaveBeenLastCalledWith({ status: 'error' });
    loader.subscribe('https://image.test/a.png', listener); expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
