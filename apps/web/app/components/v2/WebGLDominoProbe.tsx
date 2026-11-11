"use client";

import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { dominoEffectAmount } from './dominoEffect';
import { createHtmlQuad, needsTextureUpload, probeMatrix, summarizeFrames, type GeometryCanvas, type HtmlTextureGL } from './webglDomino';
import type { DrawableContext } from './scene';

const HEIGHT = 440, STAGE_HEIGHT = 680, Y = 80;
const subscribe = () => () => {};
interface RootProps { register: (node: HTMLDivElement | null) => void; refresh: () => void }
function Root(props: RootProps) {
  return useSyncExternalStore(subscribe, () => true, () => false) ? <MountedRoot {...props} /> : null;
}
function MountedRoot({ register, refresh }: RootProps) {
  const [node] = useState(() => document.createElement('div'));
  const [counts, setCounts] = useState([0, 0, 0, 0]);
  const [text, setText] = useState('');
  useLayoutEffect(() => {
    node.setAttribute('data-webgl-probe-root', '');
    node.setAttribute('style', `position:absolute;left:0;top:0;width:480px;height:${HEIGHT}px;box-sizing:border-box;padding:60px;transform:none;pointer-events:none`);
    register(node); return () => register(null);
  }, [node, register]);
  useLayoutEffect(() => { refresh(); }, [counts, text, refresh]);
  return createPortal(<article data-webgl-probe-face style={{ height: 320, boxSizing: 'border-box', border: '2px solid #7c3aed', borderRadius: 14, background: '#faf5ff', color: '#18181b', padding: 16, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', pointerEvents: 'auto', transformOrigin: '50% 0' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>{[0, 1].map(index => <button key={index} type="button" data-webgl-probe-button={index} onClick={() => setCounts(values => values.map((value, position) => position === index ? value + 1 : value))} style={{ background: '#7c3aed', color: 'white', borderRadius: 6, padding: '8px 10px' }}>{index === 0 ? '左上' : '右上'} {counts[index]}</button>)}</div>
    <div><strong style={{ display: 'block', fontSize: 18 }}>平面HTML → GPUの台形</strong><p style={{ fontSize: 12, margin: '8px 0' }}>同じ面と行列で、描画・クリック・入力を比較します。</p><label style={{ fontSize: 12 }}>検証用入力<input aria-label="WebGL検証の入力" value={text} onChange={event => setText(event.target.value)} placeholder="送信されません" style={{ display: 'block', boxSizing: 'border-box', width: '100%', border: '1px solid #a1a1aa', borderRadius: 4, padding: 8, background: 'white', color: '#18181b' }} /></label></div>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>{[2, 3].map(index => <button key={index} type="button" data-webgl-probe-button={index} onClick={() => setCounts(values => values.map((value, position) => position === index ? value + 1 : value))} style={{ background: '#5b21b6', color: 'white', borderRadius: 6, padding: '8px 10px' }}>{index === 2 ? '左下' : '右下'} {counts[index]}</button>)}</div>
  </article>, node);
}

type Renderer = 'webgl' | 'css' | 'dom';
interface Runtime { refresh: () => void; attach: () => void; pose: (amount: number) => void; run: (measure: boolean) => void }

/** 実フィードから独立した描画・hit・一枚比較用。frame間隔はCPU時間やfeed性能ではない。 */
export function WebGLDominoProbe() {
  const host = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null);
  const gpuCanvas = useRef<GeometryCanvas>(null), cssCanvas = useRef<GeometryCanvas>(null), fallback = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement | null>(null), runtime = useRef<Runtime | null>(null);
  const [renderer, setRenderer] = useState<Renderer>('webgl');
  const [status, setStatus] = useState('初期化中');
  const [metrics, setMetrics] = useState('未計測（5秒、同一1枚fixture。rAF間隔でCPU/GPU時間ではありません）');
  const [refresh] = useState(() => () => runtime.current?.refresh());
  const [register] = useState(() => (node: HTMLDivElement | null) => {
    if (!node) root.current?.remove(); root.current = node; runtime.current?.attach(); runtime.current?.refresh();
  });
  useLayoutEffect(() => {
    const viewport = host.current!, plane = stage.current!, gpu = gpuCanvas.current!, css = cssCanvas.current!, dom = fallback.current!;
    const surface = renderer === 'css' ? css : gpu;
    let mode: Renderer = renderer, disposed = false, frame = 0, dirty = true, uploaded = false;
    let width = 480, viewWidth = 600, x = 60, amount = 1, lastPaintAmount = 1;
    let runStart: number | null = null, running = false, measuring = false, previousTime: number | null = null;
    let frames: number[] = [], paints = 0, uploads = 0, startPaints = 0, startUploads = 0;
    let watchdog: ReturnType<typeof setTimeout> | undefined, releaseTimer: ReturnType<typeof setTimeout> | undefined;
    let pressed: { id: number; amount: number; released: boolean } | null = null;
    let quad: ReturnType<typeof createHtmlQuad> | null = null;
    let ctx: DrawableContext | null = null;
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let reduced = media?.matches ?? false;
    const clearGeometry = () => { if (root.current) for (const candidate of [gpu, css]) { try { candidate.clearElementGeometry?.(root.current); } catch { /* context消失時もDOMへ退避する。 */ } } };
    const attach = () => {
      const node = root.current; if (!node) return;
      const active = document.activeElement instanceof HTMLElement && node.contains(document.activeElement) ? document.activeElement : null;
      const selection = active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : null;
      node.style.transform = 'none';
      node.style.left = mode === 'dom' ? `${x}px` : '0'; node.style.top = mode === 'dom' ? `${Y}px` : '0';
      if (mode === 'dom') node.removeAttribute('drawable'); else node.setAttribute('drawable', '');
      (mode === 'dom' ? dom : surface).appendChild(node);
      if (active) { active.focus({ preventScroll: true }); if (selection && active instanceof HTMLInputElement) active.setSelectionRange(selection[0], selection[1]); }
    };
    const fail = (reason: string) => {
      clearTimeout(watchdog); watchdog = undefined; clearGeometry(); mode = 'dom'; running = false; measuring = false; pressed = null;
      quad?.dispose(); quad = null; gpu.hidden = true; css.hidden = true; dom.hidden = false;
      gpu.removeAttribute('content'); css.removeAttribute('content');
      const face = root.current?.querySelector<HTMLElement>('[data-webgl-probe-face]'); if (face) face.style.transform = '';
      attach(); setStatus(`DOM・効果なし (${reason})`); plane.dataset.webglProbeMode = 'dom';
    };
    const request = () => {
      if (disposed || frame) return;
      frame = requestAnimationFrame(time => {
        frame = 0;
        const available = plane.clientWidth || plane.getBoundingClientRect().width || 600;
        viewWidth = Math.max(280, available); width = Math.max(256, Math.min(480, viewWidth - 24)); x = (viewWidth - width) / 2;
        const node = root.current; if (!node) return;
        if (node.style.width !== `${width}px`) { node.style.width = `${width}px`; dirty = true; }
        const dpr = window.devicePixelRatio || 1;
        const backingWidth = Math.round(viewWidth * dpr), backingHeight = Math.round(STAGE_HEIGHT * dpr);
        if (surface.width !== backingWidth || surface.height !== backingHeight) { surface.width = backingWidth; surface.height = backingHeight; dirty = true; }
        if (running) {
          runStart ??= time;
          if (measuring && previousTime !== null && frames.length < 1200) frames.push(time - previousTime);
          previousTime = time;
          const elapsed = time - runStart;
          amount = dominoEffectAmount(measuring ? elapsed % 1600 : elapsed);
          if (elapsed >= (measuring ? 5000 : 1300)) {
            running = false; amount = 0;
            if (measuring) {
              const result = summarizeFrames(frames);
              setMetrics(`${mode} / ${result.count} rAF intervals / p50 ${result.p50.toFixed(1)}ms / p95 ${result.p95.toFixed(1)}ms / >33.4ms ${result.over33} / draw ${paints - startPaints} / upload ${uploads - startUploads}`);
            }
            measuring = false;
          }
        }
        if (reduced || mode === 'dom') amount = 0;
        if (pressed && !reduced && mode !== 'dom') amount = pressed.amount;
        const face = node.querySelector<HTMLElement>('[data-webgl-probe-face]');
        const transform = mode === 'css' && amount > 0 ? `perspective(1600px) rotateX(${amount * 52}deg)` : '';
        if (face && face.style.transform !== transform) face.style.transform = transform;
        if (mode === 'dom') { if (node.style.left !== `${x}px`) node.style.left = `${x}px`; if (node.style.top !== `${Y}px`) node.style.top = `${Y}px`; }
        plane.dataset.webglProbeAmount = String(amount); plane.dataset.webglProbeDpr = String(dpr);
        if (mode !== 'dom') {
          if (!watchdog) watchdog = setTimeout(() => fail('paint応答なし'), 2500);
          try { surface.requestPaint?.(); } catch { fail('requestPaint失敗'); }
        }
        if (running) request();
      });
    };
    const invalidate = () => { dirty = true; request(); };
    const paint = (event: Event) => {
      if (disposed || mode === 'dom' || !root.current) return;
      try {
        const node = root.current;
        if (mode === 'webgl' && quad) {
          const changed = (event as Event & { changedElements?: readonly Element[] }).changedElements;
          plane.dataset.webglProbeChangedElements = String(changed !== undefined);
          if (needsTextureUpload(dirty, uploaded, changed, node)) { quad.upload(node); uploads++; uploaded = true; dirty = false; }
          quad.draw(node, probeMatrix(x, Y, width, amount), width, HEIGHT, viewWidth, STAGE_HEIGHT);
        } else if (ctx) {
          ctx.resetTransform(); ctx.clearRect(0, 0, surface.width, surface.height);
          const dpr = window.devicePixelRatio || 1; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.drawElementImage(node, x, Y, width, HEIGHT); uploads++;
        }
        lastPaintAmount = amount; paints++; clearTimeout(watchdog); watchdog = undefined;
        plane.dataset.webglProbeDraws = String(paints); plane.dataset.webglProbeUploads = String(uploads);
        setStatus(mode === 'webgl' ? 'Native WebGL・描画済み' : 'Native Canvas2D＋CSS・描画済み');
      } catch { fail('描画API失敗'); }
    };
    const release = () => { clearTimeout(releaseTimer); releaseTimer = undefined; pressed = null; request(); };
    const down = (event: PointerEvent) => { if (event.button === 0 && event.isPrimary !== false && !pressed && root.current?.contains(event.target as Node) && mode !== 'dom') { pressed = { id: event.pointerId, amount: lastPaintAmount, released: false }; request(); } };
    const up = (event: PointerEvent) => { if (pressed?.id === event.pointerId) { pressed.released = true; releaseTimer = setTimeout(release, 700); } };
    const clicked = () => { if (pressed?.released) { clearTimeout(releaseTimer); releaseTimer = setTimeout(release, 0); } };
    const cancel = (event: PointerEvent) => { if (pressed?.id === event.pointerId) release(); };
    const preference = () => { reduced = media?.matches ?? false; if (reduced) { running = false; measuring = false; amount = 0; release(); } request(); };
    const lost = (event: Event) => { event.preventDefault(); fail('WebGL context lost'); };
    runtime.current = { refresh: invalidate, attach: () => { attach(); if (root.current) { resize.observe(root.current); mutation.observe(root.current, { subtree: true, childList: true, characterData: true, attributes: true }); } }, pose: value => { running = false; measuring = false; amount = value; request(); }, run: measure => {
      if (mode === 'dom' || reduced) { setMetrics('DOM / reduced-motionでは効果・計測を開始しません'); return; }
      running = true; measuring = measure; runStart = null; previousTime = null; frames = []; startPaints = paints; startUploads = uploads;
      if (measure) setMetrics('5秒計測中…'); request();
    } };
    const resize = new ResizeObserver(invalidate); resize.observe(plane); if (root.current) resize.observe(root.current);
    const mutation = new MutationObserver(invalidate); if (root.current) mutation.observe(root.current, { subtree: true, childList: true, characterData: true, attributes: true });
    surface.addEventListener('paint', paint); gpu.addEventListener('webglcontextlost', lost);
    for (const type of ['input', 'change', 'focusin', 'focusout', 'pointerover', 'pointerout', 'load']) viewport.addEventListener(type, invalidate, true);
    viewport.addEventListener('pointerdown', down, true); viewport.addEventListener('scroll', request, { passive: true });
    window.addEventListener('pointerup', up, true); window.addEventListener('click', clicked, true); window.addEventListener('pointercancel', cancel, true); window.addEventListener('blur', release); window.addEventListener('resize', invalidate);
    document.fonts?.addEventListener('loadingdone', invalidate); media?.addEventListener('change', preference);
    gpu.hidden = mode !== 'webgl'; css.hidden = mode !== 'css'; dom.hidden = mode !== 'dom';
    try {
      if (mode === 'webgl') {
        const gl = gpu.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: true }) as HtmlTextureGL | null;
        if (!gl || !gpu.requestPaint || !('content' in gpu)) throw new Error('WebGL HTML API unavailable');
        gpu.setAttribute('content', 'drawable'); quad = createHtmlQuad(gl, gpu);
      } else if (mode === 'css') {
        ctx = css.getContext('2d') as DrawableContext | null;
        if (!ctx?.drawElementImage || !css.requestPaint || !('content' in css)) throw new Error('2D HTML API unavailable');
        css.setAttribute('content', 'drawable');
      }
      plane.dataset.webglProbeMode = mode; attach(); setStatus(mode === 'dom' ? 'DOM・効果なし' : `${mode}・paint待機`); request();
    } catch { fail('必要なAPI未対応'); request(); }
    return () => {
      disposed = true; cancelAnimationFrame(frame); clearTimeout(watchdog); clearTimeout(releaseTimer); clearGeometry(); quad?.dispose(); runtime.current = null;
      resize.disconnect(); mutation.disconnect(); surface.removeEventListener('paint', paint); gpu.removeEventListener('webglcontextlost', lost);
      for (const type of ['input', 'change', 'focusin', 'focusout', 'pointerover', 'pointerout', 'load']) viewport.removeEventListener(type, invalidate, true);
      viewport.removeEventListener('pointerdown', down, true); viewport.removeEventListener('scroll', request);
      window.removeEventListener('pointerup', up, true); window.removeEventListener('click', clicked, true); window.removeEventListener('pointercancel', cancel, true); window.removeEventListener('blur', release); window.removeEventListener('resize', invalidate);
      document.fonts?.removeEventListener('loadingdone', invalidate); media?.removeEventListener('change', preference);
    };
  }, [renderer]);
  return <section aria-label="WebGL遠近検証" className="border-b bg-violet-50 text-zinc-900">
    <div className="flex flex-wrap items-center gap-3 p-3 text-xs">
      <strong>WebGL / CSS 同一1枚プローブ</strong>
      <label>QA描画方式 <select aria-label="プローブ描画方式" value={renderer} onChange={event => setRenderer(event.target.value as Renderer)} className="rounded border p-1"><option value="webgl">WebGL texture</option><option value="css">Canvas2D + CSS 比較</option><option value="dom">DOM（効果なし）</option></select></label>
      <button type="button" onClick={() => runtime.current?.pose(1)} className="rounded border px-2 py-1">静止52°</button><button type="button" onClick={() => runtime.current?.pose(0)} className="rounded border px-2 py-1">平面</button>
      <button type="button" onClick={() => runtime.current?.run(false)} className="rounded border px-2 py-1">一回動かす</button><button type="button" onClick={() => runtime.current?.run(true)} className="rounded border px-2 py-1">5秒比較計測</button>
      <span role="status" aria-label="描画状態">{status}</span><output aria-label="frame比較結果">{metrics}</output>
    </div>
    <p className="px-3 pb-2 text-xs">通信なし。四隅クリック・入力・Tab・scrollを確認してください。計測はrAF間隔です。33.4ms超過は固定閾値で、厳密なdrop数・CPU/GPU時間・実フィード性能ではありません。</p>
    <div ref={host} tabIndex={0} aria-label="WebGLプローブ縦スクロール" className="overflow-y-auto overflow-x-hidden" style={{ height: 420, overflowAnchor: 'none' }}>
      <div ref={stage} className="relative w-full" style={{ height: STAGE_HEIGHT, minWidth: 280 }}>
        <canvas ref={gpuCanvas} aria-label="WebGL検証canvas" className="absolute inset-0 h-full w-full" />
        <canvas ref={cssCanvas} aria-label="CSS比較canvas" className="absolute inset-0 h-full w-full" />
        <div ref={fallback} className="absolute inset-0" />
      </div>
    </div>
    <Root register={register} refresh={refresh} />
  </section>;
}
