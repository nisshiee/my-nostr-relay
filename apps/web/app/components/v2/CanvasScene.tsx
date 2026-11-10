"use client";

import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { detectCanvasMode, createSceneLayout, updateSceneLayout, type Camera, type CanvasMode, type DrawableCanvas, type DrawableContext, type SceneBox } from "./scene";

import { createSceneMotion, retargetSceneMotion, advanceSceneMotion, sceneMotionBoxes, type SceneMotionState } from "./sceneMotion";

import type { Card } from "../../lib/types";

export interface CanvasSceneItem { id: string; content: ReactNode; card?: Card }
interface Props { items: CanvasSceneItem[]; heldIds?: ReadonlySet<string>; className?: string }
const EMPTY = new Set<string>();

interface CardRootProps { item: CanvasSceneItem; register: (id: string, node: HTMLDivElement | null) => void }
const subscribeHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

/** SSRと初回hydrationは共に空にし、完了後だけDOM portalを作成する。 */
function CardRoot(props: CardRootProps) {
  const mounted = useSyncExternalStore(subscribeHydration, clientSnapshot, serverSnapshot);
  return mounted ? <MountedCardRoot {...props} /> : null;
}

/** Portalの行先を維持し、native失敗時にも入力中のReact stateを失わない。 */
function MountedCardRoot({ item, register }: CardRootProps) {
  const [node] = useState(() => document.createElement('div'));
  useLayoutEffect(() => {
    node.setAttribute('data-scene-card', item.id);
    node.setAttribute('style', 'position:absolute;left:0;top:0;transform-origin:0 0');
    register(item.id, node);
    return () => register(item.id, null);
  }, [item.id, node, register]);
  return createPortal(item.content, node);
}

