"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { canvasImageLoader } from '../lib/canvasImageLoader';
import { signEventWithActiveSigner } from '../lib/nostrSigner';

export type CanvasImageAccessMode = 'disabled' | 'preview' | 'owner';
export const CANVAS_IMAGE_SESSION_INVALIDATED = 'canvas-image-unauthorized';
const PATH = '/api/canvas-image/auth';
interface Session { pubkey: string; expiresAt: number }
interface Status { available?: boolean; authenticated: boolean; eligible?: boolean; expiresAt?: number; pubkey?: string }
const FAILURE = '画像配信の本人確認を完了できませんでした。もう一度お試しください。';

const ATTEMPT_PREFIX = 'nlc-image-auth-attempt:';
const LOCK_PREFIX = 'nlc-image-auth-lock:';
function markAttempt(key: string): boolean {
  try { sessionStorage.setItem(ATTEMPT_PREFIX + key, '1');localStorage.setItem(ATTEMPT_PREFIX + key, String(Date.now()+30*60_000));return true; } catch { return false; }
}
function attempted(key: string): boolean {
  try { return sessionStorage.getItem(ATTEMPT_PREFIX + key) === '1' || Number(localStorage.getItem(ATTEMPT_PREFIX + key)) > Date.now(); } catch { return true; }
}
/** Web Locks非対応時のleaseはbest-effort。複数タブの完全な排他は保証しない。 */
async function coordinate(key: string, work: () => Promise<void>, allowWithoutStorage = false): Promise<void> {
  if (navigator.locks?.request) {
    await navigator.locks.request(LOCK_PREFIX + key, { ifAvailable: true }, async lock => { if (lock) await work(); });
    return;
  }
  const name=LOCK_PREFIX+key, token=crypto.randomUUID();
  const value=JSON.stringify({token,until:Date.now()+120_000});
  try {
    const old=JSON.parse(localStorage.getItem(name) || 'null');
    if (old && typeof old.until === 'number' && old.until > Date.now()) return;
    localStorage.setItem(name,value);
    if (localStorage.getItem(name)!==value) return;
  } catch {
    // 保存不可時は自動署名を止め、明示retryだけを同一hookのbusyで保護する。
    if (allowWithoutStorage) await work();
    return;
  }
  try { await work(); }
  finally { try { if (localStorage.getItem(name)===value) localStorage.removeItem(name); } catch { /* leaseは有限。 */ } }
}
/** login連動の一回試行と明示retry。認証イベントをリレーへ投稿しない。 */
export function useCanvasImageSession({ pubkey, mode, nativeCapable = false, manualDOM = false }: { pubkey: string | null; mode: CanvasImageAccessMode; nativeCapable?: boolean; manualDOM?: boolean }) {
  const [session, setSession] = useState<Session | null>(null);
  const [eligibility, setEligibility] = useState<{pubkey:string;eligible:boolean}|null>(null);
  const [pending, setPending] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [message, setMessage] = useState('');
  const [blocked, setBlocked] = useState(false);
  const [interactionMode, setInteractionMode] = useState(`${nativeCapable}:${manualDOM}`);
  if (interactionMode !== `${nativeCapable}:${manualDOM}`) { setInteractionMode(`${nativeCapable}:${manualDOM}`);setPending(false); }
  const [identity, setIdentity] = useState(`${mode}:${pubkey ?? ''}`);
  if (identity !== `${mode}:${pubkey ?? ''}`) {
    setIdentity(`${mode}:${pubkey ?? ''}`);setEligibility(null);setSession(null);setPending(false);setMessage('');setBlocked(false);
  }
  const generation = useRef(0);
  const busy = useRef(false);
  const verification = useRef<Promise<Response> | null>(null);
  const revocation = useRef<Promise<void> | null>(null);
  const active = useRef({ pubkey, mode });
  const capability = useRef({ nativeCapable, manualDOM });
  useLayoutEffect(() => { capability.current = { nativeCapable, manualDOM };generation.current++;busy.current=false; }, [nativeCapable, manualDOM]);
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
    const invalidate = () => { clear();setMessage('画像配信の本人確認が失効しました。互換表示に戻しました。'); };
    window.addEventListener(CANVAS_IMAGE_SESSION_INVALIDATED, invalidate);
    return () => window.removeEventListener(CANVAS_IMAGE_SESSION_INVALIDATED, invalidate);
  }, [clear]);
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(() => { clear();setMessage('画像配信の本人確認の有効期限が切れました。'); }, Math.max(0, session.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [session, clear]);
  const performAuthorization = useCallback(async () => {
    if (mode !== 'owner' || !pubkey || busy.current || revocation.current || !capability.current.nativeCapable || capability.current.manualDOM) return;
    busy.current=true;
    const id = ++generation.current;
    const current = () => id === generation.current && active.current.pubkey === pubkey && active.current.mode === mode && capability.current.nativeCapable && !capability.current.manualDOM;
    markAttempt(pubkey);setPending(true);setMessage('');
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
  const requestAuthorization = useCallback(async (automatic: boolean) => {
    if (mode !== 'owner' || !pubkey || !/^[0-9a-f]{64}$/.test(pubkey) || !nativeCapable || manualDOM || revocation.current || busy.current || automatic && attempted(pubkey)) return;
    const id = generation.current;
    const current = () => generation.current===id && active.current.pubkey===pubkey && active.current.mode===mode && capability.current.nativeCapable && !capability.current.manualDOM && !revocation.current;
    await coordinate(pubkey, async () => {
      if (!current() || automatic && attempted(pubkey)) return;
      // 他タブが先にcookieを得ていれば再署名しない。
      try {
        const response=await fetch(`${PATH}?pubkey=${encodeURIComponent(pubkey)}`,{credentials:'same-origin',cache:'no-store'});
        if (!response.ok) return;
        const data=await response.json() as Status;
        if (!current()) return;
        if (validStatus(data,pubkey)) { markAttempt(pubkey);setBlocked(false);setSession({pubkey,expiresAt:data.expiresAt!});return; }
        if (data.available!==true || data.eligible!==true) return;
        if (automatic && !markAttempt(pubkey)) return;
        await performAuthorization();
      } catch { if (current()) setMessage(FAILURE); }
    }, !automatic);
  },[mode,pubkey,nativeCapable,manualDOM,validStatus,performAuthorization]);
  const authorize=useCallback(()=>requestAuthorization(false),[requestAuthorization]);
  useEffect(() => {
    const id = ++generation.current;
    if (mode !== 'owner' || !pubkey || !/^[0-9a-f]{64}$/.test(pubkey) || revocation.current) return;
    const controller = new AbortController();
    void fetch(`${PATH}?pubkey=${encodeURIComponent(pubkey)}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('status');
      const data = await response.json() as Status;
      if (generation.current !== id || active.current.pubkey !== pubkey || active.current.mode !== mode || revocation.current) return;
      setEligibility({pubkey,eligible:data.available===true && data.eligible===true});
      if (validStatus(data, pubkey)) { markAttempt(pubkey);setSession({ pubkey, expiresAt: data.expiresAt! }); }
      else if (data.available === false) setMessage('画像配信はサーバー側で無効です。互換表示を利用します。');
      else if (data.authenticated && data.pubkey!==pubkey) setMessage('別アカウントの確認状態は利用できません。現在のアカウントで本人確認してください。');
      else if (data.eligible === false) setMessage('このアカウントは画像配信の対象外です。互換表示を利用します。');
      else if (data.available === true && data.eligible === true && nativeCapable && !manualDOM) await requestAuthorization(true);
    }).catch(() => { if (generation.current === id && !controller.signal.aborted) setMessage('画像配信は互換表示のままです。'); });
    return () => { controller.abort(); };
  }, [pubkey, mode, nativeCapable, manualDOM, validStatus, requestAuthorization]);
  const revoke = useCallback((): Promise<void> => {
    if (revocation.current) return revocation.current;
    if(pubkey) markAttempt(pubkey);
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
  }, [clear,pubkey]);
  const reason = message || (mode === 'owner' ? '画像配信の本人確認が必要なため、互換表示を利用しています。' : mode === 'disabled' ? '画像配信はサーバー側で無効です。互換表示を利用します。' : '');
  return { reason, canAuthorize: mode==='owner' && nativeCapable && !manualDOM && eligibility?.pubkey===pubkey && eligibility.eligible && !revoking, nativeImagesEnabled: !blocked && !revoking && (mode === 'preview' || mode === 'owner' && nativeCapable && !manualDOM && session?.pubkey === pubkey), pending: pending || revoking, message, authorize, revoke };
}
