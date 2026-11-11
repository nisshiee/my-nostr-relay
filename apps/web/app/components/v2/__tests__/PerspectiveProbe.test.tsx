// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveProbe } from '../PerspectiveProbe';

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let resize: ResizeObserverCallback;
const originalPaint = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'requestPaint');
const originalContent = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'content');

beforeEach(() => {
  frames = new Map(); nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 540, width: 600, height: 540, toJSON() {},
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const [name, descriptor] of [['requestPaint', originalPaint], ['content', originalContent]] as const) {
    if (descriptor) Object.defineProperty(HTMLCanvasElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLCanvasElement.prototype, name);
  }
});

function flushFrame() {
  act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); });
}

function native({ modern = true, respond = true, fail = false, requestFail = false } = {}) {
  // これはAPI契約のコンポーネントテスト。実際の透視描画やクリック位置は検証しない。
  const context = { resetTransform: vi.fn(), clearRect: vi.fn(), setTransform: vi.fn(),
    drawElementImage: vi.fn(() => { if (fail) throw new Error('draw failed'); }) };
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(context as unknown as CanvasRenderingContext2D);
  if (modern) Object.defineProperty(HTMLCanvasElement.prototype, 'content', { configurable: true, value: '' });
  const requestPaint = vi.fn(function(this: HTMLCanvasElement) {
    if (requestFail) throw new Error('request failed');
    if (respond) this.dispatchEvent(new Event('paint'));
  });
  Object.defineProperty(HTMLCanvasElement.prototype, 'requestPaint', { configurable: true, value: requestPaint });
  return { ...context, requestPaint };
}

function outer() { return document.querySelector<HTMLDivElement>('[data-perspective-root]')!; }
function inner() { return document.querySelector<HTMLElement>('[data-perspective-card]')!; }

