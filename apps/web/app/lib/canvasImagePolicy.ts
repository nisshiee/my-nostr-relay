import { normalizeCanvasInlineImage } from './canvasInlineImage';

/** ブラウザ直接取得のURL基本形式を検査する。 */
export type CanvasImageSource = { allowed: true; url: string; local: boolean; inline?: true } | { allowed: false; reason: string };
export function validateCanvasImageSource(source: string): CanvasImageSource {
  // 自前のアイコンだけは最適化不要の同一origin画像として扱う。
  if (source === '/icon.svg') return { allowed: true, url: source, local: true };
  if (source.startsWith('data:')) {
    const inline = normalizeCanvasInlineImage(source);
    return inline
      ? { allowed: true, url: inline, local: false, inline: true }
      : { allowed: false, reason: '埋め込み画像は2MiB以下のJPEG・PNG・WebP・AVIF（base64）のみ対応しています' };
  }
  let url: URL;
  try { url = new URL(source); } catch { return { allowed: false, reason: '画像URLが不正です' }; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return { allowed: false, reason: '公開HTTPS画像のみ対応しています' };
  if (source.length > 2048 || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.startsWith('[') || /^[0-9.]+$/.test(url.hostname)) return { allowed: false, reason: '公開hostnameの画像のみ対応しています' };
  return { allowed: true, url: url.href, local: false };
}
