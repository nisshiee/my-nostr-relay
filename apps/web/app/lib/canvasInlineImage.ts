export const CANVAS_INLINE_MAX_BYTES = 2 * 1024 * 1024;
const prefix = /^data:image\/(jpeg|png|webp|avif);base64,/;

/** client側の構文・容量検査。実際の画像形式と画素数はserverで再検査する。 */
export function normalizeCanvasInlineImage(source: string): string | null {
  if (source.length > Math.ceil(CANVAS_INLINE_MAX_BYTES / 3) * 4 + 32) return null;
  const match = prefix.exec(source);
  if (!match) return null;
  // コピー時に混ざるASCII空白だけ除去し、URLdecode等の修復はしない。
  const body = source.slice(match[0].length).replace(/[\t\n\f\r ]/g, '');
  if (!body.length || body.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(body)) return null;
  const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
  if (body.slice(0, body.length - padding).includes('=')) return null;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  // 非正規な末尾bitを許可せず、同一データの表現を一意にする。
  if (padding === 2 && (alphabet.indexOf(body.at(-3)!) & 15) !== 0) return null;
  if (padding === 1 && (alphabet.indexOf(body.at(-2)!) & 3) !== 0) return null;
  const bytes = body.length / 4 * 3 - padding;
  return bytes > 0 && bytes <= CANVAS_INLINE_MAX_BYTES ? match[0] + body : null;
}

export function isAllowedCanvasInlineImage(source: string): boolean {
  return normalizeCanvasInlineImage(source) !== null;
}
