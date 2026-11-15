// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CanvasAwareImage, { MediaImage } from '../CanvasAwareImage';
beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('CORS直接取得実験', () => {
  const direct = 'https://images.example.test/fixture.svg?variant=synthetic';
  it('本文・avatar・emojiでanonymousを強制しproxyやsrcSetを使わない', () => {
    render(<>
      <MediaImage alt="CORS本文" src={direct} srcSet="https://images.example.test/other.png 2x" crossOrigin="use-credentials" referrerPolicy="unsafe-url" />
      <CanvasAwareImage alt="CORSavatar" src={direct} width={32} height={32} />
      <MediaImage alt="CORSemoji" src={direct} />
    </>);
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
    const app = (src: string) => <><div onClick={() => {}}><MediaImage src={src} alt="CORS画像" onLoad={onLoad} onError={onError} /></div></>;
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
    render(<><MediaImage src="http://images.example.test/fixture.png" alt="形式制限" /></>);
    expect(screen.getByRole('img').title).toContain('HTTPS');
    expect(screen.getByRole('img').title).not.toContain('CORS不許可');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('inlineと自前iconは直接読み、proxyへPOSTしない', () => {
    render(<><MediaImage src="data:image/png;base64,aGVsbG8=" alt="inline" /><MediaImage src="/icon.svg" alt="icon" /></>);
    expect(screen.getByAltText('inline').getAttribute('src')).toContain('data:image/png');
    expect(screen.getByAltText('icon').getAttribute('src')).toBe('/icon.svg');
    expect(fetch).not.toHaveBeenCalled();
  });
});


it('fill画像と失敗placeholderが親領域を埋める', async () => {
  render(<><CanvasAwareImage src="https://images.example.test/banner.png" alt="banner" fill className="object-cover" /></>);
  await waitFor(() => expect(screen.getByRole('img', { name: 'banner' }).tagName).toBe('IMG'));
  const image = screen.getByRole('img', { name: 'banner' });
  expect(image.style.position).toBe('absolute'); expect(image.style.width).toBe('100%'); expect(image.style.height).toBe('100%');
  fireEvent.error(image);
  const fallback = screen.getByRole('img', { name: 'banner' });
  expect(fallback.tagName).toBe('SPAN'); expect(fallback.style.position).toBe('absolute'); expect(fallback.style.width).toBe('100%'); expect(fallback.style.height).toBe('100%');
});

it('繰り返しURL更新・失敗・unmountで画像DOMや独自cacheを蓄積しない', () => {
 const view=render(<MediaImage alt="cycle" src="https://images.example.test/0.png"/>);
 for(let n=1;n<=200;n++) {
   view.rerender(<MediaImage alt="cycle" src={`https://images.example.test/${n}.png`}/>);
   expect(view.container.querySelectorAll('img')).toHaveLength(1);
   fireEvent.error(screen.getByAltText('cycle'));
   expect(view.container.querySelectorAll('img')).toHaveLength(0);
 }
 view.unmount(); expect(view.container.childElementCount).toBe(0); expect(fetch).not.toHaveBeenCalled();
});
