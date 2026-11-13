import 'server-only';
import { getImageAuthConfig, authorizeImageRequest } from './canvasImageAuth';

export type CanvasImageAccessMode = 'disabled' | 'preview' | 'owner';
/** server設定だけから選択。Preview例外をowner公開経路へ流用しない。 */
export function getCanvasImageAccessMode(): CanvasImageAccessMode {
  if (process.env.CANVAS_IMAGE_PROXY_ENABLED !== '1') return 'disabled';
  if (process.env.CANVAS_IMAGE_PROXY_SCOPE === 'owner-auth') return getImageAuthConfig() ? 'owner' : 'disabled';
  if (process.env.CANVAS_IMAGE_PROXY_SCOPE !== 'protected-preview') return 'disabled';
  return [process.env.VERCEL_ENV, process.env.VERCEL_TARGET_ENV].every(
    value => !value || value === 'preview' || value === 'development',
  ) ? 'preview' : 'disabled';
}
export function isCanvasImageProxyEnabled(): boolean { return getCanvasImageAccessMode() !== 'disabled'; }
/** 本文・cache・DNSへ入る前と応答直前に毎回検証する。 */
export function canvasImageAccessStatus(request: Request): 200 | 401 | 503 {
  const mode = getCanvasImageAccessMode();
  return mode === 'disabled' ? 503 : mode === 'preview' || authorizeImageRequest(request) ? 200 : 401;
}