describe('PerspectiveProbeのDOM状態とnative API契約', () => {
  it('3箇所の独立カウンターと入力を安全に操作し、DOMでは角度選択を保持しても変形しない', () => {
    render(<PerspectiveProbe />); flushFrame();
    expect(screen.getByRole('status').textContent).toContain('native APIなし');
    const root = outer(), card = inner();
    expect(root.style.transform).toBe('none');
    expect(card.style.transform).toBe('perspective(700px) rotateX(0deg)');
    expect(card.style.transformOrigin).toBe('50% 100%');
    expect(card.style.boxShadow).not.toBe('none');
    expect(root.style.paddingBottom).toBe('76px');
    for (const label of ['上', '中央', '下']) fireEvent.click(screen.getByRole('button', { name: `${label}のボタン 0` }));
    for (const label of ['上', '中央', '下']) expect(screen.getByRole('button', { name: `${label}のボタン 1` })).toBeDefined();
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '送信しないメモ' } });
    fireEvent.click(screen.getByRole('button', { name: '角度 45° → 平面へ' })); flushFrame();
    expect(inner()).toBe(card);
    expect(card.style.transform).toBe('perspective(700px) rotateX(0deg)');
    expect(input.value).toBe('送信しないメモ');
    fireEvent.click(screen.getByRole('button', { name: '角度 0° → 傾ける' })); flushFrame();
    expect(card.style.transform).toBe('perspective(700px) rotateX(0deg)');
    expect(outer()).toBe(root);
    expect(root.querySelectorAll('[drawable]').length).toBe(0);
    expect(frames.size).toBe(0);
  });

  it('modernでは無変形の外枠だけをDPR倍率・通常位置で一度描き、idleで停止する', () => {
    const api = native();
    vi.stubGlobal('devicePixelRatio', 2);
    render(<PerspectiveProbe />); flushFrame();
    const root = outer(), canvas = document.querySelector('canvas')!;
    expect(canvas.getAttribute('content')).toBe('drawable');
    expect(canvas.hasAttribute('layoutsubtree')).toBe(false);
    expect(root.parentElement).toBe(canvas);
    expect(root.hasAttribute('drawable')).toBe(true);
    expect(root.querySelector('[drawable]')).toBeNull();
    expect(root.style.transform).toBe('none');
    expect(root.style.left).toBe('0px'); expect(root.style.top).toBe('0px');
    expect(api.setTransform).toHaveBeenCalledExactlyOnceWith(2, 0, 0, 2, 0, 0);
    expect(api.drawElementImage).toHaveBeenCalledExactlyOnceWith(root, 70, 24, 460, 468);
    expect(canvas.width).toBe(1200); expect(canvas.height).toBe(1080);
    expect(screen.getByRole('status').textContent).toContain('Native modern');
    expect(frames.size).toBe(0);
  });

  it('legacyは既存検出を使い、無変形の外枠でヒット補正しないためDOMへ退避する', () => {
    const api = native({ modern: false });
    render(<PerspectiveProbe />); flushFrame();
    const canvas = document.querySelector('canvas')!;
    expect(canvas.hasAttribute('layoutsubtree')).toBe(false);
    expect(canvas.hasAttribute('content')).toBe(false);
    expect(canvas.querySelector('[drawable]')).toBeNull();
    expect(outer().style.transform).toBe('none');
    expect(api.drawElementImage).not.toHaveBeenCalled();
    expect(canvas.hidden).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('legacy APIはこの検証の対象外');
  });

  it('DOM切替の往復で同じノード・入力・選択範囲・カウンター・角度を保つ', () => {
    native(); render(<PerspectiveProbe />); flushFrame();
    const root = outer(), card = inner(), input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.click(screen.getByRole('button', { name: '上のボタン 0' }));
    fireEvent.change(input, { target: { value: '保つテキスト' } });
    act(() => input.focus()); input.setSelectionRange(1, 4);
    fireEvent.click(screen.getByRole('button', { name: 'プローブをDOMへ' })); flushFrame();
    expect(outer()).toBe(root); expect(inner()).toBe(card);
    expect(root.parentElement?.tagName).toBe('DIV');
    expect(root.style.left).toBe('70px'); expect(root.style.top).toBe('24px');
    expect(root.style.transform).toBe('none');
    expect(root.hasAttribute('drawable')).toBe(false);
    expect(card.dataset.perspectiveAngle).toBe('0');
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 4]);
    fireEvent.click(screen.getByRole('button', { name: 'プローブをNativeへ' })); flushFrame();
    expect(outer()).toBe(root); expect(inner()).toBe(card);
    expect(input.value).toBe('保つテキスト');
    expect(screen.getByRole('button', { name: '上のボタン 1' })).toBeDefined();
    expect(card.dataset.perspectiveAngle).toBe('45');
    expect(root.style.transform).toBe('none');
  });

  it('入力・角度・focus・scroll・resizeで再描画し、どの場合もidleで停止する', () => {
    const api = native(); render(<PerspectiveProbe />); flushFrame();
    const checks = [
      () => fireEvent.click(screen.getByRole('button', { name: '上のボタン 0' })),
      () => fireEvent.change(screen.getByRole('textbox'), { target: { value: '再描画' } }),
      () => fireEvent.click(screen.getByRole('button', { name: '角度 45° → 平面へ' })),
      () => act(() => screen.getByRole('textbox').focus()),
      () => fireEvent.scroll(screen.getByLabelText('遠近プローブのスクロール領域')),
      () => act(() => resize([], {} as ResizeObserver)),
      () => fireEvent(window, new Event('resize')),
    ];
    for (const check of checks) {
      const before = api.drawElementImage.mock.calls.length;
      check(); expect(frames.size).toBe(1); flushFrame();
      expect(api.drawElementImage.mock.calls.length).toBe(before + 1);
      expect(frames.size).toBe(0);
    }
  });

  it.each(['draw', 'request', 'watchdog'])('%s失敗なら同じDOMへ退避して操作を続けられる', failure => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    native({ fail: failure === 'draw', requestFail: failure === 'request', respond: failure !== 'watchdog' });
    render(<PerspectiveProbe />);
    const root = outer(), input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '退避する値' } });
    flushFrame();
    if (failure === 'watchdog') act(() => vi.advanceTimersByTime(2500));
    expect(document.querySelector('canvas')!.hidden).toBe(true);
    expect(outer()).toBe(root); expect(root.hasAttribute('drawable')).toBe(false);
    expect(root.style.transform).toBe('none');
    expect(input.value).toBe('退避する値');
    fireEvent.click(screen.getByRole('button', { name: '下のボタン 0' })); flushFrame();
    expect(screen.getByRole('button', { name: '下のボタン 1' })).toBeDefined();
    expect(frames.size).toBe(0);
  });

  it('成功後のpaint途絶もwatchdogで回復する', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const api = native(); render(<PerspectiveProbe />); flushFrame();
    expect(vi.getTimerCount()).toBe(0);
    api.requestPaint.mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: '上のボタン 0' })); flushFrame();
    act(() => vi.advanceTimersByTime(2500));
    expect(screen.getByRole('status').textContent).toContain('paint応答なし');
  });

  it('SSRとhydrationで不一致を作らず、一つのportalだけを接続する', async () => {
    const browserDocument = document;
    let html: string;
    try { vi.stubGlobal('document', undefined); html = renderToString(<PerspectiveProbe />); }
    finally { vi.stubGlobal('document', browserDocument); }
    const container = document.createElement('div'); container.innerHTML = html;
    document.body.appendChild(container);
    const onRecoverableError = vi.fn(); let root: Root | undefined;
    try {
      await act(async () => { root = hydrateRoot(container, <PerspectiveProbe />, { onRecoverableError }); });
      flushFrame();
      expect(onRecoverableError).not.toHaveBeenCalled();
      expect(document.querySelectorAll('[data-perspective-root]').length).toBe(1);
      fireEvent.click(screen.getByRole('button', { name: '中央のボタン 0' }));
      expect(screen.getByRole('button', { name: '中央のボタン 1' })).toBeDefined();
    } finally { act(() => root?.unmount()); container.remove(); }
  });

  it('unmount時に未処理のframeとwatchdogを破棄する', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); native({ respond: false });
    const { unmount } = render(<PerspectiveProbe />); flushFrame();
    fireEvent.scroll(screen.getByLabelText('遠近プローブのスクロール領域'));
    expect(frames.size).toBe(1); expect(vi.getTimerCount()).toBe(1);
    unmount(); expect(frames.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
});
