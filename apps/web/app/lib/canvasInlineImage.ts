export const CANVAS_INLINE_MAX_BYTES = 2 * 1024 * 1024;
const prefix = /^data:image\/(jpeg|png|webp|avif);base64,/;

/** client側の構文・容量検査。実際の画像形式と画素数はserverで再検査する。 */
export function isAllowedCanvasInlineImage(source: string): boolean {
  if (source.length > Math.ceil(CANVAS_INLINE_MAX_BYTES / 3) * 4 + 32) return false;
  const match = prefix.exec(source);
  if (!match) return false;
  const body = source.slice(match[0].length);
  if (!body.length || body.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(body)) return false;
  const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
  if (body.slice(0, body.length - padding).includes('=')) return false;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  // 非正規な末尾bitを許可せず、同一データの表現を一意にする。
  if (padding === 2 && (alphabet.indexOf(body.at(-3)!) & 15) !== 0) return false;
  if (padding === 1 && (alphabet.indexOf(body.at(-2)!) & 3) !== 0) return false;
  const bytes = body.length / 4 * 3 - padding;
  return bytes > 0 && bytes <= CANVAS_INLINE_MAX_BYTES;
}
