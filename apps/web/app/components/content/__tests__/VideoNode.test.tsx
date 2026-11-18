// @vitest-environment jsdom
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoNode } from '../VideoNode';
import { ContentRenderer } from '../ContentRenderer';
import { parseContent } from '../../../lib/contentParser';
import { isVideoUrl } from '../../../lib/videoPolicy';

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.style.overflow = ''; });

describe('動画URLと表示', () => {
  it('HTTPS直接動画だけを受け入れ、未許可動画はOGPにしない', () => {
    for (const url of ['https://example.com/a.mp4', 'https://example.com/a.WEBM?x=1#t=2']) expect(isVideoUrl(url)).toBe(true);
    for (const url of ['http://example.com/a.mp4', 'https://localhost/a.mp4', 'https://127.0.0.1/a.mp4', 'https://user:pass@example.com/a.mp4', 'https://example.com:444/a.mp4', 'https://example.com/a.mp4/path', 'data:video/mp4;base64,AAAA', 'https://example.com/a.m3u8']) expect(isVideoUrl(url)).toBe(false);
    const parsed = parseContent('動画 https://example.com/a.MP4?x=1。 https://example.com/a.webm http://example.com/no.mp4 https://example.com/page');
    expect(parsed.filter(n => n.type === 'video')).toHaveLength(2);
    expect(parseContent('https://example.com/a.mp4?poster=thumb.jpg')[0].type).toBe('video');
    expect(parseContent('http://example.com/a.mp4?poster=thumb.jpg')[0].type).toBe('link');
    expect(parsed.find(n => 'url' in n && n.url === 'http://example.com/no.mp4')?.type).toBe('link');
    expect(parsed.filter(n => n.type === 'linkPreview')).toHaveLength(1);
  });
  it('StrictModeでも開いた動画srcが保持される', () => {
    render(<StrictMode><VideoNode url="https://example.com/a.mp4" /></StrictMode>);
    fireEvent.click(screen.getByRole('button', { name: '動画を再生' }));
    expect(document.querySelector('video')?.getAttribute('src')).toBe('https://example.com/a.mp4');
  });
  it('カード内に動画やposterを作らず、画像と混在できる', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const { container } = render(<ContentRenderer content={'https://example.com/a.mp4\nhttps://example.com/b.jpg'} />);
    expect(screen.getByRole('button', { name: '動画を再生' })).toBeTruthy();
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('img')?.src).toBe('https://example.com/b.jpg');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('開閉で停止、src解除、hold解放とfocus/scroll復帰', () => {
    const hold = vi.fn(), release = vi.fn(); document.body.style.overflow = 'clip';
    render(<VideoNode url="https://example.com/a.mp4" onHold={hold} onRelease={release} />);
    const trigger = screen.getByRole('button', { name: '動画を再生' }); trigger.focus(); fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: '動画再生' });
    const video = dialog.querySelector('video')!;
    expect(video.src).toBe('https://example.com/a.mp4');
    expect(video.hasAttribute('crossorigin')).toBe(false);
    expect(hold).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(video.getAttribute('src')).toBeNull();
    expect(video.pause).toHaveBeenCalled(); expect(video.load).toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger); expect(document.body.style.overflow).toBe('clip');
  });
  it('再生操作では閉じず、失敗時は元リンクを残し再openで復旧', () => {
    render(<VideoNode url="https://example.com/a.webm" />);
    fireEvent.click(screen.getByRole('button', { name: '動画を再生' }));
    const video = document.querySelector('video')!; fireEvent.click(video);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.error(video);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByRole('link', { name: '元の動画を開く' }).getAttribute('href')).toBe('https://example.com/a.webm');
    expect(video.getAttribute('src')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '動画を閉じる' }));
    fireEvent.click(screen.getByRole('button', { name: '動画を再生' }));
    expect(document.querySelector('video')).not.toBeNull();
  });
  it('URL切替・カード削除でも停止し、切替先を自動取得しない', () => {
    const release = vi.fn();
    const view = render(<VideoNode url="https://example.com/a.mp4" onRelease={release} />);
    fireEvent.click(screen.getByRole('button', { name: '動画を再生' })); const old = document.querySelector('video')!;
    view.rerender(<VideoNode url="https://example.com/b.webm" onRelease={release} />);
    expect(old.getAttribute('src')).toBeNull(); expect(document.querySelector('video')).toBeNull(); expect(release).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '動画を再生' })); const next = document.querySelector('video')!;
    view.unmount(); expect(next.getAttribute('src')).toBeNull(); expect(release).toHaveBeenCalledTimes(2);
  });
});
