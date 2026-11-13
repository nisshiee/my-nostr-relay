"use client";

import { useLayoutEffect, useCallback, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { createSceneLayout, updateSceneLayout, type Camera, type CanvasMode, type SceneBox } from "./scene";

import { createSceneMotion, retargetSceneMotion, advanceSceneMotion, sceneMotionBoxes, type SceneMotionState } from "./sceneMotion";

import type { Card } from "../../lib/types";
import { createPushPaths, createPushParticles, pushEffectOpacity, PUSH_EFFECT_DURATION_MS, type PushEffectPath, type PushEffectBox } from "./pushEffect";

import { appendRippleWaves, pruneRippleWaves, rippleForCard, RIPPLE_EFFECT_SPEED_PX_PER_MS, type RadialRipple, type RippleWave } from "./rippleEffect";
import { createDominoTransforms, DOMINO_EFFECT_DURATION_MS, type DominoTransform } from "./dominoEffect";
import { createWebGLSceneRenderer, classifyWebGLSceneError } from "./webglSceneRenderer";
import { type GeometryCanvas, type HtmlTextureGL } from "./webglGeometry";
import { useManualDOMPreference, setManualDOMPreference } from "./manualDOMPreference";
import { SceneSettingsDialog } from "./SceneSettingsDialog";
import { getEffectPreference, serverEffectPreference, subscribeEffectPreference, setEffectPreference, type SceneEffectChoice } from "./effectPreference";

export interface CanvasSceneItem { id: string; content: ReactNode; card?: Card }
interface Props { items: CanvasSceneItem[]; heldIds?: ReadonlySet<string>; className?: string; diagnosticsEnabled?: boolean; allowNative?: boolean; nativeUnavailableReason?: string; settingsContent?: ReactNode; settingsOpen?: boolean; onSettingsClose?: () => void; settingsTrigger?: RefObject<HTMLButtonElement | null> }
const EMPTY = new Set<string>();

type FallbackStage = 'none' | 'manual' | 'init' | 'render' | 'watchdog' | 'context-loss' | 'image-gate';
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
    <div data-scene-face style={{ position: 'relative', transformOrigin: '50% 100%', pointerEvents: 'auto' }}>
      {item.content}
    </div>
  </>, node);
}

