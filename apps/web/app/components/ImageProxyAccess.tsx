"use client";

import type { useCanvasImageSession } from '../hooks/useCanvasImageSession';

type Access = ReturnType<typeof useCanvasImageSession>;
/** サーバー画像配信の確認署名であり、Nostr投稿ではないことを操作前に示す。 */
export function ImageProxyAccess({ access }: { access: Access }) {
  return <section aria-label="画像配信の本人確認" className="border-b bg-violet-50 px-4 py-2 text-sm text-violet-950 dark:bg-violet-950 dark:text-violet-100">
    {access.nativeImagesEnabled ? <button type="button" onClick={() => void access.revoke()} className="rounded border px-3 py-1">画像エフェクトを停止して本人確認を解除</button> : <>
      <p>画像を安全に配信するため、署名器で本人確認します。この署名はリレーへ投稿されません。</p>
      <button type="button" disabled={access.pending} onClick={() => void access.authorize()} className="mt-1 rounded border px-3 py-1 disabled:opacity-50">{access.pending ? '本人確認中…' : '本人確認して画像エフェクトを有効にする'}</button>
    </>}
    {access.message && <p role="status" className="mt-1">{access.message}</p>}
  </section>;
}
