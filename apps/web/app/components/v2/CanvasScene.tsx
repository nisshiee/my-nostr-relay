"use client";

import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { detectCanvasMode, createSceneLayout, updateSceneLayout, type Camera, type CanvasMode, type DrawableCanvas, type DrawableContext, type SceneBox } from "./scene";

import { createSceneMotion, retargetSceneMotion, advanceSceneMotion, sceneMotionBoxes, type SceneMotionState } from "./sceneMotion";

import type { Card } from "../../lib/types";
import { createPushPaths, createPushParticles, drawPushPaths, pushEffectOpacity, PUSH_EFFECT_DURATION_MS, type PushEffectPath, type PushEffectBox } from "./pushEffect";

import { createDominoTransforms, DOMINO_EFFECT_DURATION_MS, DOMINO_PERSPECTIVE_MAX_OUTSET, type DominoTransform } from "./dominoEffect";
import { getEffectPreference, serverEffectPreference, subscribeEffectPreference, setEffectPreference, type SceneEffectChoice } from "./effectPreference";

export interface CanvasSceneItem { id: string; content: ReactNode; card?: Card }
interface Props { items: CanvasSceneItem[]; heldIds?: ReadonlySet<string>; className?: string }
const EMPTY = new Set<string>();
// 投影の越境上限64pxとアンチエイリアスの余白。効果中は固定し毎frame寸法を変えない。
const DOMINO_CAPTURE_PADDING = DOMINO_PERSPECTIVE_MAX_OUTSET + 2;

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
    node.setAttribute('style', 'position:absolute;left:0;top:0;transform-origin:0 0;box-sizing:content-box;pointer-events:none');
    register(item.id, node);
    return () => register(item.id, null);
  }, [item.id, node, register]);
  return createPortal(<>
    <div data-scene-footprint aria-hidden="true" style={{ position: 'absolute', inset: 0, borderRadius: 12, pointerEvents: 'none', opacity: 0 }} />
    <div data-scene-face style={{ position: 'relative', transformOrigin: '50% 100%', pointerEvents: 'auto' }}>
      {item.content}
      <div data-scene-shade aria-hidden="true" style={{ position: 'absolute', inset: 0, borderRadius: 12, pointerEvents: 'none', opacity: 0 }} />
    </div>
  </>, node);
}

