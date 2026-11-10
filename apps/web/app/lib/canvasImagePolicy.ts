import { isAllowedCanvasInlineImage } from './canvasInlineImage';
import { hasAllowedPublicImageQuery } from './publicImageQuery';

/** client側の形式検査。公開IPの判定は必ずserver接続時にも行う。 */
export const CANVAS_IMAGE_WIDTHS = [32, 64, 128, 640, 1280] as const;
export const CANVAS_IMAGE_QUALITY = 75;

export type CanvasImageSource = { allowed: true; url: string; local: boolean; inline?: true } | { allowed: false; reason: string };
export function validateCanvasImageSource(source: string): CanvasImageSource {
  // 自前のアイコンだけは最適化不要の同一origin画像として扱う。
  if (source === '/icon.svg') return { allowed: true, url: source, local: true };
  if (source.startsWith('data:')) return isAllowedCanvasInlineImage(source)
    ? { allowed: true, url: source, local: false, inline: true }
    : { allowed: false, reason: '埋め込み画像は2MiB以下のJPEG・PNG・WebP・AVIF（base64）のみ対応しています' };
  let url: URL;
  try { url = new URL(source); } catch { return { allowed: false, reason: '画像URLが不正です' }; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return { allowed: false, reason: '公開HTTPS画像のみ対応しています' };
  if (source.length > 2048 || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.startsWith('[') || /^[0-9.]+$/.test(url.hostname)) return { allowed: false, reason: '公開hostnameの画像のみ対応しています' };
  if ((source.includes('?') && !url.search) || !hasAllowedPublicImageQuery(url) || source.includes('#')) return { allowed: false, reason: '認証情報の転送を避けるためこのquery付き画像は未対応です' };
  if (/\.svg(?:z)?$/i.test(url.pathname)) return { allowed: false, reason: '外部SVG画像はV2では未対応です' };
  return { allowed: true, url: url.href, local: false };
}

export function canvasImageWidth(requested: number): number {
  return CANVAS_IMAGE_WIDTHS.find(width => width >= requested) ?? CANVAS_IMAGE_WIDTHS[CANVAS_IMAGE_WIDTHS.length - 1];
}
