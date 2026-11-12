"use client";

import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { detectCanvasMode, createSceneLayout, updateSceneLayout, type Camera, type CanvasMode, type DrawableCanvas, type DrawableContext, type SceneBox } from "./scene";

import { createSceneMotion, retargetSceneMotion, advanceSceneMotion, sceneMotionBoxes, type SceneMotionState } from "./sceneMotion";

import type { Card } from "../../lib/types";
import { createPushPaths, createPushParticles, drawPushPaths, pushEffectOpacity, PUSH_EFFECT_DURATION_MS, type PushEffectPath, type PushEffectBox } from "./pushEffect";

import { createRadialRipple, freezeRippleSources, freezeRippleTargets, RIPPLE_EFFECT_DURATION_MS, RIPPLE_EFFECT_SPEED_PX_PER_MS, type RadialRipple, type RippleSource } from "./rippleEffect";
import { createDominoTransforms, DOMINO_EFFECT_DURATION_MS, DOMINO_PERSPECTIVE_MAX_OUTSET, type DominoTransform } from "./dominoEffect";
import { createWebGLSceneRenderer, classifyWebGLSceneError } from "./webglSceneRenderer";
import { summarizeFrames, type GeometryCanvas, type HtmlTextureGL } from "./webglDomino";
import { getEffectPreference, serverEffectPreference, subscribeEffectPreference, setEffectPreference, type SceneEffectChoice } from "./effectPreference";

export interface CanvasSceneItem { id: string; content: ReactNode; card?: Card }
interface Props { items: CanvasSceneItem[]; heldIds?: ReadonlySet<string>; className?: string; qaMeasurementToken?: number }
const EMPTY = new Set<string>();
// 投影の越境上限64pxとアンチエイリアスの余白。効果中は固定し毎frame寸法を変えない。
const DOMINO_CAPTURE_PADDING = DOMINO_PERSPECTIVE_MAX_OUTSET + 2;

type FallbackStage = 'none' | 'manual' | 'init' | 'render' | 'watchdog' | 'context-loss' | 'legacy-effect';
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

