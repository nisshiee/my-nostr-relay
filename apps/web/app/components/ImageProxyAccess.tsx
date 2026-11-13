"use client";

import type { useCanvasImageSession } from '../hooks/useCanvasImageSession';

type Access = ReturnType<typeof useCanvasImageSession>;
/** サーバー画像配信の確認署名であり、Nostr投稿ではないことを操作前に示す。 */
export function ImageProxyAccess({ access, nativeCapable, manualDOM }: { access: Access; nativeCapable: boolean; manualDOM: boolean }) {
  return <section aria-label="画像配信の本人確認" className="mt-4 rounded bg-violet-50 px-3 py-3 text-sm text-violet-950 dark:bg-violet-950 dark:text-violet-100">
    {access.nativeImagesEnabled ? <button type="button" onClick={() => void access.revoke()} className="rounded border px-3 py-1">画像エフェクトを停止して本人確認を解除</button> : <>
      <p>画像を安全に配信するため、署名器で本人確認します。この署名はリレーへ投稿されません。</p>
      <button type="button" disabled={access.pending || !access.canAuthorize || !nativeCapable || manualDOM} onClick={() => void access.authorize()} className="mt-1 rounded border px-3 py-1 disabled:opacity-50">{access.pending ? '本人確認中…' : '画像の本人確認を再試行'}</button>
    </>}
    {!nativeCapable && <p className="mt-2">このブラウザはHTML-in-Canvasに対応していないため、本人確認は行いません。</p>}
    {manualDOM && <p className="mt-2">互換表示を選択中です。本人確認を行わず通常の画像を表示します。</p>}
    {access.message && <p role="status" className="mt-1">{access.message}</p>}
  </section>;
}
