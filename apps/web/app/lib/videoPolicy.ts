import { validateCanvasImageSource } from './canvasImagePolicy';

/** 画像と同じ公開URL境界を使い、動画はHTTPSの直接MP4/WebMだけを許可する。 */
export function isVideoUrl(source: string): boolean {
  const checked = validateCanvasImageSource(source);
  if (!checked.allowed || checked.local || checked.inline) return false;
  return hasVideoPath(checked.url);
}

/** 動画らしいURLは埋込不可でもOGP取得に回さない。 */
export function hasVideoPath(source: string): boolean {
  try { return /\.(mp4|webm)$/i.test(new URL(source).pathname); }
  catch { return false; }
}
