// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CanvasAwareImage, { CanvasImageProvider, MediaImage } from '../CanvasAwareImage';

import { canvasImageLoader } from '../../lib/canvasImageLoader';
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(['image'], { type: 'image/png' }) })));
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:canvas-image') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); canvasImageLoader.dispose(); vi.unstubAllGlobals(); });
const source = 'https://i.gyazo.com/avatar.png';
describe('Canvas画像の同一origin配信', () => {
  it('配信gate無効時は通常画像へ戻しproxy要求を作らない', () => {
    render(<CanvasImageProvider enabled={false}><MediaImage alt="互換画像" src={source} /><CanvasAwareImage alt="互換avatar" src={source} width={32} height={32} unoptimized /></CanvasImageProvider>);
    expect(screen.getByAltText('互換画像').getAttribute('src')).toBe(source);
    expect(screen.getByAltText('互換avatar').getAttribute('src')).toBe(source);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('DOM互換表示のimgとunoptimizedアバターは元URLのまま', () => {
    render(<><MediaImage alt="本文" src={source} /><CanvasAwareImage alt="本人" src={source} width={32} height={32} unoptimized /></>);
    for (const image of screen.getAllByRole('img')) expect(image.getAttribute('src')).toBe(source);
  });
  it('認証付き描画はアバター/本文/emojiを固定幅の安全取得routeへ送る', async () => {
    render(<CanvasImageProvider>
      <CanvasAwareImage alt="本人" src={source} width={32} height={32} unoptimized />
      <MediaImage alt="本文" src={source} srcSet="https://outside.test/leak.png 2x" />
      <MediaImage alt="絵文字" src={source} imageSize={64} />
    </CanvasImageProvider>);
    await waitFor(() => expect(screen.getByAltText('本人').getAttribute('src')).toBe('blob:canvas-image'));
    expect(fetch).toHaveBeenCalledWith(`/api/canvas-image?url=${encodeURIComponent(source)}&w=64&q=75`, expect.objectContaining({ credentials: 'same-origin' }));
    expect(fetch).toHaveBeenCalledWith(`/api/canvas-image?url=${encodeURIComponent(source)}&w=640&q=75`, expect.anything());
    expect(screen.getByAltText('本文').getAttribute('srcset')).toBeNull();
    expect(screen.getByAltText('絵文字').getAttribute('src')).toBe('blob:canvas-image');
  });
  it('Canvas inline raster is POSTed and rendered only as a returned blob', async () => {
    const data = 'data:image/png;base64,aGVsbG8=';
    render(<CanvasImageProvider><MediaImage src={data} alt="inline" imageSize={40} srcSet="data:image/png;base64,aA== 2x" /></CanvasImageProvider>);
    await waitFor(() => expect(screen.getByAltText('inline').getAttribute('src')).toBe('blob:canvas-image'));
    expect(screen.getByAltText('inline').getAttribute('srcset')).toBeNull();
    expect(fetch).toHaveBeenCalledWith('/api/canvas-image', expect.objectContaining({ method: 'POST', body: JSON.stringify({ data, width: 64 }) }));
  });
  it('query付き/IP/SVGはリクエストを作らず理由付きplaceholderにする', () => {
    const { container } = render(<CanvasImageProvider>
      <MediaImage alt="秘密" src={`${source}?token=secret`} />
      <MediaImage alt="未対応" src="https://127.0.0.1/avatar.png" />
      <CanvasAwareImage alt="SVG" src="https://i.gyazo.com/avatar.svg" width={32} height={32} unoptimized />
    </CanvasImageProvider>);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(screen.getByRole('img', { name: '秘密' }).title).toContain('query');
    expect(screen.getByRole('img', { name: 'SVG' }).title).toContain('SVG');
  });
  it('取得失敗で元外部URLへfallbackせず、URL更新時だけ再試行する', async () => {
    const { rerender } = render(<CanvasImageProvider><MediaImage alt="本人" src={source} /></CanvasImageProvider>);
    await waitFor(() => expect(screen.getByAltText('本人').tagName).toBe('IMG'));
    fireEvent.error(screen.getByAltText('本人'));
    expect(screen.getByRole('img', { name: '本人' }).tagName).toBe('SPAN');
    expect(document.querySelector('img')).toBeNull();
    rerender(<CanvasImageProvider><MediaImage alt="本人" src="https://i.gyazo.com/new.png" /></CanvasImageProvider>);
    await waitFor(() => expect(screen.getByAltText('本人').tagName).toBe('IMG'));
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('new.png'), expect.anything());
  });
});


describe('CORS直接取得実験', () => {
  const direct = 'https://images.example.test/fixture.svg?variant=synthetic';
  it('本文・avatar・emojiでanonymousを強制しproxyやsrcSetを使わない', () => {
    render(<CanvasImageProvider mode="cors" enabled={false}>
      <MediaImage alt="CORS本文" src={direct} srcSet="https://images.example.test/other.png 2x" crossOrigin="use-credentials" referrerPolicy="unsafe-url" />
      <CanvasAwareImage alt="CORSavatar" src={direct} width={32} height={32} />
      <MediaImage alt="CORSemoji" src={direct} imageSize={64} />
    </CanvasImageProvider>);
    for (const image of screen.getAllByRole('img')) {
      expect(image.getAttribute('src')).toBe(direct);
      expect(image.getAttribute('crossorigin')).toBe('anonymous');
      expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(image.getAttribute('srcset')).toBeNull();
      expect(image.hasAttribute('imageSize')).toBe(false);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('成功通知・失敗placeholder・同一URL再試行なし・URL変更による回復', () => {
    const onLoad = vi.fn(); const onError = vi.fn(); const ready = vi.fn();
    const app = (src: string) => <CanvasImageProvider mode="cors"><div onClick={() => {}}><MediaImage src={src} alt="CORS画像" onLoad={onLoad} onError={onError} /></div></CanvasImageProvider>;
    const view = render(app(direct)); view.container.addEventListener('canvas-image-ready', ready);
    fireEvent.load(screen.getByAltText('CORS画像'));
    expect(ready).toHaveBeenCalledOnce(); expect(onLoad).toHaveBeenCalledOnce();
    fireEvent.error(screen.getByAltText('CORS画像'));
    expect(onError).toHaveBeenCalledOnce();
    expect(screen.getByRole('img', { name: 'CORS画像' }).title).toContain('CORS不許可・通信失敗');
    view.rerender(app(direct)); expect(view.container.querySelector('img')).toBeNull();
    view.rerender(app('https://images.example.test/new.png'));
    expect(screen.getByAltText('CORS画像').getAttribute('crossorigin')).toBe('anonymous');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('非HTTPSの拒否はCORS通信失敗と区別する', () => {
    render(<CanvasImageProvider mode="cors"><MediaImage src="http://images.example.test/fixture.png" alt="形式制限" /></CanvasImageProvider>);
    expect(screen.getByRole('img').title).toContain('HTTPS');
    expect(screen.getByRole('img').title).not.toContain('CORS不許可');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('inlineと自前iconは直接読み、proxyへPOSTしない', () => {
    render(<CanvasImageProvider mode="cors"><MediaImage src="data:image/png;base64,aGVsbG8=" alt="inline" /><MediaImage src="/icon.svg" alt="icon" /></CanvasImageProvider>);
    expect(screen.getByAltText('inline').getAttribute('src')).toContain('data:image/png');
    expect(screen.getByAltText('icon').getAttribute('src')).toBe('/icon.svg');
    expect(fetch).not.toHaveBeenCalled();
  });
});


it.each(['cors', 'proxy'] as const)('%sでもfill画像と失敗placeholderが親領域を埋める', async mode => {
  render(<CanvasImageProvider mode={mode}><CanvasAwareImage src="https://images.example.test/banner.png" alt="banner" fill className="object-cover" /></CanvasImageProvider>);
  await waitFor(() => expect(screen.getByRole('img', { name: 'banner' }).tagName).toBe('IMG'));
  const image = screen.getByRole('img', { name: 'banner' });
  expect(image.style.position).toBe('absolute'); expect(image.style.width).toBe('100%'); expect(image.style.height).toBe('100%');
  fireEvent.error(image);
  const fallback = screen.getByRole('img', { name: 'banner' });
  expect(fallback.tagName).toBe('SPAN'); expect(fallback.style.position).toBe('absolute'); expect(fallback.style.width).toBe('100%'); expect(fallback.style.height).toBe('100%');
});
