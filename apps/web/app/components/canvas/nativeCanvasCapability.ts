"use client";

import { useSyncExternalStore } from 'react';

/** 未接続canvasでAPIだけ確認する。描画・署名・通信は行わず、作成contextを解放する。 */
export function detectNativeCanvasCapability(): boolean {
  if (typeof document === 'undefined') return false;
  let gl: WebGL2RenderingContext | null = null;
  try {
    const canvas = document.createElement('canvas');
    gl = canvas.getContext('webgl2');
    const texture = gl as WebGL2RenderingContext & { texElementSubImage2D?: unknown } | null;
    const surface = canvas as HTMLCanvasElement & { requestPaint?: unknown; updateElementGeometry?: unknown; clearElementGeometry?: unknown; getElementImageDefaultSize?: unknown };
    return !!texture && typeof texture.texElementSubImage2D === 'function' && 'content' in canvas &&
      typeof surface.requestPaint === 'function' && typeof surface.updateElementGeometry === 'function' &&
      typeof surface.clearElementGeometry === 'function' && typeof surface.getElementImageDefaultSize === 'function';
  } catch { return false; }
  finally { try { gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* 解放APIが利用できない実装も非対応判定を妨げない。 */ } }
}
let capable: boolean | undefined;
const snapshot = () => capable ?? false;
const serverSnapshot = () => false;
const subscribe = (notify: () => void) => {
  let alive = true;
  if (capable === undefined) { capable = detectNativeCanvasCapability(); queueMicrotask(() => { if (alive) notify(); }); }
  return () => { alive = false; };
};
/** SSR/初回hydrationはfalse。初回subscribe後の独立能力検査を全Homeで共有する。 */
export function useNativeCanvasCapability(): boolean { return useSyncExternalStore(subscribe, snapshot, serverSnapshot); }
