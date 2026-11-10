/** 実フィードで確認した公開画像hostだけを許可する。任意hostのproxyにはしない。 */
export const CANVAS_IMAGE_HOSTS = [
  'share.yabu.me',
  'i.gyazo.com',
  '0.gravatar.com',
  'cdn.nostrcheck.me',
  'i.floppy.media',
] as const;
export const CANVAS_IMAGE_WIDTHS = [32, 64, 128, 640, 1280] as const;
export const CANVAS_IMAGE_QUALITY = 75;

export type CanvasImageSource = { allowed: true; url: string; local: boolean } | { allowed: false; reason: string };
export function validateCanvasImageSource(source: string): CanvasImageSource {
  // 自前のアイコンだけは最適化不要の同一origin画像として扱う。
  if (source === '/icon.svg') return { allowed: true, url: source, local: true };
  let url: URL;
  try { url = new URL(source); } catch { return { allowed: false, reason: '画像URLが不正です' }; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return { allowed: false, reason: '公開HTTPS画像のみ対応しています' };
  if (!(CANVAS_IMAGE_HOSTS as readonly string[]).includes(url.hostname)) return { allowed: false, reason: 'この画像hostはV2の許可対象外です' };
  if (url.search || url.hash) return { allowed: false, reason: '認証情報の転送を避けるためquery付き画像は未対応です' };
  if (/\.svg(?:z)?$/i.test(url.pathname)) return { allowed: false, reason: '外部SVG画像はV2では未対応です' };
  return { allowed: true, url: url.href, local: false };
}

export function canvasImageWidth(requested: number): number {
  return CANVAS_IMAGE_WIDTHS.find(width => width >= requested) ?? CANVAS_IMAGE_WIDTHS[CANVAS_IMAGE_WIDTHS.length - 1];
}