export function CanvasScene({ items, heldIds = EMPTY, className, diagnosticsEnabled = false, allowNative = true, nativeUnavailableReason = '画像配信が無効のため互換表示を使用しています', settingsContent, settingsOpen: controlledSettingsOpen, onSettingsClose, settingsTrigger: externalSettingsTrigger }: Props) {
  const effectChoice = useSyncExternalStore(subscribeEffectPreference, getEffectPreference, serverEffectPreference);
  const chosenEffect = useRef(effectChoice);
  const [localSettingsOpen, setSettingsOpen] = useState(false);
  const localSettingsTrigger = useRef<HTMLButtonElement>(null);
  const settingsOpen = controlledSettingsOpen ?? localSettingsOpen;
  const settingsTrigger = externalSettingsTrigger ?? localSettingsTrigger;
  const closeSettings = useCallback(() => { setSettingsOpen(false); onSettingsClose?.(); }, [onSettingsClose]);
  const viewport = useRef<HTMLDivElement>(null);
  const gpuCanvas = useRef<GeometryCanvas>(null);
  const extent = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const fallback = useRef<HTMLDivElement>(null);
  const savedEffect = useRef({ revision: 0, startedAt: 0, active: false });
  const savedRippleWaves = useRef<readonly RippleWave[]>([]);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const savedBoxes = useRef(new Map<string, SceneBox>());
  const savedMotion = useRef<SceneMotionState | null>(null);
  const savedTargets = useRef(new Map<string, SceneBox>());
  const savedLayout = useRef(createSceneLayout());
  const runtime = useRef<{ refresh: () => void; attach: (node: HTMLDivElement) => void; reset: () => void; chooseEffect: () => void; camera: Camera } | null>(null);
  const current = useRef({ items, heldIds });
  const [status, setStatus] = useState('DOM fallback · 初期化中');
  const forcedDOM = useManualDOMPreference();
  const [domMode, setDomMode] = useState(true);
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
    const gpuSurface = gpuCanvas.current!;
    const surface = gpuSurface;
    const dom = fallback.current!;
    let gpu: ReturnType<typeof createWebGLSceneRenderer> | null = null;
    let supported: CanvasMode = 'dom';
    let fallbackStage: FallbackStage = !allowNative ? 'image-gate' : forcedDOM ? 'manual' : 'init';
    let fallbackReason = !allowNative ? 'disabled' : forcedDOM ? 'requested' : 'api-unavailable';
    if (allowNative && !forcedDOM) try {
      const gl = gpuSurface.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: true }) as HtmlTextureGL | null;
      if (gl && gpuSurface.requestPaint && 'content' in gpuSurface) { gpu = createWebGLSceneRenderer(gl, gpuSurface); supported = 'modern'; }
    } catch (error) { supported = 'dom'; fallbackReason = diagnosticsEnabled ? classifyWebGLSceneError(error) : 'unavailable'; }
    let mode: CanvasMode = !allowNative || forcedDOM ? 'dom' : supported;
    if (mode !== 'dom') { fallbackStage = 'none'; fallbackReason = 'none'; }
    let boxes = savedBoxes.current;
    let targets = savedTargets.current;
    let layout = savedLayout.current;
    let motion = savedMotion.current ?? createSceneMotion();
    let layoutDirty = true;
    let viewWidth = 1, viewHeight = 1;
    const dirtyIds = new Set(current.current.items.map(item => item.id));
    let totalUploads = 0, totalDraws = 0, textureBytes = 0;
    const effect = savedEffect.current;
    let effectPaths: readonly PushEffectPath[] = [];
    let effectViewport: PushEffectBox | undefined;
    let effectOpacity = 0;
    let effectAge = 0;
    let dominoTransforms: ReadonlyMap<string, DominoTransform> = new Map();
    let cardRipples = new Map<string, RadialRipple>();
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
    const diagnosticTags = diagnosticsEnabled ? new Set(['BUTTON', 'IMG', 'INPUT', 'TEXTAREA', 'A', 'DIV', 'SPAN', 'CANVAS', 'SVG', 'PATH']) : null;
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
        within, targetTag: target ? diagnosticTags?.has(target.tagName.toUpperCase()) ? target.tagName.toUpperCase() : 'OTHER' : 'NONE',
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
    for (const key of ['sceneLastPointerDown', 'sceneLastPointerUp', 'sceneLastPointerClick', 'scenePaintSerial', 'sceneGeometrySerial', 'sceneFallbackStage', 'sceneFallbackReason', 'sceneRenderer', 'sceneRippleCards', 'sceneRippleTargets', 'sceneRippleSources', 'sceneRippleRadius', 'sceneEffect', 'scenePushEffect', 'sceneMotion', 'sceneUploads', 'sceneDraws', 'sceneTextureBytes']) delete host.dataset[key];
    if (!diagnosticsEnabled) for (const node of nodes.current.values()) for (const key of ['sceneX', 'sceneY', 'sceneTargetX', 'sceneTargetY', 'scenePhase', 'sceneDelay', 'sceneTip']) delete node.dataset[key];
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
    // HTMLは平面textureのまま。遠近投影と陰影はWebGL側だけで処理する。
    const applyPose = (node: HTMLDivElement, box: SceneBox) => {
      const face = node.querySelector<HTMLElement>(':scope > [data-scene-face]');
      if (!face) return;
      setStyle(face, 'width', `${box.width}px`);
      setStyle(face, 'height', pressed?.id === node.dataset.sceneCard ? `${box.height}px` : '');
      setStyle(face, 'overflow', pressed?.id === node.dataset.sceneCard ? 'clip' : '');
    };
    const geometry = () => {
      if (diagnosticsEnabled) { geometrySeq = nextSerial(geometrySeq); host.dataset.sceneGeometrySerial = String(geometrySeq); }
      const order = new Map(drawOrder().map((item, index) => [item.id, index]));
      for (const [id, node] of nodes.current) {
        const box = boxes.get(id);
        if (!box) continue;
        setStyle(node, 'width', `${box.width}px`);
        // GPUのsource border boxと論理quadを一致させる。面の自然高は別途測る。
        setStyle(node, 'height', mode !== 'dom' ? `${box.height}px` : pressed?.id === id ? `${pressed.box.height}px` : '');
        setStyle(node, 'overflow', pressed?.id === id ? 'clip' : '');
        setStyle(node, 'zIndex', String(order.get(id) ?? 0));
        if (diagnosticsEnabled) {
        const card = motion.cards.get(id);
        const target = targets.get(id) ?? box;
        node.dataset.sceneX = box.x.toFixed(2); node.dataset.sceneY = box.y.toFixed(2);
        node.dataset.sceneTargetX = target.x.toFixed(2); node.dataset.sceneTargetY = target.y.toFixed(2);
        node.dataset.scenePhase = card?.phase ?? 'settled';
        node.dataset.sceneDelay = String(Math.round(card?.delayMs ?? 0));
        node.dataset.sceneTip = String(dominoTransforms.get(id)?.amount ?? 0);
        }
        const tip = dominoTransforms.get(id);
        applyPose(node, box);
        if (mode === 'dom') {
          setStyle(node, 'transform', `translate(${camera.x + box.x}px,${camera.y + box.y}px) scale(1)`);
          displayed.set(id, { box: { ...box }, transform: tip ? { ...tip } : undefined });
        }
      }
    };
    const changeMode = (next: CanvasMode, stage?: FallbackStage, reason?: string) => {
      if (stage) { fallbackStage = stage; fallbackReason = reason ?? 'unknown'; }
      if (next !== 'dom') { fallbackStage = 'none'; fallbackReason = 'none'; }
      if (diagnosticsEnabled) { host.dataset.sceneFallbackStage = fallbackStage; host.dataset.sceneFallbackReason = fallbackReason; }
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const selection = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : null;
      mode = next; displayed.clear();
      if (diagnosticsEnabled) host.dataset.sceneRenderer = next === 'dom' ? 'dom' : 'webgl';
      setDomMode(next === 'dom');
      // DOMでは追加効果を止め、nativeへ戻っても過去のbatchを再生しない。
      if (next === 'dom') {
        effect.active = false; dominoTransforms = new Map(); cardRipples = new Map(); savedRippleWaves.current = []; ripplePointer = null; effectPaths = []; effectOpacity = 0;
        clearTimeout(pressTimer); pressTimer = undefined; pressed = null;
        gpu?.dispose(); gpu = null;
      }
      gpuSurface.hidden = next === 'dom';
      dom.hidden = next !== 'dom';
      surface.removeAttribute('content');
      if (next === 'modern') surface.setAttribute('content', 'drawable');
      for (const node of nodes.current.values()) {
        setStyle(node, 'transform', '');
        if (next === 'modern') node.setAttribute('drawable', ''); else node.removeAttribute('drawable');
        (next === 'dom' ? dom : surface).appendChild(node);
      }
      setStatus(next === 'dom' ? (diagnosticsEnabled ? (forcedDOM ? 'DOM fallback · 手動' : `DOM fallback · ${fallbackStage}/${fallbackReason}`) : '通常表示（エフェクトなし）') : 'HTML-in-Canvas · 最初の描画を確認中');
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
            // GPU投影と分離した、変形前の面だけを測定・監視する。
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
        // 新着ごとに波を追加し、既に進行中の波の中心・対象・開始時刻は変更しない。
        if (effect.revision !== layout.insertion.revision) {
          effect.revision = layout.insertion.revision;
          effect.startedAt = time;
          if (mode !== 'dom' && chosenEffect.current === 'ripple' && !reducedMotion) {
            savedRippleWaves.current = appendRippleWaves(savedRippleWaves.current, layout.insertion.traces, targets, time);
          }
          effect.active = mode !== 'dom' && chosenEffect.current !== 'off' && !reducedMotion && layout.insertion.traces.some(trace => trace.edges.length > 0);
        }
        if (mode === 'dom' || reducedMotion || chosenEffect.current !== 'ripple') savedRippleWaves.current = [];
        else savedRippleWaves.current = pruneRippleWaves(savedRippleWaves.current, time);
        if (chosenEffect.current === 'ripple') effect.active = savedRippleWaves.current.length > 0;
        else if (mode === 'dom' || reducedMotion || !layout.insertion.traces.length || time - effect.startedAt >= (chosenEffect.current === 'domino' ? DOMINO_EFFECT_DURATION_MS : PUSH_EFFECT_DURATION_MS)) effect.active = false;
        effectAge = time - effect.startedAt;
        effectOpacity = effect.active && chosenEffect.current === 'sparkle' ? pushEffectOpacity(effectAge) : 0;
        dominoTransforms = effect.active && chosenEffect.current === 'domino'
          ? createDominoTransforms(layout.insertion.traces, boxes, effectAge, { heldIds: heldNow(), reducedMotion, directionBoxes: targets })
          : new Map();
        if (ripplePointer && !current.current.items.some(item => item.id === ripplePointer!.id)) ripplePointer = null;
        cardRipples = new Map();
        const rippleHeld = heldNow();
        if (effect.active && chosenEffect.current === 'ripple') for (const item of current.current.items) {
          if (rippleHeld.has(item.id) || ripplePointer?.id === item.id) continue;
          const ripple = rippleForCard(savedRippleWaves.current, item.id, time, { reducedMotion });
          if (ripple) cardRipples.set(item.id, ripple);
        }
        if (diagnosticsEnabled) {
          host.dataset.sceneRippleCards = String(cardRipples.size);
          host.dataset.sceneRippleTargets = JSON.stringify([...new Set(savedRippleWaves.current.flatMap(wave => [...wave.targets]))]);
          host.dataset.sceneRippleSources = JSON.stringify(savedRippleWaves.current.map(({ source }) => [source.x, source.y]));
          host.dataset.sceneRippleRadius = String(savedRippleWaves.current.length ? (time - savedRippleWaves.current[0].startedAt) * RIPPLE_EFFECT_SPEED_PX_PER_MS : 0);
        }
        if (pressed && !reducedMotion && chosenEffect.current === 'domino') {
          dominoTransforms = new Map(dominoTransforms).set(pressed.id, pressed.transform);
        }
        effectViewport = { x: 0, y: host.scrollTop, width: viewportWidth, height: viewportHeight };
        effectPaths = effect.active && chosenEffect.current === 'sparkle' ? createPushPaths(layout.insertion.traces, boxes, effectViewport) : [];
        if (diagnosticsEnabled) {
        host.dataset.sceneEffect = chosenEffect.current;
        host.dataset.scenePushEffect = reducedMotion ? 'reduced' : effect.active ? 'active' : 'idle';
        host.dataset.sceneMotion = reducedMotion ? 'reduced' : motion.active ? 'animating' : 'settled';
        }
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
        if (motion.active || effect.active) requestFrame();
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
        if (gpu) {
          const paintHeld = heldNow();
          const cards = drawOrder().flatMap(item => {
            const node = nodes.current.get(item.id), box = boxes.get(item.id);
            return node && box ? [{ id: item.id, node, box, tip: dominoTransforms.get(item.id), ripple: reducedMotion || chosenEffect.current !== 'ripple' || paintHeld.has(item.id) || ripplePointer?.id === item.id ? undefined : cardRipples.get(item.id) }] : [];
          });
          const stats = gpu.render({ cards, camera, viewportWidth: viewWidth, viewportHeight: viewHeight,
            changedElements: (event as Event & { changedElements?: readonly Element[] }).changedElements,
            dirtyIds, pinnedIds: heldNow(), particles: createPushParticles(effectPaths, effectAge, effectViewport), particleOpacity: effectOpacity });
          dirtyIds.clear(); if (diagnosticsEnabled) { totalDraws += stats.draws; totalUploads += stats.uploads; textureBytes = stats.textureBytes; }
          const drawn = new Set(stats.drawnIds);
          for (const card of cards) {
            if (drawn.has(card.id)) displayed.set(card.id, { box: { ...card.box }, transform: card.tip ? { ...card.tip } : undefined });
            else displayed.delete(card.id);
          }
          painted = true;
        }
        if (diagnosticsEnabled) { paintSeq = nextSerial(paintSeq); host.dataset.scenePaintSerial = String(paintSeq);
        host.dataset.sceneUploads = String(totalUploads); host.dataset.sceneDraws = String(totalDraws); host.dataset.sceneTextureBytes = String(textureBytes); }
        if (painted) { clearTimeout(watchdog.timer); setStatus('HTML-in-Canvas · native WebGL'); }
      } catch (error) { changeMode('dom', 'render', diagnosticsEnabled ? classifyWebGLSceneError(error) : 'unavailable'); refresh(); }
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
    // pointerdownで実表示を保存し、focusによる変形解除でclick対象が逃げるのを防ぐ。
    const releasePress = () => {
      clearTimeout(pressTimer); pressTimer = undefined;
      if (!pressed) return;
      pressed = null; refresh();
    };
    const press = (event: PointerEvent) => {
      if (chosenEffect.current === 'ripple' && mode !== 'dom' && !reducedMotion && !ripplePointer && event.button === 0 && event.isPrimary !== false) {
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
    runtime.current = { refresh, camera, chooseEffect: () => { releaseRipple(); releasePress(); effect.active = false; dominoTransforms = new Map(); cardRipples = new Map(); savedRippleWaves.current = []; requestFrame(); }, reset: () => { host.scrollTop = 0; requestFrame(); }, attach: node => {
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
        if (record.type === 'attributes' && (target.hasAttribute('data-scene-card') || target.hasAttribute('data-scene-face'))) continue;
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
    if (diagnosticsEnabled) {
    window.addEventListener('pointerdown', diagnosticDown, { capture: true, passive: true });
    window.addEventListener('pointerup', diagnosticUp, { capture: true, passive: true });
    window.addEventListener('click', diagnosticClick, { capture: true, passive: true });
    window.addEventListener('pointercancel', clearDiagnosticGesture, true); window.addEventListener('blur', clearDiagnosticGesture);
    }
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
  }, [forcedDOM, diagnosticsEnabled, allowNative]);

  return <section className={`flex min-h-0 flex-1 flex-col ${className ?? ''}`} aria-label="Live canvas">
    {diagnosticsEnabled && <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 bg-white px-4 py-2 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
      <span role="status" data-renderer-status={diagnosticsEnabled ? true : undefined}>{allowNative ? status : nativeUnavailableReason}</span>
      <button type="button" onClick={() => runtime.current?.reset()} className="rounded border px-2 py-1">先頭に戻る</button>
      {controlledSettingsOpen === undefined && <button ref={localSettingsTrigger} type="button" onClick={() => setSettingsOpen(true)} aria-haspopup="dialog" aria-expanded={settingsOpen} className="rounded border px-2 py-1">設定</button>}
      <span>縦スクロールで移動</span>
    </div>}
    {settingsOpen && <SceneSettingsDialog onClose={closeSettings} trigger={settingsTrigger}>
      <label className="mb-3 flex items-center justify-between gap-3">新着エフェクト
        <select aria-label="新着エフェクト" disabled={!allowNative || domMode} aria-describedby={!allowNative || domMode ? "scene-effect-unavailable" : undefined} value={effectChoice} onChange={event => setEffectPreference(event.target.value as SceneEffectChoice)} className="rounded border bg-transparent px-2 py-1">
          <option value="off">OFF</option><option value="sparkle">キラキラ</option><option value="domino">ドミノ（試作）</option><option value="ripple">波紋（試作）</option>
        </select>
      </label>
      {(!allowNative || domMode) && <p id="scene-effect-unavailable" className="mb-4 text-xs text-zinc-500">{!allowNative ? nativeUnavailableReason : 'エフェクトはHTML-in-Canvas対応表示で利用できます。選択は保存されています。'}</p>}
      <p className="mb-3 text-xs text-zinc-500">エフェクトはHTML-in-Canvas表示でのみ利用できます。</p>
      {<button type="button" onClick={() => setManualDOMPreference(!forcedDOM)} className="rounded border px-3 py-2">{forcedDOM ? 'Nativeを試す' : 'DOMに切替'}</button>}
      {settingsContent}

    </SceneSettingsDialog>}
    <div ref={viewport} tabIndex={0} aria-label="カード領域。縦スクロールで移動" className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-zinc-100 dark:bg-zinc-950" style={{ touchAction: 'pan-y pinch-zoom', overflowAnchor: 'none', scrollbarGutter: 'stable' }}>
      <div ref={extent} className="relative w-full" style={{ overflowAnchor: 'none' }}>
        <div ref={layer} className="sticky top-0 w-full overflow-clip">
          <canvas ref={gpuCanvas} className="absolute inset-0 z-0 h-full w-full" aria-label="WebGLライブカード" />
          <div ref={fallback} className="absolute inset-0 z-0 isolate" />
        </div>
      </div>
      {items.map(item => <CardRoot key={item.id} item={item} register={register} />)}
    </div>
  </section>;
}