export function CanvasScene({ items, heldIds = EMPTY, className }: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<DrawableCanvas>(null);
  const extent = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const fallback = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const savedBoxes = useRef(new Map<string, SceneBox>());
  const savedMotion = useRef<SceneMotionState | null>(null);
  const savedTargets = useRef(new Map<string, SceneBox>());
  const savedLayout = useRef(createSceneLayout());
  const runtime = useRef<{ refresh: () => void; attach: (node: HTMLDivElement) => void; reset: () => void; camera: Camera } | null>(null);
  const current = useRef({ items, heldIds });
  const [status, setStatus] = useState('DOM fallback · 初期化中');
  const [forcedDOM, setForcedDOM] = useState(false);
  const [register] = useState(() => (id: string, node: HTMLDivElement | null) => {
    const old = nodes.current.get(id);
    if (node) { nodes.current.set(id, node); runtime.current?.attach(node); }
    else { old?.remove(); nodes.current.delete(id); }
    runtime.current?.refresh();
  });
  useLayoutEffect(() => { current.current = { items, heldIds }; runtime.current?.refresh(); }, [items, heldIds]);

  // カードのpassive effectによるautofocusより先にportalの行先を接続する。
  useLayoutEffect(() => {
    const host = viewport.current!;
    const surface = canvas.current!;
    const dom = fallback.current!;
    const ctx = surface.getContext('2d') as DrawableContext | null;
    const supported = detectCanvasMode(surface, ctx);
    let mode: CanvasMode = forcedDOM ? 'dom' : supported;
    let boxes = savedBoxes.current;
    let targets = savedTargets.current;
    let layout = savedLayout.current;
    let motion = savedMotion.current ?? createSceneMotion();
    let layoutDirty = true;
    let lastFrameTime: number | null = null;
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let reducedMotion = media?.matches ?? false;
    let frame = 0;
    let disposed = false;
    let painted = false;
    const watchdog: { timer?: ReturnType<typeof setTimeout> } = {};
    let camera: Camera = { x: 0, y: -host.scrollTop, zoom: 1 };
    const heights = new Map<string, number>();
    const localHeld = new Set<string>();
    let revealFocus = false;
    const observed = new Set<HTMLElement>();
    const drawOrder = () => {
      const held = new Set([...current.current.heldIds, ...localHeld]);
      return [...current.current.items].reverse().sort((a, b) => Number(held.has(a.id)) - Number(held.has(b.id)));
    };
    const geometry = () => {
      const order = new Map(drawOrder().map((item, index) => [item.id, index]));
      for (const [id, node] of nodes.current) {
        const box = boxes.get(id);
        if (!box) continue;
        node.style.width = `${box.width}px`;
        node.style.zIndex = String(order.get(id) ?? 0);
        const card = motion.cards.get(id);
        const target = targets.get(id) ?? box;
        node.dataset.sceneX = box.x.toFixed(2); node.dataset.sceneY = box.y.toFixed(2);
        node.dataset.sceneTargetX = target.x.toFixed(2); node.dataset.sceneTargetY = target.y.toFixed(2);
        node.dataset.scenePhase = card?.phase ?? 'settled';
        node.dataset.sceneDelay = String(Math.round(card?.delayMs ?? 0));
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
    const requestFrame = () => {
      if (disposed || frame) return;
      frame = requestAnimationFrame(time => {
        frame = 0;
        const rect = host.getBoundingClientRect();
        const viewportWidth = host.clientWidth || rect.width;
        const viewportHeight = host.clientHeight || rect.height;
        layer.current!.style.height = `${viewportHeight}px`;
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round(viewportWidth * dpr));
        const h = Math.max(1, Math.round(viewportHeight * dpr));
        if (surface.width !== w) surface.width = w;
        if (surface.height !== h) surface.height = h;
        if (layoutDirty) {
          const held = new Set([...current.current.heldIds, ...localHeld]);
          for (const [id, node] of nodes.current) {
            const parent = mode === 'dom' ? dom : surface;
            if (node.parentNode !== parent) {
              node.style.transform = '';
              if (mode === 'modern') node.setAttribute('drawable', ''); else node.removeAttribute('drawable');
              parent.appendChild(node);
            }
            const measuredWidth = held.has(id) ? boxes.get(id)?.width : undefined;
            node.style.width = `${measuredWidth ?? Math.max(160, Math.min(360, viewportWidth - 32))}px`;
            heights.set(id, node.offsetHeight || 120);
            if (!observed.has(node)) { observer.observe(node); observed.add(node); }
          }
          for (const node of observed) if (!Array.from(nodes.current.values()).includes(node as HTMLDivElement)) { observer.unobserve(node); observed.delete(node); }
          const plan = updateSceneLayout(layout, current.current.items, heights, viewportWidth, held, boxes);
          layout = plan;
          targets = plan.boxes;
          motion = retargetSceneMotion(motion, targets, { chainOrder: plan.chainOrder, heldIds: held, reducedMotion });
          layoutDirty = false;
        }
        motion = advanceSceneMotion(motion, lastFrameTime === null ? 0 : Math.max(0, time - lastFrameTime), { heldIds: new Set([...current.current.heldIds, ...localHeld]), reducedMotion });
        lastFrameTime = time;
        boxes = sceneMotionBoxes(motion);
        const bottom = Math.max(viewportHeight, ...[...boxes.values(), ...targets.values()].map(box => box.y + box.height + 16));
        extent.current!.style.height = `${bottom}px`;
        host.scrollLeft = 0;
        camera = { x: 0, y: -host.scrollTop, zoom: 1 };
        host.dataset.sceneMotion = reducedMotion ? 'reduced' : motion.active ? 'animating' : 'settled';
        if (revealFocus) { revealFocus = false; reveal(document.activeElement); }
        savedBoxes.current = boxes;
        savedMotion.current = motion; savedTargets.current = targets; savedLayout.current = layout;
        geometry();
        runtime.current!.camera = camera;
        if (mode !== 'dom') {
          surface.requestPaint?.();
          if (!painted && current.current.items.length && watchdog.timer === undefined) watchdog.timer = setTimeout(() => {
            if (!painted && !disposed) { changeMode('dom'); refresh(); }
          }, 2500);
        }
        if (motion.active) requestFrame();
        else lastFrameTime = null;
      });
    };
    const refresh = () => { layoutDirty = true; requestFrame(); };
    const preference = () => { reducedMotion = media?.matches ?? false; refresh(); };
    media?.addEventListener('change', preference);
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
        for (const item of drawOrder()) {
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
    // ホイール・touch・キーボードはブラウザの縦スクロールへ任せる。
    const scroll = () => { host.scrollLeft = 0; requestFrame(); };
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
      if (top < host.scrollTop || top + controlHeight > host.scrollTop + r.height) {
        host.scrollTop = Math.max(0, top < host.scrollTop || controlHeight >= r.height ? top - 16 : top + controlHeight - r.height + 16);
        camera = { x: 0, y: -host.scrollTop, zoom: 1 };
        requestFrame();
      }
    };
    const focus = (event: FocusEvent) => {
      const id = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-scene-card]')?.dataset.sceneCard : undefined;
      localHeld.clear(); if (id) localHeld.add(id);
      revealFocus = true; refresh();
    };
    const blur = () => { localHeld.clear(); refresh(); };
    runtime.current = { refresh, camera, reset: () => { host.scrollTop = 0; requestFrame(); }, attach: node => {
      if (mode === 'modern') node.setAttribute('drawable', ''); else node.removeAttribute('drawable');
      (mode === 'dom' ? dom : surface).appendChild(node);
    } };
    surface.addEventListener('paint', paint);
    // 固定サイズ画像の読込完了でもnative再描画を要求する。
    host.addEventListener('canvas-image-ready', refresh);
    host.addEventListener('scroll', scroll, { passive: true });
    host.addEventListener('focusin', focus); host.addEventListener('focusout', blur);
    window.addEventListener('resize', refresh);
    changeMode(mode); refresh();
    return () => {
      media?.removeEventListener('change', preference);
      disposed = true; cancelAnimationFrame(frame); clearTimeout(watchdog.timer); observer.disconnect();
      surface.removeEventListener('paint', paint); host.removeEventListener('scroll', scroll);
      host.removeEventListener('canvas-image-ready', refresh);
      host.removeEventListener('focusin', focus); host.removeEventListener('focusout', blur); window.removeEventListener('resize', refresh);
    };
  }, [forcedDOM]);

  return <section className={`flex min-h-0 flex-1 flex-col ${className ?? ''}`} aria-label="V2 canvas">
    <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-white px-4 py-2 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
      <span role="status" data-renderer-status>{status}</span>
      <button type="button" onClick={() => setForcedDOM(value => !value)} className="rounded border px-2 py-1">{forcedDOM ? 'Nativeを試す' : 'DOMに切替'}</button>
      <button type="button" onClick={() => runtime.current?.reset()} className="rounded border px-2 py-1">先頭に戻る</button>
      <span>縦スクロールで移動</span>
    </div>
    <div ref={viewport} tabIndex={0} aria-label="カード領域。縦スクロールで移動" className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-zinc-100 dark:bg-zinc-950" style={{ touchAction: 'pan-y pinch-zoom', overflowAnchor: 'none', scrollbarGutter: 'stable' }}>
      <div ref={extent} className="relative w-full" style={{ overflowAnchor: 'none' }}>
        <div ref={layer} className="sticky top-0 w-full overflow-clip">
          <canvas ref={canvas} className="absolute inset-0 h-full w-full" aria-label="ライブカード" />
          <div ref={fallback} className="absolute inset-0" />
        </div>
      </div>
      {items.map(item => <CardRoot key={item.id} item={item} register={register} />)}
    </div>
  </section>;
}
