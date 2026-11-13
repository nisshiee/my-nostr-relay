"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { canvasImageLoader } from '../lib/canvasImageLoader';
import { signEventWithActiveSigner } from '../lib/nostrSigner';

export type CanvasImageAccessMode = 'disabled' | 'preview' | 'owner';
export const CANVAS_IMAGE_SESSION_INVALIDATED = 'canvas-image-unauthorized';
const PATH = '/api/canvas-image/auth';
interface Session { pubkey: string; expiresAt: number }
interface Status { available?: boolean; authenticated: boolean; expiresAt?: number; pubkey?: string }
const FAILURE = '画像配信の本人確認を完了できませんでした。もう一度お試しください。';

/** 署名は明示操作時だけ。認証イベントをリレーへ投稿しない。 */
export function useCanvasImageSession({ pubkey, mode }: { pubkey: string | null; mode: CanvasImageAccessMode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [pending, setPending] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [message, setMessage] = useState('');
  const [blocked, setBlocked] = useState(false);
  const [identity, setIdentity] = useState(`${mode}:${pubkey ?? ''}`);
  if (identity !== `${mode}:${pubkey ?? ''}`) {
    setIdentity(`${mode}:${pubkey ?? ''}`);setSession(null);setPending(false);setMessage('');setBlocked(false);
  }
  const generation = useRef(0);
  const busy = useRef(false);
  const verification = useRef<Promise<Response> | null>(null);
  const revocation = useRef<Promise<void> | null>(null);
  const active = useRef({ pubkey, mode });
  const previousMode = useRef<CanvasImageAccessMode | null>(null);
  useLayoutEffect(() => {
    active.current = { pubkey, mode };
    // 子画像のpassive subscribeより先に旧認証のcacheを破棄する。
    busy.current=false;
    if (previousMode.current !== 'preview' || mode !== 'preview') canvasImageLoader.invalidateAuthorization();
    previousMode.current=mode;
    return () => { active.current = { pubkey: null, mode: 'disabled' };busy.current=false; };
  }, [pubkey, mode]);
  const clear = useCallback(() => { generation.current++;busy.current=false;canvasImageLoader.invalidateAuthorization();setSession(null);setPending(false);setBlocked(true); }, []);
  const validStatus = useCallback((data: Status, key: string) => data.available !== false && data.authenticated === true && data.pubkey === key && typeof data.expiresAt === 'number' && Number.isFinite(data.expiresAt) && data.expiresAt > Date.now(), []);
  useEffect(() => {
    const id = ++generation.current;
    if (mode !== 'owner' || !pubkey || revocation.current) return;
    const controller = new AbortController();
    void fetch(PATH, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('status');
      const data = await response.json() as Status;
      if (generation.current !== id || active.current.pubkey !== pubkey || active.current.mode !== mode || revocation.current) return;
      if (validStatus(data, pubkey)) setSession({ pubkey, expiresAt: data.expiresAt! });
      else if (data.available === false) setMessage('画像配信はサーバー側で無効です。互換表示を利用します。');
      else if (data.authenticated && data.pubkey !== pubkey) setMessage('別アカウントの確認状態は利用できません。現在のアカウントで本人確認してください。');
    }).catch(() => { if (generation.current === id && !controller.signal.aborted) setMessage('画像配信は互換表示のままです。'); });
    return () => { controller.abort(); };
  }, [pubkey, mode, validStatus]);
  useEffect(() => {
    const invalidate = () => { clear();setMessage('画像配信の本人確認が失効しました。互換表示に戻しました。'); };
    window.addEventListener(CANVAS_IMAGE_SESSION_INVALIDATED, invalidate);
    return () => window.removeEventListener(CANVAS_IMAGE_SESSION_INVALIDATED, invalidate);
  }, [clear]);
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(() => { clear();setMessage('画像配信の本人確認の有効期限が切れました。'); }, Math.max(0, session.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [session, clear]);
  const authorize = useCallback(async () => {
    if (mode !== 'owner' || !pubkey || busy.current || revocation.current) return;
    busy.current=true;
    const id = ++generation.current;
    const current = () => id === generation.current && active.current.pubkey === pubkey && active.current.mode === mode;
    setPending(true);setMessage('');
    try {
      const response = await fetch(PATH, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'challenge' }) });
      if (!response.ok) throw new Error('challenge');
      const data = await response.json() as { challenge?: unknown; payload?: unknown; createdAt?: unknown; url?: unknown; method?: unknown };
      if (!current()) return;
      if (typeof data.challenge !== 'string' || typeof data.payload !== 'string' || data.payload.length > 4096 || typeof data.createdAt !== 'number' || !Number.isSafeInteger(data.createdAt) || Math.abs(data.createdAt - Date.now() / 1000) > 120 || data.method !== 'POST' || data.url !== new URL(PATH, window.location.origin).href) throw new Error('challenge');
      const parsed = JSON.parse(data.payload);
      if (!parsed || Object.keys(parsed).length !== 1 || parsed.challenge !== data.challenge) throw new Error('payload');
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data.payload));
      if (!current()) return;
      const payloadHash = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
      const event = await signEventWithActiveSigner({ kind: 27235, created_at: data.createdAt, content: '', tags: [['u', data.url], ['method', 'POST'], ['payload', payloadHash]] });
      if (!current()) return;
      if (event.pubkey !== pubkey) throw new Error('account');
      const encoded = btoa(Array.from(new TextEncoder().encode(JSON.stringify(event)), byte => String.fromCharCode(byte)).join(''));
      const request = fetch(PATH, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', Authorization: `Nostr ${encoded}` }, body: data.payload });
      verification.current = request;
      let verified: Response;
      try { verified = await request; }
      finally { if (verification.current === request) verification.current = null; }
      if (!verified.ok) {
        if (verified.status === 403 && current()) { setSession(null);setMessage('このアカウントの画像配信の本人確認は許可されませんでした。互換表示を利用します。');return; }
        throw new Error('verify');
      }
      const status = await verified.json() as Status;
      if (current()) {
        if (!validStatus(status, pubkey)) throw new Error('session');
        setBlocked(false);setSession({ pubkey, expiresAt: status.expiresAt! });setMessage('画像配信の本人確認が完了しました。');
      }
    } catch { if (current()) { setSession(null);setMessage(FAILURE); } }
    finally { if (current()) { busy.current=false;setPending(false); } }
  }, [mode, pubkey, validStatus]);
  const revoke = useCallback((): Promise<void> => {
    if (revocation.current) return revocation.current;
    clear();const id=generation.current;setRevoking(true);
    setMessage('互換表示に戻しました。サーバーの本人確認を解除しています。');
    // account変更で通常のbusyが解除されても、この解除処理が終わるまで再署名しない。
    const work = (async () => {
      try {
        // 送信済verifyのSet-Cookieより後にDELETEを送り、同一画面内の競合を避ける。
        await verification.current?.catch(() => undefined);
        const response = await fetch(PATH, { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) throw new Error('revoke');
        if (generation.current===id) setMessage('画像配信の本人確認を解除しました。');
      } catch {
        if (generation.current===id) setMessage('この画面の画像エフェクトを停止しました。サーバーの本人確認解除は完了していません。');
      } finally {
        revocation.current=null;setRevoking(false);
        if (generation.current===id) { busy.current=false;setPending(false); }
      }
    })();
    revocation.current=work;
    return work;
  }, [clear]);
  const reason = message || (mode === 'owner' ? '画像配信の本人確認が必要なため、互換表示を利用しています。' : mode === 'disabled' ? '画像配信はサーバー側で無効です。互換表示を利用します。' : '');
  return { reason, nativeImagesEnabled: !blocked && !revoking && (mode === 'preview' || mode === 'owner' && session?.pubkey === pubkey), pending: pending || revoking, message, authorize, revoke };
}
