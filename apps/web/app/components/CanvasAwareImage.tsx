"use client";

import { createContext, useContext, useEffect, useState, type ImgHTMLAttributes, type ReactNode } from 'react';
import NextImage, { type ImageProps } from 'next/image';
import { canvasImageWidth, CANVAS_IMAGE_QUALITY, validateCanvasImageSource } from '../lib/canvasImagePolicy';

import { canvasImageLoader, type CanvasImageLoad } from '../lib/canvasImageLoader';

const CanvasImageContext = createContext(false);
/** V1は元の画像表示を維持し、V2のカード内だけ同一origin配信を使う。 */
export function CanvasImageProvider({ children }: { children: ReactNode }) {
  return <CanvasImageContext.Provider value>{children}</CanvasImageContext.Provider>;
}

type MediaImageProps = ImgHTMLAttributes<HTMLImageElement> & { imageSize?: number };
function OptimizedCanvasImage({ src, imageSize = 640, ...props }: MediaImageProps) {
  const [failed, setFailed] = useState(false);
  const checked = validateCanvasImageSource(typeof src === 'string' ? src : '');
  const url = checked.allowed ? checked.local || checked.inline ? checked.url : `/api/canvas-image?url=${encodeURIComponent(checked.url)}&w=${canvasImageWidth(imageSize)}&q=${CANVAS_IMAGE_QUALITY}` : '';
  const width = canvasImageWidth(imageSize);
  const identity = `${width}:${url}`;
  const [loaded, setLoaded] = useState<{ source: string; state: CanvasImageLoad }>();
  useEffect(() => {
    if (!url || url === '/icon.svg') return;
    return canvasImageLoader.subscribe(url.startsWith('data:') ? { data: url, width } : url, state => setLoaded({ source: identity, state }));
  }, [url, width, identity]);
  const state = loaded?.source === identity ? loaded.state : { status: 'loading' as const };
  const ready = url === '/icon.svg' ? url : state.status === 'ready' ? state.url : undefined;
  if (!checked.allowed || failed || !ready) return <span
    role="img" aria-label={props.alt || '画像'}
    title={!checked.allowed ? checked.reason : state.status === 'loading' && !failed ? '画像を読み込み中' : state.status === 'disabled' ? '画像配信は現在無効です' : '画像を取得できませんでした'}
    className={props.className}
    style={{ ...props.style, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', background: '#e4e4e7', color: '#52525b', fontSize: 11, width: props.width, height: props.height }}
  >{props.width ? (props.alt?.charAt(0) || '▧') : '画像未対応'}</span>;
  // eslint-disable-next-line @next/next/no-img-element -- 安全取得routeの同一origin URLを固定サイズで利用する
  return <img {...props} alt={props.alt ?? ''} srcSet={undefined} src={ready} onLoad={event => { event.currentTarget.dispatchEvent(new CustomEvent('canvas-image-ready', { bubbles: true })); props.onLoad?.(event); }} onError={event => { setFailed(true); props.onError?.(event); }} />;
}

/** 通常imgを使う本文・preview・絵文字向け。 */
export function MediaImage({ imageSize, ...props }: MediaImageProps) {
  const canvas = useContext(CanvasImageContext);
  // eslint-disable-next-line @next/next/no-img-element -- V1の既存img挙動を変更しない
  if (!canvas) return <img {...props} alt={props.alt ?? ''} />;
  return <OptimizedCanvasImage key={typeof props.src === 'string' ? props.src : 'non-url'} {...props} imageSize={imageSize} />;
}

/** 既存next/imageアバター向け。V1ではunoptimized等の既存propsを変更しない。 */
export default function CanvasAwareImage(props: ImageProps) {
  const canvas = useContext(CanvasImageContext);
  if (!canvas) return <NextImage {...props} />;
  const source = typeof props.src === 'string' ? props.src : '';
  return <OptimizedCanvasImage key={source} src={source}
    alt={props.alt} width={props.width} height={props.height} className={props.className}
    style={props.style} title={props.title} loading={props.loading}
    onLoad={props.onLoad} onError={props.onError} onClick={props.onClick}
    imageSize={Number(props.width || 32) * 2} />;
}
