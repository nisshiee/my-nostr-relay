import { normalizeCanvasInlineImage } from './canvasInlineImage';
import { CANVAS_IMAGE_WIDTHS } from './canvasImagePolicy';

export type CanvasImageRequest = string | { data: string; width: number };
export type CanvasImageLoad = { status: 'loading' } | { status: 'ready'; url: string } | { status: 'error' | 'disabled' };
type Listener = (state: CanvasImageLoad) => void;
type Entry = {
  source: string; request: CanvasImageRequest; listeners: Set<Listener>; state: CanvasImageLoad;
  attempts: number; failures: number; due: number; controller?: AbortController;
  bytes: number; expiry?: ReturnType<typeof setTimeout>;
};

/** Canvas画像配信用。同一originの取得routeだけを、全カードで同時に最大2件取得する。 */
export function createCanvasImageLoader() {
  const entries = new Map<string, Entry>();
  const queue: Entry[] = [];
  let active = 0;
  let cooldown = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const notify = (entry: Entry, state: CanvasImageLoad) => {
    entry.state = state;
    for (const listener of entry.listeners) listener(state);
  };
  const remove = (entry: Entry) => {
    if (entries.get(entry.source) === entry) entries.delete(entry.source);
    clearTimeout(entry.expiry);
    // 開始済みの取得は完了までslotを保持し、server側の同時処理を増やさない。
    if (entry.state.status === 'ready') URL.revokeObjectURL(entry.state.url);
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
  };
  const trim = () => {
    const idle = [...entries.values()].filter(entry => !entry.listeners.size && !entry.controller);
    let bytes = idle.reduce((sum, entry) => sum + entry.bytes, 0);
    let count = idle.length;
    for (const entry of idle) {
      if (count <= 32 && bytes <= 16 * 1024 * 1024) break;
      remove(entry); bytes -= entry.bytes; count--;
    }
  };
  const pump = () => {
    clearTimeout(timer); timer = undefined;
    if (active >= 2 || !queue.length) return;
    const now = Date.now();
    const index = queue.findIndex(entry => entry.due <= now);
    if (cooldown > now || index < 0) {
      const due = Math.max(cooldown, Math.min(...queue.map(entry => entry.due)));
      timer = setTimeout(pump, Math.max(1, due - now));
      return;
    }
    const entry = queue.splice(index, 1)[0];
    active++;
    entry.controller = new AbortController();
    void run(entry).finally(() => {
      active--; entry.controller = undefined;
      if (!entry.listeners.size && entry.state.status !== 'ready') remove(entry);
      pump();
    });
    pump();
  };
  const retry = (entry: Entry, delay: number) => {
    entry.due = Date.now() + delay;
    queue.push(entry);
  };
  const run = async (entry: Entry) => {
    const timeout = setTimeout(() => entry.controller?.abort(), 20_000);
    try {
      const response = await fetch(typeof entry.request === 'string' ? entry.request : '/api/canvas-image', {
        ...(typeof entry.request === 'string' ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry.request) }),
        credentials: 'same-origin', redirect: 'error', signal: entry.controller!.signal });
      if (!entry.listeners.size) { await response.body?.cancel(); return; }
      if ([401, 403, 503].includes(response.status)) {
        notify(entry, { status: 'disabled' });
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('canvas-image-unauthorized'));
        return;
      }
      if (response.status === 429 && entry.attempts++ < 8) {
        const value = response.headers.get('Retry-After');
        const seconds = value === null ? NaN : Number(value);
        const headerDelay = Number.isFinite(seconds) ? seconds * 1000 : value ? Date.parse(value) - Date.now() : 0;
        const delay = Math.max(1000, Math.min(60_000, headerDelay || 0), Math.min(16_000, 1000 * 2 ** (entry.attempts - 1))) + Math.random() * 250;
        cooldown = Math.max(cooldown, Date.now() + delay);
        retry(entry, delay); return;
      }
      if (!response.ok) throw new Error(`Image ${response.status}`);
      const blob = await response.blob();
      if (!entry.listeners.size) return;
      if (!blob.type.startsWith('image/') || blob.size > 8 * 1024 * 1024) throw new Error('Invalid image');
      entry.bytes = blob.size + (typeof entry.request === 'string' ? 0 : entry.request.data.length * 4);
      notify(entry, { status: 'ready', url: URL.createObjectURL(blob) });
    } catch {
      if (!entry.listeners.size) return;
      if (entry.failures++ < 1) retry(entry, 1000);
      else notify(entry, { status: 'error' });
    } finally {
      clearTimeout(timeout);
    }
  };
  return {
    subscribe(request: CanvasImageRequest, listener: Listener) {
      const width = typeof request === 'string' ? 0 : request.width;
      const inline = typeof request === 'string' ? null : normalizeCanvasInlineImage(request.data);
      // 外部URLや別endpointへ直接アクセスできないよう入口も制限する。
      if (typeof request === 'string'
        ? !request.startsWith('/api/canvas-image?') || request.includes('#')
        : !inline || !CANVAS_IMAGE_WIDTHS.some(allowed => allowed === width)) {
        listener({ status: 'error' }); return () => {};
      }
      if (typeof request !== 'string') request = { data: inline!, width: request.width };
      const source = typeof request === 'string' ? request : `inline:${request.width}:${request.data}`;
      let entry = entries.get(source);
      if (!entry) {
        entry = { source, request, listeners: new Set(), state: { status: 'loading' }, attempts: 0, failures: 0, due: 0, bytes: 0 };
        entries.set(source, entry); queue.push(entry);
      }
      clearTimeout(entry.expiry);
      entry.listeners.add(listener); listener(entry.state); pump();
      const current = entry;
      return () => {
        current.listeners.delete(listener);
        if (current.listeners.size) return;
        if (current.state.status !== 'ready') {
          if (!current.controller) remove(current);
        }
        else {
          // 共有avatarの短期cache。利用中のblobは失効させない。
          current.expiry = setTimeout(() => remove(current), 30_000);
          entries.delete(source); entries.set(source, current); trim();
        }
        pump();
      };
    },
    invalidateAuthorization() {
      // 通信中のslotはfinallyまで保持するが、旧認証の応答/Blobを新セッションへ再利用しない。
      for (const entry of [...entries.values()]) {
        entry.listeners.clear();
        remove(entry);
        entry.state = { status: 'disabled' };
      }
      clearTimeout(timer);
    },
    dispose() {
      for (const entry of entries.values()) {
        entry.listeners.clear();
        if (!entry.controller) remove(entry);
      }
      clearTimeout(timer);
    },
  };
}

export const canvasImageLoader = createCanvasImageLoader();