export function CanvasScene({ items, heldIds = EMPTY, className, qaMeasurementToken = 0 }: Props) {
  const effectChoice = useSyncExternalStore(subscribeEffectPreference, getEffectPreference, serverEffectPreference);
  const chosenEffect = useRef(effectChoice);
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<DrawableCanvas>(null);
  const gpuCanvas = useRef<GeometryCanvas>(null);
  const extent = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const fallback = useRef<HTMLDivElement>(null);
  const savedEffect = useRef({ revision: 0, startedAt: 0, active: false });
  const savedRippleSources = useRef<readonly RippleSource[]>([]);
  const savedRippleTargets = useRef<ReadonlySet<string>>(new Set());
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const savedBoxes = useRef(new Map<string, SceneBox>());
  const savedMotion = useRef<SceneMotionState | null>(null);
  const savedTargets = useRef(new Map<string, SceneBox>());
  const savedLayout = useRef(createSceneLayout());
  const runtime = useRef<{ refresh: () => void; attach: (node: HTMLDivElement) => void; reset: () => void; chooseEffect: () => void; measure: () => void; camera: Camera } | null>(null);
  const current = useRef({ items, heldIds });
  const [status, setStatus] = useState('DOM fallback · 初期化中');
  const [forcedDOM, setForcedDOM] = useState(false);
  const [renderer, setRenderer] = useState<'webgl' | 'css'>('webgl');
  const [metrics, setMetrics] = useState('未計測。rAF間隔でありCPU/GPU時間ではありません。');
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
    const cssSurface = canvas.current!;
    const gpuSurface = gpuCanvas.current!;
    const surface = renderer === 'webgl' ? gpuSurface : cssSurface;
    const dom = fallback.current!;
    let ctx: DrawableContext | null = null;
    let gpu: ReturnType<typeof createWebGLSceneRenderer> | null = null;
    let supported: CanvasMode = 'dom';
    let fallbackStage: FallbackStage = forcedDOM ? 'manual' : 'init';
    let fallbackReason = forcedDOM ? 'requested' : 'api-unavailable';
    if (!forcedDOM) try {
      if (renderer === 'webgl') {
        const gl = gpuSurface.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: true }) as HtmlTextureGL | null;
        if (gl && gpuSurface.requestPaint && 'content' in gpuSurface) { gpu = createWebGLSceneRenderer(gl, gpuSurface); supported = 'modern'; }
      } else { ctx = cssSurface.getContext('2d') as DrawableContext | null; supported = detectCanvasMode(cssSurface, ctx); }
    } catch (error) { supported = 'dom'; fallbackReason = classifyWebGLSceneError(error); }
    let mode: CanvasMode = forcedDOM || supported === 'legacy' && chosenEffect.current === 'domino' ? 'dom' : supported;
    if (mode !== 'dom') { fallbackStage = 'none'; fallbackReason = 'none'; }
    else if (!forcedDOM && supported === 'legacy') { fallbackStage = 'legacy-effect'; fallbackReason = 'unsupported'; }
    let boxes = savedBoxes.current;
    let targets = savedTargets.current;
    let layout = savedLayout.current;
    let motion = savedMotion.current ?? createSceneMotion();
    let layoutDirty = true;
    let viewWidth = 1, viewHeight = 1;
    const dirtyIds = new Set(current.current.items.map(item => item.id));
    let totalUploads = 0, totalDraws = 0, textureBytes = 0;
    let measurement: { start: number | null; previous: number | null; samples: number[]; draws: number; uploads: number } | null = null;
    const effect = savedEffect.current;
    let effectPaths: readonly PushEffectPath[] = [];
    let effectViewport: PushEffectBox | undefined;
    let effectOpacity = 0;
    let effectAge = 0;
    let dominoTransforms: ReadonlyMap<string, DominoTransform> = new Map();
    let radialRipple: RadialRipple | undefined;
    let ripplePointer: { pointerId: number; id: string } | null = null;
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
    const setStyle = (node: HTMLElement, key: keyof CSSStyleDeclaration, value: string) => {
      if (node.style[key] !== value) (node.style as unknown as Record<string, string>)[key as string] = value;
    };
    // drawable自身は変形せず、その内側だけを遠近変形する。装飾は矩形内に収める。
    const applyPose = (node: HTMLDivElement, box: SceneBox, tip?: DominoTransform) => {
      const face = node.querySelector<HTMLElement>(':scope > [data-scene-face]');
      const footprint = node.querySelector<HTMLElement>(':scope > [data-scene-footprint]');
      const shade = face?.querySelector<HTMLElement>(':scope > [data-scene-shade]');
      if (!face || !footprint || !shade) return;
      const visualTip = renderer === 'css' && mode !== 'dom' ? tip : undefined;
      const padding = visualTip ? DOMINO_CAPTURE_PADDING : 0;
      setStyle(node, 'padding', `${padding}px`);
      node.dataset.sceneCapturePadding = String(padding);
      setStyle(face, 'width', `${box.width}px`);
      setStyle(face, 'height', pressed?.id === node.dataset.sceneCard ? `${box.height}px` : '');
      setStyle(face, 'overflow', pressed?.id === node.dataset.sceneCard ? 'clip' : '');
      setStyle(footprint, 'inset', `${padding}px`);
      setStyle(face, 'transform', visualTip?.perspective.cssTransform ?? '');
      setStyle(face, 'transformOrigin', visualTip?.perspective.transformOrigin ?? '50% 100%');
      setStyle(footprint, 'background', visualTip?.perspective.shade.footprintGradient ?? '');
      setStyle(footprint, 'opacity', String(visualTip?.perspective.shade.footprintOpacity ?? 0));
      setStyle(shade, 'background', visualTip?.perspective.shade.faceGradient ?? '');
      setStyle(shade, 'opacity', String(visualTip?.perspective.shade.faceOpacity ?? 0));
      setStyle(shade, 'boxShadow', visualTip?.perspective.shade.edgeShadow ?? '');
    };
    const geometry = () => {
      geometrySeq = nextSerial(geometrySeq); host.dataset.sceneGeometrySerial = String(geometrySeq);
      const order = new Map(drawOrder().map((item, index) => [item.id, index]));
      for (const [id, node] of nodes.current) {
        const box = boxes.get(id);
        if (!box) continue;
        setStyle(node, 'width', `${box.width}px`);
        // GPUのsource border boxと論理quadを一致させる。面の自然高は別途測る。
        setStyle(node, 'height', renderer === 'webgl' && mode !== 'dom' ? `${box.height}px` : pressed?.id === id ? `${pressed.box.height}px` : '');
        setStyle(node, 'overflow', pressed?.id === id ? 'clip' : '');
        setStyle(node, 'zIndex', String(order.get(id) ?? 0));
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
          setStyle(node, 'transform', `translate(${camera.x + box.x - padding}px,${camera.y + box.y - padding}px) scale(1)`);
          displayed.set(id, { box: { ...box }, transform: tip ? { ...tip } : undefined });
        }
      }
    };
    const changeMode = (next: CanvasMode, stage?: FallbackStage, reason?: string) => {
      if (stage) { fallbackStage = stage; fallbackReason = reason ?? 'unknown'; }
      if (next !== 'dom') { fallbackStage = 'none'; fallbackReason = 'none'; }
      host.dataset.sceneFallbackStage = fallbackStage;
      host.dataset.sceneFallbackReason = fallbackReason;
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const selection = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : null;
      mode = next; displayed.clear();
      host.dataset.sceneRenderer = next === 'dom' ? 'dom' : renderer;
      // DOMでは追加効果を止め、nativeへ戻っても過去のbatchを再生しない。
      if (next === 'dom') {
        effect.active = false; dominoTransforms = new Map(); radialRipple = undefined; ripplePointer = null; effectPaths = []; effectOpacity = 0;
        clearTimeout(pressTimer); pressTimer = undefined; pressed = null;
        gpu?.dispose(); gpu = null; measurement = null;
      }
      cssSurface.hidden = next === 'dom' || renderer !== 'css';
      gpuSurface.hidden = next === 'dom' || renderer !== 'webgl';
      dom.hidden = next !== 'dom';
      for (const candidate of [cssSurface, gpuSurface]) { candidate.removeAttribute('content'); candidate.removeAttribute('layoutsubtree'); }
      if (next === 'modern') surface.setAttribute('content', 'drawable');
      if (next === 'legacy') surface.setAttribute('layoutsubtree', '');
      for (const node of nodes.current.values()) {
        setStyle(node, 'transform', '');
        if (next === 'modern') node.setAttribute('drawable', ''); else node.removeAttribute('drawable');
        (next === 'dom' ? dom : surface).appendChild(node);
      }
      setStatus(next === 'dom' ? (forcedDOM ? 'DOM fallback · 手動' : `DOM fallback · ${fallbackStage}/${fallbackReason}`) : 'HTML-in-Canvas · 最初の描画を確認中');
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
        viewWidth = viewportWidth; viewHeight = viewportHeight;
        if (measurement) {
          measurement.start ??= time;
          if (measurement.previous !== null && measurement.samples.length < 1200) measurement.samples.push(time - measurement.previous);
          measurement.previous = time;
          if (time - measurement.start >= 5000) {
            const result = summarizeFrames(measurement.samples);
            setMetrics(`${renderer} / ${result.count} rAF intervals / p50 ${result.p50.toFixed(1)}ms / p95 ${result.p95.toFixed(1)}ms / >33.4ms ${result.over33} / draw ${totalDraws - measurement.draws} / upload ${totalUploads - measurement.uploads} / cache ${(textureBytes / 1048576).toFixed(1)}MiB`);
            measurement = null;
          }
        }
        layer.current!.style.height = `${viewportHeight}px`;
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round(viewportWidth * dpr));
        const h = Math.max(1, Math.round(viewportHeight * dpr));
        if (surface.width !== w || surface.height !== h) {
          surface.width = w; surface.height = h;
          for (const item of current.current.items) dirtyIds.add(item.id);
        }
        if (layoutDirty) {
          const held = heldNow();
          for (const [id, node] of nodes.current) {
            const parent = mode === 'dom' ? dom : surface;
            if (node.parentNode !== parent) {
              setStyle(node, 'transform', '');
              if (mode === 'modern') node.setAttribute('drawable', ''); else node.removeAttribute('drawable');
              parent.appendChild(node);
            }
            const measuredWidth = held.has(id) ? boxes.get(id)?.width : undefined;
            const face = node.querySelector<HTMLElement>(':scope > [data-scene-face]');
            const width = measuredWidth ?? Math.max(160, Math.min(360, viewportWidth - 32));
            setStyle(node, 'width', `${width}px`);
            if (face) setStyle(face, 'width', `${width}px`);
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
          savedRippleSources.current = freezeRippleSources(layout.insertion.traces, targets);
          savedRippleTargets.current = freezeRippleTargets(layout.insertion.traces, savedRippleSources.current);
          effect.active = mode !== 'dom' && (chosenEffect.current !== 'ripple' || renderer === 'webgl') && chosenEffect.current !== 'off' && !reducedMotion && (chosenEffect.current === 'ripple' ? savedRippleSources.current.length > 0 && savedRippleTargets.current.size > 0 : layout.insertion.traces.some(trace => trace.edges.length > 0));
        }
        if (mode === 'dom' || chosenEffect.current === 'ripple' && renderer !== 'webgl' || reducedMotion || (chosenEffect.current === 'ripple' ? !savedRippleSources.current.length || !savedRippleTargets.current.size : !layout.insertion.traces.length) || time - effect.startedAt >= (chosenEffect.current === 'domino' ? DOMINO_EFFECT_DURATION_MS : chosenEffect.current === 'ripple' ? RIPPLE_EFFECT_DURATION_MS : PUSH_EFFECT_DURATION_MS)) effect.active = false;
        effectAge = time - effect.startedAt;
        effectOpacity = effect.active && chosenEffect.current === 'sparkle' ? pushEffectOpacity(effectAge) : 0;
        dominoTransforms = effect.active && chosenEffect.current === 'domino'
          ? createDominoTransforms(layout.insertion.traces, boxes, effectAge, { heldIds: heldNow(), reducedMotion, directionBoxes: targets })
          : new Map();
        if (ripplePointer && !current.current.items.some(item => item.id === ripplePointer!.id)) ripplePointer = null;
        radialRipple = effect.active && chosenEffect.current === 'ripple' && renderer === 'webgl'
          ? createRadialRipple(savedRippleSources.current, effectAge, { reducedMotion })
          : undefined;
        const rippleHeld = heldNow();
        host.dataset.sceneRippleCards = String(radialRipple ? current.current.items.filter(item => savedRippleTargets.current.has(item.id) && !rippleHeld.has(item.id) && ripplePointer?.id !== item.id).length : 0);
        host.dataset.sceneRippleTargets = JSON.stringify(radialRipple ? [...savedRippleTargets.current] : []);
        host.dataset.sceneRippleSources = JSON.stringify(radialRipple?.sources.map(({ x, y }) => [x, y]) ?? []);
        host.dataset.sceneRippleRadius = String(radialRipple ? effectAge * RIPPLE_EFFECT_SPEED_PX_PER_MS : 0);
        if (pressed && !reducedMotion && chosenEffect.current === 'domino') {
          dominoTransforms = new Map(dominoTransforms).set(pressed.id, pressed.transform);
        }
        effectViewport = { x: 0, y: host.scrollTop, width: viewportWidth, height: viewportHeight };
        effectPaths = effect.active && chosenEffect.current === 'sparkle' ? createPushPaths(layout.insertion.traces, boxes, effectViewport) : [];
        host.dataset.sceneEffect = chosenEffect.current;
        host.dataset.scenePushEffect = reducedMotion ? 'reduced' : effect.active ? 'active' : 'idle';
        host.dataset.sceneMotion = reducedMotion ? 'reduced' : motion.active ? 'animating' : 'settled';
        if (revealFocus) { revealFocus = false; reveal(document.activeElement); }
        savedBoxes.current = boxes;
        savedMotion.current = motion; savedTargets.current = targets; savedLayout.current = layout;
        geometry();
        runtime.current!.camera = camera;
        if (mode !== 'dom') {
          surface.requestPaint?.();
          if (!painted && current.current.items.length && watchdog.timer === undefined) watchdog.timer = setTimeout(() => {
            if (!painted && !disposed) { changeMode('dom', 'watchdog', 'paint-timeout'); refresh(); }
          }, 2500);
        }
        if (motion.active || effect.active || measurement) requestFrame();
        else lastFrameTime = null;
      });
    };
    const refresh = () => { layoutDirty = true; requestFrame(); };
    const preference = () => { reducedMotion = media?.matches ?? false; if (reducedMotion) { ripplePointer = null; releasePress(); } refresh(); };
    media?.addEventListener('change', preference);
    const observer = new ResizeObserver(refresh);
    observer.observe(host);
    const paint = (event: Event) => {
      if (mode === 'dom' || disposed) return;
      try {
        if (renderer === 'webgl' && gpu) {
          const paintHeld = heldNow();
          const cards = drawOrder().flatMap(item => {
            const node = nodes.current.get(item.id), box = boxes.get(item.id);
            return node && box ? [{ id: item.id, node, box, tip: dominoTransforms.get(item.id), ripple: reducedMotion || chosenEffect.current !== 'ripple' || !savedRippleTargets.current.has(item.id) || paintHeld.has(item.id) || ripplePointer?.id === item.id ? undefined : radialRipple }] : [];
          });
          const stats = gpu.render({ cards, camera, viewportWidth: viewWidth, viewportHeight: viewHeight,
            changedElements: (event as Event & { changedElements?: readonly Element[] }).changedElements,
            dirtyIds, pinnedIds: heldNow(), particles: createPushParticles(effectPaths, effectAge, effectViewport), particleOpacity: effectOpacity });
          dirtyIds.clear(); totalDraws += stats.draws; totalUploads += stats.uploads; textureBytes = stats.textureBytes;
          const drawn = new Set(stats.drawnIds);
          for (const card of cards) {
            if (drawn.has(card.id)) displayed.set(card.id, { box: { ...card.box }, transform: card.tip ? { ...card.tip } : undefined });
            else displayed.delete(card.id);
          }
          painted = true;
        } else if (ctx) {
          ctx.resetTransform(); ctx.clearRect(0, 0, surface.width, surface.height);
          const dpr = window.devicePixelRatio || 1;
          ctx.setTransform(dpr, 0, 0, dpr, dpr * camera.x, dpr * camera.y);
          for (const item of drawOrder()) {
            const node = nodes.current.get(item.id), box = boxes.get(item.id);
            if (!node || !box) continue;
            const tip = dominoTransforms.get(item.id), padding = tip ? DOMINO_CAPTURE_PADDING : 0;
            const transform = ctx.drawElementImage(node, box.x - padding, box.y - padding, box.width + padding * 2, box.height + padding * 2);
            displayed.set(item.id, { box: { ...box }, transform: tip ? { ...tip } : undefined });
            if (mode === 'legacy' && transform) setStyle(node, 'transform', transform.toString());
            totalDraws++; totalUploads++; painted = true;
          }
          drawPushPaths(ctx, effectPaths, effectOpacity, effectAge, effectViewport);
        }
        paintSeq = nextSerial(paintSeq); host.dataset.scenePaintSerial = String(paintSeq);
        host.dataset.sceneUploads = String(totalUploads); host.dataset.sceneDraws = String(totalDraws); host.dataset.sceneTextureBytes = String(textureBytes);
        if (painted) { clearTimeout(watchdog.timer); setStatus(`HTML-in-Canvas · native ${renderer === 'webgl' ? 'WebGL' : mode + ' CSS比較'}`); }
      } catch (error) { changeMode('dom', 'render', classifyWebGLSceneError(error)); refresh(); }
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
      if (chosenEffect.current === 'ripple' && renderer === 'webgl' && mode !== 'dom' && !reducedMotion && !ripplePointer && event.button === 0 && event.isPrimary !== false) {
        const id = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-scene-card]')?.dataset.sceneCard : undefined;
        if (id) { ripplePointer = { pointerId: event.pointerId, id }; requestFrame(); }
      }
      if (pressed || event.button !== 0 || event.isPrimary === false || reducedMotion || chosenEffect.current !== 'domino') return;
      const id = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-scene-card]')?.dataset.sceneCard : undefined;
      const snapshot = id ? displayed.get(id) : undefined;
      const box = snapshot?.box;
      const transform = snapshot?.transform;
      if (!id || !box || !transform) return;
      pressed = { pointerId: event.pointerId, id, box: { ...box }, transform: { ...transform }, released: false };
      revealFocus = false; refresh();
    };
    const releaseRipple = () => { if (ripplePointer) { ripplePointer = null; requestFrame(); } };
    const pointerUp = (event: PointerEvent) => {
      if (ripplePointer?.pointerId === event.pointerId) releaseRipple();
      if (!pressed || event.pointerId !== pressed.pointerId) return;
      pressed.released = true;
      // touch互換clickも待つ。clickなしのdrag/選択は有限時間で必ず解除する。
      clearTimeout(pressTimer); pressTimer = setTimeout(releasePress, 700);
    };
    const pointerCancel = (event: PointerEvent) => { if (ripplePointer?.pointerId === event.pointerId) releaseRipple(); if (pressed?.pointerId === event.pointerId) releasePress(); };
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
    runtime.current = { refresh, camera, measure: () => {
      if (mode === 'dom') { setMetrics('DOMではnative比較計測を開始しません'); return; }
      measurement = { start: null, previous: null, samples: [], draws: totalDraws, uploads: totalUploads };
      setMetrics('5秒計測中…（自然な新着条件は同一ではありません）'); requestFrame();
    }, chooseEffect: () => { releaseRipple(); releasePress(); if (mode === 'legacy' && chosenEffect.current === 'domino') changeMode('dom', 'legacy-effect', 'unsupported'); effect.active = false; dominoTransforms = new Map(); radialRipple = undefined; requestFrame(); }, reset: () => { host.scrollTop = 0; requestFrame(); }, attach: node => {
      if (mode === 'modern') node.setAttribute('drawable', ''); else node.removeAttribute('drawable');
      (mode === 'dom' ? dom : surface).appendChild(node);
      const id = node.dataset.sceneCard; if (id) dirtyIds.add(id);
      mutation.observe(node, { subtree: true, childList: true, characterData: true, attributes: true });
    } };
    const invalidate = (event?: Event) => {
      const target = event?.target instanceof Element ? event.target.closest<HTMLElement>('[data-scene-card]') : null;
      const id = target?.dataset.sceneCard;
      if (id) dirtyIds.add(id); else for (const item of current.current.items) dirtyIds.add(item.id);
      requestFrame();
    };
    const mutation = new MutationObserver(records => {
      let changed = false;
      for (const record of records) {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        if (!target) continue;
        if (record.type === 'attributes' && (target.hasAttribute('data-scene-card') || target.hasAttribute('data-scene-face') || target.hasAttribute('data-scene-shade') || target.hasAttribute('data-scene-footprint'))) continue;
        const id = target.closest<HTMLElement>('[data-scene-card]')?.dataset.sceneCard;
        if (id) { dirtyIds.add(id); changed = true; }
      }
      if (changed && mode !== 'dom') requestFrame();
    });
    for (const node of nodes.current.values()) mutation.observe(node, { subtree: true, childList: true, characterData: true, attributes: true });
    const lost = (event: Event) => { event.preventDefault(); changeMode('dom', 'context-loss', 'context-lost'); refresh(); };
    surface.addEventListener('paint', paint); gpuSurface.addEventListener('webglcontextlost', lost);
    for (const type of ['input', 'change', 'focusin', 'focusout', 'pointerover', 'pointerout', 'load', 'canvas-image-ready']) host.addEventListener(type, invalidate, true);
    document.fonts?.addEventListener('loadingdone', invalidate);

    // 固定サイズ画像の読込完了でもnative再描画を要求する。
    host.addEventListener('canvas-image-ready', refresh);
    host.addEventListener('scroll', scroll, { passive: true });
    window.addEventListener('pointerdown', diagnosticDown, { capture: true, passive: true });
    window.addEventListener('pointerup', diagnosticUp, { capture: true, passive: true });
    window.addEventListener('click', diagnosticClick, { capture: true, passive: true });
    window.addEventListener('pointercancel', clearDiagnosticGesture, true); window.addEventListener('blur', clearDiagnosticGesture);
    host.addEventListener('pointerdown', press, true);
    window.addEventListener('pointerup', pointerUp, true); window.addEventListener('pointercancel', pointerCancel, true);
    window.addEventListener('click', clicked, true); window.addEventListener('blur', releasePress); window.addEventListener('blur', releaseRipple);
    host.addEventListener('focusin', focus); host.addEventListener('focusout', blur);
    window.addEventListener('resize', refresh);
    changeMode(mode); refresh();
    return () => {
      media?.removeEventListener('change', preference);
      disposed = true; clearTimeout(pressTimer); pressed = null; cancelAnimationFrame(frame); clearTimeout(watchdog.timer); observer.disconnect(); mutation.disconnect(); gpu?.dispose();
      surface.removeEventListener('paint', paint); gpuSurface.removeEventListener('webglcontextlost', lost); host.removeEventListener('scroll', scroll);
      for (const type of ['input', 'change', 'focusin', 'focusout', 'pointerover', 'pointerout', 'load', 'canvas-image-ready']) host.removeEventListener(type, invalidate, true);
      document.fonts?.removeEventListener('loadingdone', invalidate);
      host.removeEventListener('canvas-image-ready', refresh);
      window.removeEventListener('pointerdown', diagnosticDown, true); window.removeEventListener('pointerup', diagnosticUp, true);
      window.removeEventListener('click', diagnosticClick, true); window.removeEventListener('pointercancel', clearDiagnosticGesture, true);
      window.removeEventListener('blur', clearDiagnosticGesture); diagnosticGesture = null;
      host.removeEventListener('pointerdown', press, true);
      window.removeEventListener('pointerup', pointerUp, true); window.removeEventListener('pointercancel', pointerCancel, true);
      window.removeEventListener('click', clicked, true); window.removeEventListener('blur', releasePress); window.removeEventListener('blur', releaseRipple); ripplePointer = null;
      host.removeEventListener('focusin', focus); host.removeEventListener('focusout', blur); window.removeEventListener('resize', refresh);
    };
  }, [forcedDOM, renderer]);

  useLayoutEffect(() => { if (qaMeasurementToken > 0) runtime.current?.measure(); }, [qaMeasurementToken]);

  return <section className={`flex min-h-0 flex-1 flex-col ${className ?? ''}`} aria-label="V2 canvas">
    <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-white px-4 py-2 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
      <span role="status" data-renderer-status>{status}</span>
      <button type="button" onClick={() => setForcedDOM(value => !value)} className="rounded border px-2 py-1">{forcedDOM ? 'Nativeを試す' : 'DOMに切替'}</button>
      <button type="button" onClick={() => runtime.current?.reset()} className="rounded border px-2 py-1">先頭に戻る</button>
      <label className="flex items-center gap-1">エフェクト
        <select aria-label="新着エフェクト" value={effectChoice} onChange={event => setEffectPreference(event.target.value as SceneEffectChoice)} className="rounded border bg-transparent px-2 py-1">
          <option value="off">OFF</option><option value="sparkle">キラキラ</option><option value="domino">ドミノ（試作）</option><option value="ripple">波紋（試作）</option>
        </select>
      </label>
      <span>縦スクロールで移動 · エフェクトはnative専用（DOMでは停止）</span>
    </div>
    <details className="border-b px-4 py-1 text-xs">
      <summary>描画比較（QA）</summary>
      <label>比較方式 <select aria-label="QA描画方式" value={renderer} onChange={event => setRenderer(event.target.value as 'webgl' | 'css')}><option value="webgl">WebGL texture</option><option value="css">Canvas2D + CSS 比較</option></select></label>
      <button type="button" onClick={() => runtime.current?.measure()}>5秒frame比較</button>
      <output aria-label="実フィードframe比較結果">{metrics}</output>
      <p>rAF間隔と固定33.4ms超過数です。CPU/GPU時間ではなく、自然な新着条件も同一ではありません。</p>
    </details>
    <div ref={viewport} tabIndex={0} aria-label="カード領域。縦スクロールで移動" className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-zinc-100 dark:bg-zinc-950" style={{ touchAction: 'pan-y pinch-zoom', overflowAnchor: 'none', scrollbarGutter: 'stable' }}>
      <div ref={extent} className="relative w-full" style={{ overflowAnchor: 'none' }}>
        <div ref={layer} className="sticky top-0 w-full overflow-clip">
          <canvas ref={canvas} className="absolute inset-0 z-0 h-full w-full" aria-label="ライブカード" />
          <canvas ref={gpuCanvas} className="absolute inset-0 z-0 h-full w-full" aria-label="WebGLライブカード" />
          <div ref={fallback} className="absolute inset-0 z-0 isolate" />
        </div>
      </div>
      {items.map(item => <CardRoot key={item.id} item={item} register={register} />)}
    </div>
  </section>;
}
