"use client";

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isVideoUrl } from '../../lib/videoPolicy';

interface Props { url: string; onHold?: () => void; onRelease?: () => void }

/** 閉じる・URL切替・カード削除のすべてで取得と再生を停止する。 */
function VideoDialog({ url, onClose }: { url: string; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    const video = videoRef.current;
    // StrictModeの再setupでもcleanupで外したsrcを復元する。
    if (video && !video.hasAttribute('src')) video.src = url;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    return () => {
      if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [url]);
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 p-4"
      onClick={event => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="動画再生" tabIndex={-1}
        className="relative flex max-h-[95vh] w-full max-w-5xl flex-col gap-3 rounded-lg bg-zinc-950 p-4 text-white"
        onKeyDown={event => {
          event.stopPropagation();
          if (event.key === 'Escape') { event.preventDefault(); onClose(); }
          if (event.key === 'Tab') {
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, a, video'));
            const first = items[0], last = items[items.length - 1];
            if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { event.preventDefault(); first?.focus(); }
          }
        }}>
        <button type="button" onClick={onClose} className="self-end rounded px-3 py-2" aria-label="動画を閉じる">閉じる ✕</button>
        {failed ? <p role="alert">動画を再生できません。配信元や動画形式を確認するか、元のリンクを開いてください。</p> :
          <video ref={videoRef} src={url} controls playsInline autoPlay preload="none" tabIndex={0}
            className="max-h-[75vh] w-full" aria-label="投稿動画"
            onError={() => { const video = videoRef.current; video?.pause(); if (video) { video.removeAttribute('src'); video.load(); } setFailed(true); }} />}
        <a href={url} target="_blank" rel="noopener noreferrer" className="underline">元の動画を開く</a>
      </div>
    </div>, document.body);
}

/** カード内には静止ボタンのみ。クリックまではvideo・poster・外部取得を作らない。 */
export function VideoNode(props: Props) {
  // URL切替時は開閉状態ごと破棄し、古い動画を確実に停止する。
  return <VideoNodeForUrl key={props.url} {...props} />;
}
function VideoNodeForUrl({ url, onHold, onRelease }: Props) {
  const [open, setOpen] = useState(false);
  const release = useRef(onRelease);
  const hold = useRef(onHold);
  useEffect(() => { release.current = onRelease; hold.current = onHold; }, [onRelease, onHold]);
  useEffect(() => {
    if (!open) return;
    hold.current?.();
    return () => release.current?.();
  }, [open]);
  if (!isVideoUrl(url)) return null;
  return <>
    <button type="button" className="my-2 flex w-full items-center justify-center gap-2 rounded-lg bg-zinc-200 px-4 py-8 text-zinc-900 dark:bg-zinc-700 dark:text-white"
      onClick={event => { event.stopPropagation(); if (!open) { setOpen(true); } }} aria-label="動画を再生">▶ 動画を再生</button>
    {open && <VideoDialog url={url} onClose={() => setOpen(false)} />}
  </>;
}
