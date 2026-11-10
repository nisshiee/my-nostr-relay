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
describe('V2画像の同一origin配信', () => {
  it('V1のimgとunoptimizedアバターは元URLのまま', () => {
    render(<><MediaImage alt="本文" src={source} /><CanvasAwareImage alt="本人" src={source} width={32} height={32} unoptimized /></>);
    for (const image of screen.getAllByRole('img')) expect(image.getAttribute('src')).toBe(source);
  });
  it('V2はアバター/本文/emojiを固定幅の安全取得routeへ送る', async () => {
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
  it('V2 inline raster is POSTed and rendered only as a returned blob', async () => {
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
