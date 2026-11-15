"use client";
import { useState, type ImgHTMLAttributes } from 'react';
import type { ImageProps } from 'next/image';
import { validateCanvasImageSource } from '../lib/canvasImagePolicy';
type MediaImageProps = ImgHTMLAttributes<HTMLImageElement>;

/** 成功通知とsrcSetの抑止は全画像で共有する。 */
function CanvasBitmap(props: ImgHTMLAttributes<HTMLImageElement>) {
  // eslint-disable-next-line @next/next/no-img-element -- anonymous CORSで取得するURLを直接描画する
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
function CorsImage({ src, ...props }: MediaImageProps) {
  const [failed, setFailed] = useState(false);
  const checked = validateCanvasImageSource(typeof src === 'string' ? src : '');
  if (!checked.allowed || failed) return <ImagePlaceholder {...props} label="CORS画像を取得できません"
    reason={!checked.allowed ? checked.reason : 'CORS画像の取得失敗（CORS不許可・通信失敗・画像形式など）'} />;
  return <CanvasBitmap {...props} crossOrigin="anonymous" referrerPolicy="no-referrer" src={checked.url}
    onError={event => { setFailed(true); props.onError?.(event); }} />;
}

/** 描画方式と独立した共通取得。URL変更時だけ失敗状態をリセットする。 */
export function MediaImage(props: MediaImageProps) {
  return <CorsImage key={typeof props.src === 'string' ? props.src : 'non-url'} {...props} />;
}

/** next/image形式の既存呼出しも共通の直接取得へ変換する。 */
export default function CanvasAwareImage(props: ImageProps) {
  const source = typeof props.src === 'string' ? props.src : 'src' in props.src ? props.src.src : props.src.default.src;
  return <MediaImage src={source} alt={props.alt} width={props.width} height={props.height} className={props.className}
    style={props.fill ? { position: 'absolute', height: '100%', width: '100%', left: 0, top: 0, right: 0, bottom: 0, ...props.style } : props.style} title={props.title} loading={props.loading}
    onLoad={props.onLoad} onError={props.onError} onClick={props.onClick} />;
}
