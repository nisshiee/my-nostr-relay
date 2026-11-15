"use client";

import { createContext, useContext, useEffect, useState, type ImgHTMLAttributes, type ReactNode } from 'react';
import NextImage, { type ImageProps } from 'next/image';
import { canvasImageWidth, CANVAS_IMAGE_QUALITY, validateCanvasImageSource } from '../lib/canvasImagePolicy';

import { canvasImageLoader, type CanvasImageLoad } from '../lib/canvasImageLoader';

export type CanvasImageMode = "dom" | "proxy" | "cors";
const CanvasImageContext = createContext<CanvasImageMode>("dom");
/** 画像取得方式は描画方式と独立。通常は従来のgate、実験は明示されたCORS方式を使う。 */
export function CanvasImageProvider({ children, enabled = true, mode }: { children: ReactNode; enabled?: boolean; mode?: CanvasImageMode }) {
  return <CanvasImageContext.Provider value={mode ?? (enabled ? "proxy" : "dom")}>{children}</CanvasImageContext.Provider>;
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
  if (!checked.allowed || failed || !ready) return <ImagePlaceholder {...props}
    reason={!checked.allowed ? checked.reason : state.status === 'loading' && !failed ? '画像を読み込み中' : state.status === 'disabled' ? '画像配信は現在無効です' : '画像を取得できませんでした'} />;
  return <CanvasBitmap {...props} src={ready} onError={event => { setFailed(true); props.onError?.(event); }} />;
}



/** 成功通知とsrcSetの抑止は両取得方式で共有する。 */
function CanvasBitmap(props: ImgHTMLAttributes<HTMLImageElement>) {
  // eslint-disable-next-line @next/next/no-img-element -- proxyまたはanonymous CORSで取得するURLを直接描画する
  return <img {...props} alt={props.alt ?? ''} srcSet={undefined} onLoad={event => {
    event.currentTarget.dispatchEvent(new CustomEvent('canvas-image-ready', { bubbles: true }));
    props.onLoad?.(event);
  }} />;
}

function ImagePlaceholder({ reason, label = '画像未対応', ...props }: MediaImageProps & { reason: string; label?: string }) {
  return <span role="img" aria-label={props.alt || '画像'} title={reason} className={props.className}
    style={{ ...props.style, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', background: '#e4e4e7', color: '#52525b', fontSize: 11, width: props.width ?? props.style?.width, height: props.height ?? props.style?.height }}
  >{props.width ? (label === '画像未対応' ? props.alt?.charAt(0) || '▧' : '▧') : label}</span>;
}

/** ブラウザのCORS判定をそのまま観測し、proxyやno-corsへ再試行しない。 */
function CorsImage({ src, ...props }: Omit<MediaImageProps, 'imageSize'>) {
  const [failed, setFailed] = useState(false);
  const checked = validateCanvasImageSource(typeof src === 'string' ? src : '', 'cors');
  if (!checked.allowed || failed) return <ImagePlaceholder {...props} label="CORS画像を取得できません"
    reason={!checked.allowed ? checked.reason : 'CORS画像の取得失敗（CORS不許可・通信失敗・画像形式など）'} />;
  return <CanvasBitmap {...props} crossOrigin="anonymous" referrerPolicy="no-referrer" src={checked.url}
    onError={event => { setFailed(true); props.onError?.(event); }} />;
}

function CanvasImage({ mode, ...props }: MediaImageProps & { mode: Exclude<CanvasImageMode, 'dom'> }) {
  const { imageSize, ...imageProps } = props;
  const key = `${mode}:${typeof props.src === 'string' ? props.src : 'non-url'}`;
  return mode === 'cors' ? <CorsImage key={key} {...imageProps} /> : <OptimizedCanvasImage key={key} {...imageProps} imageSize={imageSize} />;
}

/** 通常imgを使う本文・preview・絵文字向け。 */
export function MediaImage({ imageSize, ...props }: MediaImageProps) {
  const canvas = useContext(CanvasImageContext);
  // eslint-disable-next-line @next/next/no-img-element -- DOM互換表示では通常のimgを使う
  if (canvas === "dom") return <img {...props} alt={props.alt ?? ''} />;
  return <CanvasImage mode={canvas} {...props} imageSize={imageSize} />;
}

/** 既存next/imageアバター向け。DOM互換表示ではunoptimized等の既存propsを維持する。 */
export default function CanvasAwareImage(props: ImageProps) {
  const canvas = useContext(CanvasImageContext);
  if (canvas === "dom") return <NextImage {...props} />;
  const source = typeof props.src === 'string' ? props.src : '';
  return <CanvasImage mode={canvas} src={source}
    alt={props.alt} width={props.width} height={props.height} className={props.className}
    style={props.fill ? { position: 'absolute', height: '100%', width: '100%', left: 0, top: 0, right: 0, bottom: 0, ...props.style } : props.style} title={props.title} loading={props.loading}
    onLoad={props.onLoad} onError={props.onError} onClick={props.onClick}
    imageSize={Number(props.width || 32) * 2} />;
}