export function CanvasScene({ items, heldIds = EMPTY, className }: Props) {
  const effectChoice = useSyncExternalStore(subscribeEffectPreference, getEffectPreference, serverEffectPreference);
  const chosenEffect = useRef(effectChoice);
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<DrawableCanvas>(null);
  const extent = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const fallback = useRef<HTMLDivElement>(null);
  const effectSvg = useRef<SVGSVGElement>(null);
  const effectGroup = useRef<SVGGElement>(null);
  const effectParticleGroup = useRef<SVGGElement>(null);
  const savedEffect = useRef({ revision: 0, startedAt: 0, active: false });
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const savedBoxes = useRef(new Map<string, SceneBox>());
  const savedMotion = useRef<SceneMotionState | null>(null);
  const savedTargets = useRef(new Map<string, SceneBox>());
  const savedLayout = useRef(createSceneLayout());
  const runtime = useRef<{ refresh: () => void; attach: (node: HTMLDivElement) => void; reset: () => void; chooseEffect: () => void; camera: Camera } | null>(null);
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

  useLayoutEffect(() => { chosenEffect.current = effectChoice; runtime.current?.chooseEffect(); }, [effectChoice]);

  // カードのpassive effectによるautofocusより先にportalの行先を接続する。
  useLayoutEffect(() => {
    const host = viewport.current!;
    const surface = canvas.current!;
    const dom = fallback.current!;
    const ctx = surface.getContext('2d') as DrawableContext | null;
    const supported = detectCanvasMode(surface, ctx);
    let mode: CanvasMode = forcedDOM || supported === 'legacy' && chosenEffect.current === 'domino' ? 'dom' : supported;
    let boxes = savedBoxes.current;
    let targets = savedTargets.current;
    let layout = savedLayout.current;
    let motion = savedMotion.current ?? createSceneMotion();
    let layoutDirty = true;
    const effect = savedEffect.current;
    let effectPaths: readonly PushEffectPath[] = [];
    let effectViewport: PushEffectBox | undefined;
    let effectOpacity = 0;
    let effectAge = 0;
    let dominoTransforms: ReadonlyMap<string, DominoTransform> = new Map();
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
    let pressed: { pointerId: number; id: string; box: SceneBox; transform: DominoTransform; released: boolean } | null = null;
    const displayed = new Map<string, { box: SceneBox; transform?: DominoTransform }>();
    // 直近の各イベントだけをDOMに残す。本文・URL・属性値を収集せず、操作へ介入しない。
    let diagnosticSeq = 0;
    let paintSeq = 0;
    let geometrySeq = 0;
    let diagnosticGesture: { pointerId: number | null; released: boolean } | null = null;
    const nextSerial = (value: number) => value >= Number.MAX_SAFE_INTEGER ? 1 : value + 1;
    const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
    const shortId = (value: string | undefined) => value?.slice(0, 128) ?? null;
    const diagnosticTags = new Set(['BUTTON', 'IMG', 'INPUT', 'TEXTAREA', 'A', 'DIV', 'SPAN', 'CANVAS', 'SVG', 'PATH']);
    const recordPointer = (kind: 'Down' | 'Up' | 'Click', event: MouseEvent | PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const within = target !== null && host.contains(target);
      const card = within ? target.closest<HTMLElement>('[data-scene-card]') : null;
      const id = card?.dataset.sceneCard;
      const button = within ? target.closest('button') : null;
      const buttons = card?.querySelectorAll('button');
      let buttonIndex: number | null = null;
      if (button && buttons) for (let index = 0; index < Math.min(buttons.length, 1024); index++) {
        if (buttons[index] === button) { buttonIndex = index; break; }
      }
      const drawn = id ? displayed.get(id) : undefined;
      const pending = id ? boxes.get(id) : undefined;
      diagnosticSeq = nextSerial(diagnosticSeq);
      host.dataset[`sceneLastPointer${kind}`] = JSON.stringify({
        seq: diagnosticSeq, at: finite(event.timeStamp), mode, paint: paintSeq, geometry: geometrySeq,
        within, targetTag: target ? diagnosticTags.has(target.tagName.toUpperCase()) ? target.tagName.toUpperCase() : 'OTHER' : 'NONE',
        card: shortId(id), button: button !== null, buttonIndex,
        pointerId: 'pointerId' in event ? finite(event.pointerId) : null,
        x: finite(event.clientX), y: finite(event.clientY), pressed: shortId(pressed?.id),
        drawn: drawn ? { x: drawn.box.x, y: drawn.box.y, tip: drawn.transform?.amount ?? 0 } : null,
        pending: pending ? { x: pending.x, y: pending.y, tip: dominoTransforms.get(id!)?.amount ?? 0 } : null,
      });
    };
    const diagnosticDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !host.contains(event.target)) { diagnosticGesture = null; return; }
      diagnosticGesture = { pointerId: finite(event.pointerId), released: false };
      recordPointer('Down', event);
    };
    const diagnosticUp = (event: PointerEvent) => {
      const within = event.target instanceof Node && host.contains(event.target);
      const same = diagnosticGesture !== null && diagnosticGesture.pointerId === finite(event.pointerId);
      if (within || same) recordPointer('Up', event);
      if (same) diagnosticGesture!.released = true;
    };
    const diagnosticClick = (event: MouseEvent) => {
      const within = event.target instanceof Node && host.contains(event.target);
      const pointerId = 'pointerId' in event ? finite(event.pointerId) : null;
      const same = diagnosticGesture?.released && pointerId !== null && diagnosticGesture.pointerId === pointerId;
      if (within || same) recordPointer('Click', event);
      diagnosticGesture = null;
    };
    const clearDiagnosticGesture = () => { diagnosticGesture = null; };
    for (const key of ['sceneLastPointerDown', 'sceneLastPointerUp', 'sceneLastPointerClick', 'scenePaintSerial', 'sceneGeometrySerial']) delete host.dataset[key];
    let pressTimer: ReturnType<typeof setTimeout> | undefined;
    const heldNow = () => new Set([...current.current.heldIds, ...localHeld, ...(pressed ? [pressed.id] : [])]);
    let revealFocus = false;
    const observed = new Set<HTMLElement>();
    const drawOrder = () => {
      const held = heldNow();
      return [...current.current.items].reverse().sort((a, b) => Number(held.has(a.id)) - Number(held.has(b.id)));
    };
    // drawable自身は変形せず、その内側だけを遠近変形する。装飾は矩形内に収める。
    const applyPose = (node: HTMLDivElement, box: SceneBox, tip?: DominoTransform) => {
      const face = node.querySelector<HTMLElement>(':scope > [data-scene-face]');
      const footprint = node.querySelector<HTMLElement>(':scope > [data-scene-footprint]');
      const shade = face?.querySelector<HTMLElement>(':scope > [data-scene-shade]');
      if (!face || !footprint || !shade) return;
      const padding = tip ? DOMINO_CAPTURE_PADDING : 0;
      node.style.padding = `${padding}px`;
      node.dataset.sceneCapturePadding = String(padding);
      face.style.width = `${box.width}px`;
      face.style.height = pressed?.id === node.dataset.sceneCard ? `${box.height}px` : '';
      face.style.overflow = pressed?.id === node.dataset.sceneCard ? 'clip' : '';
      footprint.style.inset = `${padding}px`;
      face.style.transform = tip?.perspective.cssTransform ?? '';
      face.style.transformOrigin = tip?.perspective.transformOrigin ?? '50% 100%';
      footprint.style.background = tip?.perspective.shade.footprintGradient ?? '';
      footprint.style.opacity = String(tip?.perspective.shade.footprintOpacity ?? 0);
      shade.style.background = tip?.perspective.shade.faceGradient ?? '';
      shade.style.opacity = String(tip?.perspective.shade.faceOpacity ?? 0);
      shade.style.boxShadow = tip?.perspective.shade.edgeShadow ?? '';
    };
    const geometry = () => {
      geometrySeq = nextSerial(geometrySeq); host.dataset.sceneGeometrySerial = String(geometrySeq);
      const order = new Map(drawOrder().map((item, index) => [item.id, index]));
      for (const [id, node] of nodes.current) {
        const box = boxes.get(id);
        if (!box) continue;
        node.style.width = `${box.width}px`;
        node.style.height = pressed?.id === id ? `${pressed.box.height}px` : '';
        node.style.overflow = pressed?.id === id ? 'clip' : '';
        node.style.zIndex = String(order.get(id) ?? 0);
        const card = motion.cards.get(id);
        const target = targets.get(id) ?? box;
        node.dataset.sceneX = box.x.toFixed(2); node.dataset.sceneY = box.y.toFixed(2);
        node.dataset.sceneTargetX = target.x.toFixed(2); node.dataset.sceneTargetY = target.y.toFixed(2);
        node.dataset.scenePhase = card?.phase ?? 'settled';
        node.dataset.sceneDelay = String(Math.round(card?.delayMs ?? 0));
        const tip = dominoTransforms.get(id);
        node.dataset.sceneTip = String(tip?.amount ?? 0);
        applyPose(node, box, tip);
        if (mode === 'dom') {
          const padding = tip ? DOMINO_CAPTURE_PADDING : 0;
          node.style.transform = `translate(${camera.x + box.x - padding}px,${camera.y + box.y - padding}px) scale(1)`;
          displayed.set(id, { box: { ...box }, transform: tip ? { ...tip } : undefined });
        }
      }
    };
    const changeMode = (next: CanvasMode) => {
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const selection = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : null;
      mode = next; displayed.clear();
      surface.hidden = next === 'dom';
      effectSvg.current!.style.display = next === 'dom' ? '' : 'none';
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
        if (pressed && !nodes.current.has(pressed.id)) releasePress();
        for (const id of displayed.keys()) if (!nodes.current.has(id)) displayed.delete(id);
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
          const held = heldNow();
          for (const [id, node] of nodes.current) {
            const parent = mode === 'dom' ? dom : surface;
            if (node.parentNode !== parent) {
              node.style.transform = '';
              if (mode === 'modern') node.setAttribute('drawable', ''); else node.removeAttribute('drawable');
              parent.appendChild(node);
            }
            const measuredWidth = held.has(id) ? boxes.get(id)?.width : undefined;
            const face = node.querySelector<HTMLElement>(':scope > [data-scene-face]');
            const width = measuredWidth ?? Math.max(160, Math.min(360, viewportWidth - 32));
            node.style.width = `${width}px`;
            if (face) face.style.width = `${width}px`;
            // 捕捉用paddingは配置の高さに含めず、変形前の面だけを測定・監視する。
            heights.set(id, face?.offsetHeight || 120);
            if (face && !observed.has(face)) { observer.observe(face); observed.add(face); }
          }
          for (const node of observed) if (!Array.from(nodes.current.values()).some(root => root.contains(node))) { observer.unobserve(node); observed.delete(node); }
          const plan = updateSceneLayout(layout, current.current.items, heights, viewportWidth, held, boxes);
          layout = plan;
          targets = plan.boxes;
          motion = retargetSceneMotion(motion, targets, { chainOrder: plan.chainOrder, heldIds: held, reducedMotion });
          layoutDirty = false;
        }
        motion = advanceSceneMotion(motion, lastFrameTime === null ? 0 : Math.max(0, time - lastFrameTime), { heldIds: heldNow(), reducedMotion });
        lastFrameTime = time;
        boxes = sceneMotionBoxes(motion);
        if (pressed) boxes.set(pressed.id, pressed.box);
        const bottom = Math.max(viewportHeight, ...[...boxes.values(), ...targets.values()].map(box => box.y + box.height + 16));
        extent.current!.style.height = `${bottom}px`;
        host.scrollLeft = 0;
        camera = { x: 0, y: -host.scrollTop, zoom: 1 };
        // 新着batchだけが効果を開始する。描画modeや通常reflowで寿命を延長しない。
        if (effect.revision !== layout.insertion.revision) {
          effect.revision = layout.insertion.revision;
          effect.startedAt = time;
          effect.active = chosenEffect.current !== 'off' && !reducedMotion && layout.insertion.traces.some(trace => trace.edges.length > 0);
        }
        if (reducedMotion || !layout.insertion.traces.length || time - effect.startedAt >= (chosenEffect.current === 'domino' ? DOMINO_EFFECT_DURATION_MS : PUSH_EFFECT_DURATION_MS)) effect.active = false;
        effectAge = time - effect.startedAt;
        effectOpacity = effect.active && chosenEffect.current === 'sparkle' ? pushEffectOpacity(effectAge) : 0;
        dominoTransforms = effect.active && chosenEffect.current === 'domino'
          ? createDominoTransforms(layout.insertion.traces, boxes, effectAge, { heldIds: heldNow(), reducedMotion, directionBoxes: targets })
          : new Map();
        if (pressed && !reducedMotion && chosenEffect.current === 'domino') {
          dominoTransforms = new Map(dominoTransforms).set(pressed.id, pressed.transform);
        }
        effectViewport = { x: 0, y: host.scrollTop, width: viewportWidth, height: viewportHeight };
        effectPaths = effect.active && chosenEffect.current === 'sparkle' ? createPushPaths(layout.insertion.traces, boxes, effectViewport) : [];
        host.dataset.sceneEffect = chosenEffect.current;
        host.dataset.scenePushEffect = reducedMotion ? 'reduced' : effect.active ? 'active' : 'idle';
        // 曲線は粒子の配置にだけ使い、前面に独立した光点だけを描く。
        const particles = mode === 'dom' && effectOpacity > 0 ? createPushParticles(effectPaths, effectAge, effectViewport) : [];
        const particleGroup = effectParticleGroup.current!;
        while (particleGroup.children.length > particles.length * 3) particleGroup.lastElementChild!.remove();
        for (let i = 0; i < particles.length; i++) {
          const particle = particles[i];
          let halo = particleGroup.children[i * 3];
          if (!halo) { halo = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); particleGroup.appendChild(halo); }
          halo.setAttribute('cx', String(particle.x)); halo.setAttribute('cy', String(particle.y));
          halo.setAttribute('r', String(particle.haloRadius));
          halo.setAttribute('fill', particle.haloColor);
          halo.setAttribute('opacity', String(effectOpacity * particle.haloAlpha));
          let shape = particleGroup.children[i * 3 + 1];
          if (!shape) { shape = document.createElementNS('http://www.w3.org/2000/svg', 'path'); particleGroup.appendChild(shape); }
          shape.setAttribute('d', particle.d);
          shape.setAttribute('fill', particle.color);
          shape.setAttribute('opacity', String(effectOpacity * particle.alpha));
          let core = particleGroup.children[i * 3 + 2];
          if (!core) { core = document.createElementNS('http://www.w3.org/2000/svg', 'path'); particleGroup.appendChild(core); }
          core.setAttribute('d', particle.coreD);
          core.setAttribute('fill', particle.coreColor);
          core.setAttribute('opacity', String(effectOpacity * particle.coreAlpha));
        }
        effectGroup.current!.setAttribute('transform', `translate(0 ${camera.y})`);
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
        if (motion.active || effect.active) requestFrame();
        else lastFrameTime = null;
      });
    };
    const refresh = () => { layoutDirty = true; requestFrame(); };
    const preference = () => { reducedMotion = media?.matches ?? false; if (reducedMotion) releasePress(); refresh(); };
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
          const tip = dominoTransforms.get(item.id);
          // 内側CSSの遠近と影はsnapshotに含まれるため、CTMで二重変形しない。
          const padding = tip ? DOMINO_CAPTURE_PADDING : 0;
          const transform = ctx.drawElementImage(node, box.x - padding, box.y - padding, box.width + padding * 2, box.height + padding * 2);
          displayed.set(item.id, { box: { ...box }, transform: tip ? { ...tip } : undefined });
          if (mode === 'legacy' && transform) node.style.transform = transform.toString();
          painted = true;
        }
        drawPushPaths(ctx, effectPaths, effectOpacity, effectAge, effectViewport);
        paintSeq = nextSerial(paintSeq); host.dataset.scenePaintSerial = String(paintSeq);
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
      // offsetTopには捕捉paddingが入るが、boxは元のカード面の座標。
      const padding = Number(node?.dataset.sceneCapturePadding) || 0;
      const top = box.y + offsetY - padding;
      if (top < host.scrollTop || top + controlHeight > host.scrollTop + r.height) {
        host.scrollTop = Math.max(0, top < host.scrollTop || controlHeight >= r.height ? top - 16 : top + controlHeight - r.height + 16);
        camera = { x: 0, y: -host.scrollTop, zoom: 1 };
        requestFrame();
      }
    };
    // pointerdownで実表示を保存し、focusによる変形解除でclick対象が逃げるのを防ぐ。
    const releasePress = () => {
      clearTimeout(pressTimer); pressTimer = undefined;
      if (!pressed) return;
      pressed = null; refresh();
    };
    const press = (event: PointerEvent) => {
      if (pressed || event.button !== 0 || event.isPrimary === false || reducedMotion || chosenEffect.current !== 'domino') return;
      const id = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-scene-card]')?.dataset.sceneCard : undefined;
      const snapshot = id ? displayed.get(id) : undefined;
      const box = snapshot?.box;
      const transform = snapshot?.transform;
      if (!id || !box || !transform) return;
      pressed = { pointerId: event.pointerId, id, box: { ...box }, transform: { ...transform }, released: false };
      revealFocus = false; refresh();
    };
    const pointerUp = (event: PointerEvent) => {
      if (!pressed || event.pointerId !== pressed.pointerId) return;
      pressed.released = true;
      // touch互換clickも待つ。clickなしのdrag/選択は有限時間で必ず解除する。
      clearTimeout(pressTimer); pressTimer = setTimeout(releasePress, 700);
    };
    const pointerCancel = (event: PointerEvent) => { if (pressed?.pointerId === event.pointerId) releasePress(); };
    const clicked = (event: MouseEvent) => {
      if (!pressed?.released) return;
      if ('pointerId' in event && event.pointerId !== pressed.pointerId) return;
      clearTimeout(pressTimer); pressTimer = setTimeout(releasePress, 0);
    };
    const focus = (event: FocusEvent) => {
      const id = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-scene-card]')?.dataset.sceneCard : undefined;
      localHeld.clear(); if (id) localHeld.add(id);
      revealFocus = !(pressed && pressed.id === id); refresh();
    };
    const blur = () => { localHeld.clear(); refresh(); };
    runtime.current = { refresh, camera, chooseEffect: () => { releasePress(); if (mode === 'legacy' && chosenEffect.current === 'domino') changeMode('dom'); effect.active = false; dominoTransforms = new Map(); requestFrame(); }, reset: () => { host.scrollTop = 0; requestFrame(); }, attach: node => {
      if (mode === 'modern') node.setAttribute('drawable', ''); else node.removeAttribute('drawable');
      (mode === 'dom' ? dom : surface).appendChild(node);
    } };
    surface.addEventListener('paint', paint);
    // 固定サイズ画像の読込完了でもnative再描画を要求する。
    host.addEventListener('canvas-image-ready', refresh);
    host.addEventListener('scroll', scroll, { passive: true });
    window.addEventListener('pointerdown', diagnosticDown, { capture: true, passive: true });
    window.addEventListener('pointerup', diagnosticUp, { capture: true, passive: true });
    window.addEventListener('click', diagnosticClick, { capture: true, passive: true });
    window.addEventListener('pointercancel', clearDiagnosticGesture, true); window.addEventListener('blur', clearDiagnosticGesture);
    host.addEventListener('pointerdown', press, true);
    window.addEventListener('pointerup', pointerUp, true); window.addEventListener('pointercancel', pointerCancel, true);
    window.addEventListener('click', clicked, true); window.addEventListener('blur', releasePress);
    host.addEventListener('focusin', focus); host.addEventListener('focusout', blur);
    window.addEventListener('resize', refresh);
    changeMode(mode); refresh();
    return () => {
      media?.removeEventListener('change', preference);
      disposed = true; clearTimeout(pressTimer); pressed = null; cancelAnimationFrame(frame); clearTimeout(watchdog.timer); observer.disconnect();
      surface.removeEventListener('paint', paint); host.removeEventListener('scroll', scroll);
      host.removeEventListener('canvas-image-ready', refresh);
      window.removeEventListener('pointerdown', diagnosticDown, true); window.removeEventListener('pointerup', diagnosticUp, true);
      window.removeEventListener('click', diagnosticClick, true); window.removeEventListener('pointercancel', clearDiagnosticGesture, true);
      window.removeEventListener('blur', clearDiagnosticGesture); diagnosticGesture = null;
      host.removeEventListener('pointerdown', press, true);
      window.removeEventListener('pointerup', pointerUp, true); window.removeEventListener('pointercancel', pointerCancel, true);
      window.removeEventListener('click', clicked, true); window.removeEventListener('blur', releasePress);
      host.removeEventListener('focusin', focus); host.removeEventListener('focusout', blur); window.removeEventListener('resize', refresh);
    };
  }, [forcedDOM]);

  return <section className={`flex min-h-0 flex-1 flex-col ${className ?? ''}`} aria-label="V2 canvas">
    <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-white px-4 py-2 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
      <span role="status" data-renderer-status>{status}</span>
      <button type="button" onClick={() => setForcedDOM(value => !value)} className="rounded border px-2 py-1">{forcedDOM ? 'Nativeを試す' : 'DOMに切替'}</button>
      <button type="button" onClick={() => runtime.current?.reset()} className="rounded border px-2 py-1">先頭に戻る</button>
      <label className="flex items-center gap-1">エフェクト
        <select aria-label="新着エフェクト" value={effectChoice} onChange={event => setEffectPreference(event.target.value as SceneEffectChoice)} className="rounded border bg-transparent px-2 py-1">
          <option value="off">OFF</option><option value="sparkle">キラキラ</option><option value="domino">ドミノ（試作）</option>
        </select>
      </label>
      <span>縦スクロールで移動</span>
    </div>
    <div ref={viewport} tabIndex={0} aria-label="カード領域。縦スクロールで移動" className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-zinc-100 dark:bg-zinc-950" style={{ touchAction: 'pan-y pinch-zoom', overflowAnchor: 'none', scrollbarGutter: 'stable' }}>
      <div ref={extent} className="relative w-full" style={{ overflowAnchor: 'none' }}>
        <div ref={layer} className="sticky top-0 w-full overflow-clip">
          <canvas ref={canvas} className="absolute inset-0 z-0 h-full w-full" aria-label="ライブカード" />
          <div ref={fallback} className="absolute inset-0 z-0 isolate" />
          <svg ref={effectSvg} aria-hidden="true" className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible"><g ref={effectGroup}><g ref={effectParticleGroup} /></g></svg>
        </div>
      </div>
      {items.map(item => <CardRoot key={item.id} item={item} register={register} />)}
    </div>
  </section>;
}
