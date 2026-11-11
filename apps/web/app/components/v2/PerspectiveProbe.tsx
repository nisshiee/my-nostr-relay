"use client";

import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { detectCanvasMode, type CanvasMode, type DrawableCanvas, type DrawableContext } from './scene';

const ROOT_HEIGHT = 468;
const STAGE_HEIGHT = 540;
const ROOT_Y = 24;
const subscribeHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

interface ProbeRootProps {
  tilted: boolean;
  register: (node: HTMLDivElement | null) => void;
  refresh: () => void;
}

/** SSRではDOMを作らず、hydration完了後だけ安定したportalを接続する。 */
function ProbeRoot(props: ProbeRootProps) {
  const mounted = useSyncExternalStore(subscribeHydration, clientSnapshot, serverSnapshot);
  return mounted ? <MountedProbeRoot {...props} /> : null;
}

function MountedProbeRoot({ tilted, register, refresh }: ProbeRootProps) {
  const [node] = useState(() => document.createElement('div'));
  const [counts, setCounts] = useState([0, 0, 0]);
  const [text, setText] = useState('');
  useLayoutEffect(() => {
    node.setAttribute('data-perspective-root', '');
    // drawableの外枠は常に無変形。厚み・影も含めて一度だけ描画する。
    node.setAttribute('style', `position:absolute;left:0;top:0;width:460px;height:${ROOT_HEIGHT}px;box-sizing:border-box;padding:32px 40px 76px;transform:none;`);
    register(node);
    return () => register(null);
  }, [node, register]);
  useLayoutEffect(() => { refresh(); }, [tilted, counts, text, refresh]);

  return createPortal(<article
    data-perspective-card
    data-perspective-angle={tilted ? '45' : '0'}
    style={{
      height: 360, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 12,
      padding: 20, borderRadius: 18, border: '1px solid #c4b5fd', color: '#18181b',
      background: 'linear-gradient(155deg, #ffffff 5%, #f5f3ff 65%, #ede9fe)',
      transform: `perspective(700px) rotateX(${tilted ? 45 : 0}deg)`,
      transformOrigin: '50% 100%',
      boxShadow: tilted
        ? '0 8px 0 #6d5f94, 0 10px 0 #4c416c, 0 28px 30px -8px rgba(32, 22, 59, 0.42)'
        : '0 3px 0 #9d8fbc, 0 14px 22px -10px rgba(32, 22, 59, 0.3)',
    }}
  >
    <div><p style={{ fontSize: 11, letterSpacing: '0.14em', color: '#6d28d9', margin: '0 0 4px' }}>CSS PERSPECTIVE / COMPONENT PROBE</p>
      <h3 style={{ fontSize: 19, fontWeight: 700, margin: 0 }}>台形と操作位置を比較</h3></div>
    {['上', '中央', '下'].map((label, index) => <div key={label} style={{ marginTop: index ? 'auto' : 0 }}>
      <button type="button" data-perspective-button={index} onClick={() => setCounts(values => values.map((value, position) => position === index ? value + 1 : value))}
        style={{ width: '100%', padding: '9px 12px', borderRadius: 9, background: ['#7c3aed', '#6d28d9', '#5b21b6'][index], color: '#fff', fontWeight: 600 }}>
        {label}のボタン {counts[index]}
      </button>
      {index === 1 && <label style={{ display: 'block', fontSize: 12, marginTop: 12 }}>検証用の入力
        <input aria-label="遠近検証の入力" value={text} onChange={event => setText(event.target.value)} placeholder="送信されません"
          style={{ display: 'block', boxSizing: 'border-box', width: '100%', marginTop: 4, padding: 8, border: '1px solid #a1a1aa', borderRadius: 6, background: '#fff', color: '#18181b' }} />
      </label>}
    </div>)}
  </article>, node);
}

