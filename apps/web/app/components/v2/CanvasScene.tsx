"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { detectCanvasMode, layoutScene, zoomCamera, type Camera, type CanvasMode, type DrawableCanvas, type DrawableContext, type SceneBox } from "./scene";

export interface CanvasSceneItem { id: string; content: ReactNode }
interface Props { items: CanvasSceneItem[]; heldIds?: ReadonlySet<string>; className?: string }
const EMPTY = new Set<string>();

/** Portalの行先を維持し、native失敗時にも入力中のReact stateを失わない。 */
function CardRoot({ item, register }: { item: CanvasSceneItem; register: (id: string, node: HTMLDivElement | null) => void }) {
  const [node] = useState(() => typeof document === 'undefined' ? null : document.createElement('div'));
  useLayoutEffect(() => {
    if (!node) return;
    node.setAttribute('data-scene-card', item.id);
    node.setAttribute('style', 'position:absolute;left:0;top:0;transform-origin:0 0');
    register(item.id, node);
    return () => register(item.id, null);
  }, [item.id, node, register]);
  return node ? createPortal(item.content, node) : null;
}

export function CanvasScene({ items, heldIds = EMPTY, className }: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<DrawableCanvas>(null);
  const fallback = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const savedBoxes = useRef(new Map<string, SceneBox>());
  const runtime = useRef<{ refresh: () => void; attach: (node: HTMLDivElement) => void; reset: () => void; camera: Camera } | null>(null);
  const current = useRef({ items, heldIds });
  const [status, setStatus] = useState('DOM fallback · 初期化中');
  const [forcedDOM, setForcedDOM] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [register] = useState(() => (id: string, node: HTMLDivElement | null) => {
    const old = nodes.current.get(id);
    if (node) { nodes.current.set(id, node); runtime.current?.attach(node); }
    else { old?.remove(); nodes.current.delete(id); }
    runtime.current?.refresh();
  });
  useLayoutEffect(() => { current.current = { items, heldIds }; runtime.current?.refresh(); }, [items, heldIds]);

  useEffect(() => {
    const host = viewport.current!;
    const surface = canvas.current!;
    const dom = fallback.current!;
    const ctx = surface.getContext('2d') as DrawableContext | null;
    const supported = detectCanvasMode(surface, ctx);
    let mode: CanvasMode = forcedDOM ? 'dom' : supported;
    let boxes = savedBoxes.current;
    let frame = 0;
    let disposed = false;
    let painted = false;
    const watchdog: { timer?: ReturnType<typeof setTimeout> } = {};
    let camera: Camera = runtime.current?.camera ?? { x: 0, y: 0, zoom: 1 };
    let dragging: { x: number; y: number; id: number } | null = null;
    const heights = new Map<string, number>();
    const localHeld = new Set<string>();
    let revealFocus = false;
    const observed = new Set<HTMLElement>();
    const geometry = () => {
      for (const [id, node] of nodes.current) {
        const box = boxes.get(id);
        if (!box) continue;
        node.style.width = `${box.width}px`;
        if (mode === 'dom') node.style.transform = `translate(${camera.x + box.x * camera.zoom}px,${camera.y + box.y * camera.zoom}px) scale(${camera.zoom})`;
      }
    };
    const changeMode = (next: CanvasMode) => {
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const selection = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : null;
      mode = next;
      surface.hidden = next === 'dom';
      dom.hidden = next !== 'dom';
      surface.removeAttribute('content');
      surface.removeAttribute('layoutsubtree');
      if (next === 'modern') surface.setAttribute('content', 'drawable');
      if (next === 'legacy') surface.setAttribute('layoutsubtree', '');
      for (const node of nodes.current.values()) {
        node.style.transform = '';
        if (next === 'modern') node.setAttribute('drawable', ''); else node.removeAttribute('drawable');
        (next === 'dom' ? dom : surface).appendChild(node);
      }
      setStatus(next === 'dom' ? (forcedDOM ? 'DOM fallback · 手動' : 'DOM fallback · このブラウザではnative未検証/利用不可') : 'HTML-in-Canvas · 最初の描画を確認中');
      geometry();
      if (active && surface.contains(active) || active && dom.contains(active)) {
        active!.focus({ preventScroll: true });
        if (selection && (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) && selection[0] !== null && selection[1] !== null) active.setSelectionRange(selection[0], selection[1]);
      }
    };
    const refresh = () => {
      if (disposed || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const rect = host.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round(rect.width * dpr));
        const h = Math.max(1, Math.round(rect.height * dpr));
        if (surface.width !== w) surface.width = w;
        if (surface.height !== h) surface.height = h;
        for (const [id, node] of nodes.current) {
          const parent = mode === 'dom' ? dom : surface;
          if (node.parentNode !== parent) {
            node.style.transform = '';
            if (mode === 'modern') node.setAttribute('drawable', ''); else node.removeAttribute('drawable');
            parent.appendChild(node);
          }
          node.style.width = `${Math.max(160, Math.min(360, rect.width - 32))}px`;
          heights.set(id, node.offsetHeight || 180);
          if (!observed.has(node)) { observer.observe(node); observed.add(node); }
        }
        for (const node of observed) if (!Array.from(nodes.current.values()).includes(node as HTMLDivElement)) { observer.unobserve(node); observed.delete(node); }
        boxes = layoutScene(current.current.items.map(item => item.id), heights, rect.width, boxes, new Set([...current.current.heldIds, ...localHeld]));
        if (revealFocus) { revealFocus = false; reveal(document.activeElement); }
        savedBoxes.current = boxes;
        geometry();
        runtime.current!.camera = camera;
        if (mode !== 'dom') {
          surface.requestPaint?.();
          if (!painted && current.current.items.length && watchdog.timer === undefined) watchdog.timer = setTimeout(() => {
            if (!painted && !disposed) { changeMode('dom'); refresh(); }
          }, 2500);
        }
      });
    };
    const observer = new ResizeObserver(refresh);
    observer.observe(host);
    const paint = () => {
      if (!ctx || mode === 'dom' || disposed) return;
      try {
        ctx.resetTransform();
        ctx.clearRect(0, 0, surface.width, surface.height);
        const dpr = window.devicePixelRatio || 1;
        ctx.setTransform(dpr * camera.zoom, 0, 0, dpr * camera.zoom, dpr * camera.x, dpr * camera.y);
        // 省略描画をしないため、古いヒット領域を画面外に残さない。
        for (const item of current.current.items) {
          const node = nodes.current.get(item.id);
          const box = boxes.get(item.id);
          if (!node || !box) continue;
          const transform = ctx.drawElementImage(node, box.x, box.y, box.width, box.height);
          if (mode === 'legacy' && transform) node.style.transform = transform.toString();
          painted = true;
        }
        if (painted) { clearTimeout(watchdog.timer); setStatus(`HTML-in-Canvas · native ${mode}`); }
      } catch {
        changeMode('dom');
        refresh();
      }
    };
    const interactive = (target: EventTarget | null) => target instanceof Element && !!target.closest('[data-scene-card]');
    const wheel = (event: WheelEvent) => {
      // 入力欄・カード内スクロールのネイティブ操作は奪わない。
      if (event.target instanceof Element && event.target.closest('textarea, input, [data-scene-scroll]')) return;
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const rect = host.getBoundingClientRect();
        camera = zoomCamera(camera, camera.zoom * Math.exp(-event.deltaY * 0.005), event.clientX - rect.left, event.clientY - rect.top);
      } else camera = { ...camera, x: camera.x - event.deltaX, y: camera.y - event.deltaY };
      setZoom(Math.round(camera.zoom * 100));
      refresh();
    };
    const down = (event: PointerEvent) => {
      if (interactive(event.target) || event.button !== 0) return;
      dragging = { x: event.clientX, y: event.clientY, id: event.pointerId };
      host.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!dragging || event.pointerId !== dragging.id) return;
      camera = { ...camera, x: camera.x + event.clientX - dragging.x, y: camera.y + event.clientY - dragging.y };
      dragging.x = event.clientX; dragging.y = event.clientY;
      refresh();
    };
    const up = () => { dragging = null; };
    const key = (event: KeyboardEvent) => {
      if (event.target !== host) return;
      const dy = event.key === 'ArrowDown' ? -80 : event.key === 'ArrowUp' ? 80 : 0;
      if (event.key === 'Home') camera = { x: 0, y: 0, zoom: 1 };
      else if (dy) camera = { ...camera, y: camera.y + dy };
      else return;
      event.preventDefault(); refresh(); setZoom(Math.round(camera.zoom * 100));
    };
    const reveal = (target: EventTarget | null) => {
      const node = target instanceof Element ? target.closest<HTMLElement>('[data-scene-card]') : null;
      const box = node?.dataset.sceneCard ? boxes.get(node.dataset.sceneCard) : null;
      if (!box) return;
      const r = host.getBoundingClientRect();
      let offsetY = 0;
      let cursor = target instanceof HTMLElement ? target : null;
      const controlHeight = cursor?.offsetHeight ?? box.height;
      while (cursor && cursor !== node && node?.contains(cursor)) { offsetY += cursor.offsetTop; cursor = cursor.offsetParent as HTMLElement | null; }
      const top = box.y + offsetY;
      if (camera.y + top * camera.zoom < 0 || camera.y + (top + controlHeight) * camera.zoom > r.height || camera.x + box.x * camera.zoom < 0 || camera.x + (box.x + box.width) * camera.zoom > r.width) {
        camera = { ...camera, x: 16 - box.x * camera.zoom, y: 16 - top * camera.zoom }; refresh();
      }
    };
    const focus = (event: FocusEvent) => {
      const id = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-scene-card]')?.dataset.sceneCard : undefined;
      localHeld.clear(); if (id) localHeld.add(id);
      revealFocus = true; refresh();
    };
    const blur = () => { localHeld.clear(); refresh(); };
    runtime.current = { refresh, camera, reset: () => { camera = { x: 0, y: 0, zoom: 1 }; refresh(); }, attach: node => {
      if (mode === 'modern') node.setAttribute('drawable', ''); else node.removeAttribute('drawable');
      (mode === 'dom' ? dom : surface).appendChild(node);
    } };
    surface.addEventListener('paint', paint);
    host.addEventListener('wheel', wheel, { passive: false });
    host.addEventListener('pointerdown', down); host.addEventListener('pointermove', move);
    host.addEventListener('pointerup', up); host.addEventListener('pointercancel', up); host.addEventListener('lostpointercapture', up);
    host.addEventListener('keydown', key); host.addEventListener('focusin', focus); host.addEventListener('focusout', blur);
    window.addEventListener('resize', refresh);
    changeMode(mode); refresh();
    return () => {
      disposed = true; cancelAnimationFrame(frame); clearTimeout(watchdog.timer); observer.disconnect();
      surface.removeEventListener('paint', paint); host.removeEventListener('wheel', wheel);
      host.removeEventListener('pointerdown', down); host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerup', up); host.removeEventListener('pointercancel', up); host.removeEventListener('lostpointercapture', up);
      host.removeEventListener('keydown', key); host.removeEventListener('focusin', focus); host.removeEventListener('focusout', blur); window.removeEventListener('resize', refresh);
    };
  }, [forcedDOM]);

  return <section className={`flex min-h-0 flex-1 flex-col ${className ?? ''}`} aria-label="V2 canvas">
    <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-white px-4 py-2 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
      <span role="status" data-renderer-status>{status}</span><span>{zoom}%</span>
      <button type="button" onClick={() => setForcedDOM(value => !value)} className="rounded border px-2 py-1">{forcedDOM ? 'Nativeを試す' : 'DOMに切替'}</button>
      <button type="button" onClick={() => { if (runtime.current) { runtime.current.reset(); setZoom(100); } }} className="rounded border px-2 py-1">原点に戻る</button>
      <span>余白ドラッグ / スクロール / Ctrl+ホイールでズーム</span>
    </div>
    <div ref={viewport} tabIndex={0} aria-label="カード領域。上下キーで移動、Homeで原点" className="relative min-h-0 flex-1 overflow-hidden bg-zinc-100 dark:bg-zinc-950" style={{ touchAction: 'none' }}>
      <canvas ref={canvas} className="absolute inset-0 h-full w-full" aria-label="ライブカード" />
      <div ref={fallback} className="absolute inset-0" />
      {items.map(item => <CardRoot key={item.id} item={item} register={register} />)}
    </div>
  </section>;
}