/** feedとは独立した静止画・ヒットテスト用。モックテストはnative実機検証を代替しない。 */
export function PerspectiveProbe() {
  const viewport = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<DrawableCanvas>(null);
  const fallback = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const runtime = useRef<{ refresh: () => void; attach: (node: HTMLDivElement) => void } | null>(null);
  const [forcedDOM, setForcedDOM] = useState(false);
  const [tilted, setTilted] = useState(true);
  const [status, setStatus] = useState('DOM · 初期化中');
  const [refresh] = useState(() => () => runtime.current?.refresh());
  const [register] = useState(() => (node: HTMLDivElement | null) => {
    if (!node) root.current?.remove();
    root.current = node;
    if (node) runtime.current?.attach(node);
    runtime.current?.refresh();
  });

  useLayoutEffect(() => {
    const host = viewport.current!;
    const plane = stage.current!;
    const surface = canvas.current!;
    const dom = fallback.current!;
    let ctx: DrawableContext | null = null;
    try { ctx = surface.getContext('2d') as DrawableContext | null; } catch { /* DOMで続ける。 */ }
    const detected = detectCanvasMode(surface, ctx);
    // legacyのヒット座標補正は外枠のCSS変形が必要なため、この無変形プローブでは使わない。
    let mode: CanvasMode = forcedDOM || detected === 'legacy' ? 'dom' : detected;
    let disposed = false;
    let frame = 0;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let width = 460;
    let x = 0;
    let draws = 0;

    const attach = (node: HTMLDivElement) => {
      node.style.transform = 'none';
      if (mode === 'modern') node.setAttribute('drawable', '');
      else node.removeAttribute('drawable');
      const parent = mode === 'dom' ? dom : surface;
      if (node.parentNode !== parent) parent.appendChild(node);
      node.style.left = mode === 'dom' ? `${x}px` : '0px';
      node.style.top = mode === 'dom' ? `${ROOT_Y}px` : '0px';
    };
    const changeMode = (next: CanvasMode, reason: string) => {
      const active = root.current?.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
      const selection = active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : null;
      mode = next;
      clearTimeout(watchdog); watchdog = undefined;
      surface.hidden = mode === 'dom';
      dom.hidden = mode !== 'dom';
      surface.removeAttribute('content'); surface.removeAttribute('layoutsubtree');
      if (mode === 'modern') surface.setAttribute('content', 'drawable');
      if (mode === 'legacy') surface.setAttribute('layoutsubtree', '');
      plane.dataset.perspectiveMode = mode;
      if (root.current) attach(root.current);
      setStatus(reason);
      if (active) {
        active.focus({ preventScroll: true });
        if (active instanceof HTMLInputElement && selection && selection[0] !== null && selection[1] !== null) active.setSelectionRange(selection[0], selection[1]);
      }
    };
    const requestFrame = () => {
      if (disposed || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const available = plane.clientWidth || plane.getBoundingClientRect().width || 492;
        width = Math.max(240, Math.min(460, available - 24));
        x = Math.max(0, (available - width) / 2);
        const dpr = window.devicePixelRatio || 1;
        plane.dataset.perspectiveDpr = String(dpr);
        const w = Math.max(1, Math.round(available * dpr));
        const h = Math.round(STAGE_HEIGHT * dpr);
        if (surface.width !== w) surface.width = w;
        if (surface.height !== h) surface.height = h;
        const node = root.current;
        if (!node) return;
        node.style.width = `${width}px`;
        attach(node);
        if (mode !== 'dom') {
          // 各要求を監視し、最初の成功後にpaintが途絶えた場合もDOMへ戻す。
          if (watchdog === undefined) watchdog = setTimeout(() => {
            if (!disposed) changeMode('dom', 'DOM · paint応答なし');
          }, 2500);
          try { surface.requestPaint?.(); }
          catch { changeMode('dom', 'DOM · requestPaint失敗'); }
        }
      });
    };
    const paint = () => {
      if (disposed || mode === 'dom' || !ctx || !root.current) return;
      try {
        ctx.resetTransform();
        ctx.clearRect(0, 0, surface.width, surface.height);
        const dpr = window.devicePixelRatio || 1;
        // CTMはDPRだけ。遠近変形はdrawable内のCSSにだけ任せる。
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.drawElementImage(root.current, x, ROOT_Y, width, ROOT_HEIGHT);
        plane.dataset.perspectiveDraws = String(++draws);
        clearTimeout(watchdog); watchdog = undefined;
        setStatus(`Native ${mode} · 描画済み（操作位置は目視検証）`);
      } catch { changeMode('dom', 'DOM · drawElementImage失敗'); }
    };
    const observer = new ResizeObserver(requestFrame);
    observer.observe(plane);
    runtime.current = { refresh: requestFrame, attach };
    surface.addEventListener('paint', paint);
    host.addEventListener('scroll', requestFrame, { passive: true });
    host.addEventListener('focusin', requestFrame);
    host.addEventListener('focusout', requestFrame);
    host.addEventListener('pointerover', requestFrame);
    host.addEventListener('pointerout', requestFrame);
    window.addEventListener('resize', requestFrame);
    changeMode(mode, mode === 'dom' ? `DOM · ${forcedDOM ? '手動' : detected === 'legacy' ? 'legacy APIはこの検証の対象外' : 'native APIなし'}` : `Native ${mode} · paint待機中`);
    requestFrame();
    return () => {
      disposed = true;
      runtime.current = null;
      cancelAnimationFrame(frame); clearTimeout(watchdog); observer.disconnect();
      surface.removeEventListener('paint', paint);
      host.removeEventListener('scroll', requestFrame);
      host.removeEventListener('focusin', requestFrame); host.removeEventListener('focusout', requestFrame);
      host.removeEventListener('pointerover', requestFrame); host.removeEventListener('pointerout', requestFrame);
      window.removeEventListener('resize', requestFrame);
    };
  }, [forcedDOM]);

  return <section id="perspective-probe" aria-label="遠近変形のコンポーネント検証" className="border-b border-violet-200 bg-violet-50 text-zinc-900">
    <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-xs">
      <h2 className="text-sm font-bold">CSS遠近変形 · 独立プローブ</h2>
      <span role="status" data-perspective-status>{status}</span>
      <button type="button" onClick={() => setForcedDOM(value => !value)} className="rounded border bg-white px-2 py-1">{forcedDOM ? 'プローブをNativeへ' : 'プローブをDOMへ'}</button>
      <button type="button" aria-pressed={tilted} onClick={() => setTilted(value => !value)} className="rounded border bg-white px-2 py-1">{tilted ? '角度 45° → 平面へ' : '角度 0° → 傾ける'}</button>
      <span>外枠は無変形。内側だけ perspective(700px) + rotateX。通信・投稿なし。</span>
    </div>
    <div ref={viewport} aria-label="遠近プローブのスクロール領域" tabIndex={0} className="overflow-auto" style={{ height: 420, touchAction: 'pan-y pinch-zoom', overflowAnchor: 'none' }}>
      <div ref={stage} className="relative w-full" style={{ height: STAGE_HEIGHT, minWidth: 264 }}>
        <canvas ref={canvas} aria-label="遠近プローブのCanvas" className="absolute inset-0 h-full w-full" />
        <div ref={fallback} className="absolute inset-0" />
      </div>
      <ProbeRoot tilted={tilted} register={register} refresh={refresh} />
    </div>
    <p className="px-4 py-2 text-xs text-zinc-600">上・中央・下のボタン、Tab、入力、縦スクロール、DPR変更をDOMと比較。実フィードの採用前にChrome実機で確認するための静止プローブです。</p>
  </section>;
}
