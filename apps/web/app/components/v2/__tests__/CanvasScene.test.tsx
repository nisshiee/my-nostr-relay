// @vitest-environment jsdom

import React, { useEffect, useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { CanvasScene } from "../CanvasScene";
import { buildInitialLayout, insertCard, reflow } from "../../../lib/layoutEngine";
import type { Card } from "../../../lib/types";

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

beforeEach(() => {
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600,
    toJSON() { return {}; },
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function flushFrame(time = 0) {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(time);
  });
}

function InteractiveCard({ focus = false }: { focus?: boolean }) {
  const [text, setText] = useState("");
  const [count, setCount] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (focus) input.current?.focus(); }, [focus]);
  return <div>
    <input ref={input} aria-label="下書き" value={text} onChange={event => setText(event.target.value)} />
    <button onClick={() => setCount(value => value + 1)}>クリック {count}</button>
  </div>;
}

describe("CanvasScene DOM操作とAPI失敗時の回復", () => {
  it("新着の最初から詰めた目標へ動き、二段目の再配置をしない", () => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ x:0,y:0,top:0,left:0,right:400,bottom:600,width:400,height:600,toJSON() {} });
    const heights: Record<string, number> = { a:200, b:120, new:40 };
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function(this: HTMLElement) { return heights[this.dataset.sceneCard ?? ''] ?? 120; });
    const card = (id:string, score:number): Card => ({ type:'compose', slotId:id, pubkey:id, score, created_at:0 });
    const a = card('a',2), b = card('b',1), added = card('new',3);
    const items = (cards:Card[]) => cards.map(card => ({id:card.slotId, card, content:<span>{card.slotId}</span>}));
    const { rerender } = render(<CanvasScene items={items([a,b])} />);
    flushFrame(0);
    rerender(<CanvasScene items={items([added,a,b])} />);
    flushFrame(16);
    const node = document.querySelector<HTMLElement>('[data-scene-card="a"]')!;
    const host = screen.getByLabelText('カード領域。縦スクロールで移動');
    expect(Number(node.dataset.sceneTargetY)).toBe(68);
    expect(Number(node.dataset.sceneY)).toBeLessThan(68);
    expect(Number(node.dataset.sceneDelay)).toBeGreaterThan(0);
    for(let time=32; time<5000 && frames.size; time+=16) {
      flushFrame(time);
      expect(Number(node.dataset.sceneTargetY)).toBe(68);
    }
    expect(Number(node.dataset.sceneY)).toBeCloseTo(68,1);
    expect(Number(document.querySelector<HTMLElement>('[data-scene-card="b"]')!.dataset.sceneY)).toBeCloseTo(280,1);
    expect(frames.size).toBe(0);
    host.scrollTop=10; fireEvent.scroll(host); flushFrame(5000);
    expect(frames.size).toBe(0);
    expect(Number(node.dataset.sceneTargetY)).toBe(68);
  });

  it("実カードのscore/pubkeyをV1配置へ渡し、native/DOM往復後も重力のengine座標を保つ", () => {
    const card = (id: string, score: number, pubkey: string): Card => ({ type: 'compose', slotId: id, score, pubkey, created_at: 0 });
    const cards = [card('a', 100, 'alice'), card('b', 80, 'bob'), card('c', 60, 'alice'), card('d', 20, 'dave')];
    const items = (list: Card[]) => list.map(value => ({ id: value.slotId, card: value, content: <span>{value.slotId}</span> }));
    const { rerender } = render(<CanvasScene items={items(cards)} />);
    flushFrame(0);
    const heights = new Map(cards.map(value => [value.slotId, 120]));
    const initial = buildInitialLayout(cards, 2, heights);
    const assertGrid = (grid: typeof initial.grid) => {
      for (const [id, position] of grid) {
        const node = document.querySelector<HTMLElement>(`[data-scene-card="${id}"]`)!;
        expect(Number(node.dataset.sceneTargetX)).toBe(16 + position.col * 376);
        expect(Number(node.dataset.sceneTargetY)).toBe(16 + position.y);
      }
    };
    assertGrid(initial.grid);
    const added = card('new', 110, 'alice');
    heights.set('new', 120);
    rerender(<CanvasScene items={items([added, ...cards])} />);
    flushFrame(16);
    const inserted = insertCard(initial.grid, added, [added, ...cards], 2, heights, new Set());
    assertGrid(reflow(inserted.grid, [added, ...cards], 2, heights).grid);
    fireEvent.click(screen.getByRole('button', { name: 'DOMに切替' }));
    flushFrame(32);
    assertGrid(reflow(inserted.grid, [added, ...cards], 2, heights).grid);
  });

  it("新着で現在位置とtargetを分け、時間差を経て下へ移動し停止する", () => {
    const item = (id: string) => ({ id, content: <button>{id}</button> });
    const { rerender, unmount } = render(<CanvasScene items={[item('a'), item('b'), item('c'), item('d')]} />);
    flushFrame(0);
    const a = document.querySelector<HTMLElement>('[data-scene-card="a"]')!;
    const oldY = Number(a.dataset.sceneY);
    rerender(<CanvasScene items={[item('new'), item('a'), item('b'), item('c'), item('d')]} />);
    flushFrame(16);
    const cards = [...document.querySelectorAll<HTMLElement>('[data-scene-card]')];
    expect(cards.some(card => card.dataset.sceneY !== card.dataset.sceneTargetY)).toBe(true);
    expect(Number(a.dataset.sceneTargetY)).toBeGreaterThanOrEqual(oldY);
    for (let time = 32; time < 4000 && frames.size; time += 16) flushFrame(time);
    for (const card of cards) expect(Number(card.dataset.sceneY)).toBeCloseTo(Number(card.dataset.sceneTargetY), 1);
    expect(frames.size).toBe(0);
    unmount();
    expect(frames.size).toBe(0);
  });
  it("native描画に現在位置を渡し、縦scrollで待機timelineを再開しない", () => {
    const draw = vi.fn();
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({ resetTransform: vi.fn(), clearRect: vi.fn(), setTransform: vi.fn(), drawElementImage: draw } as unknown as CanvasRenderingContext2D);
    const original = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'requestPaint');
    Object.defineProperty(HTMLCanvasElement.prototype, 'requestPaint', { configurable:true, value(this: HTMLCanvasElement) { this.dispatchEvent(new Event('paint')); } });
    try {
      const item = (id:string) => ({ id, content:<span>{id}</span> });
      const { rerender } = render(<CanvasScene items={[item('a'),item('b'),item('c'),item('d')]} />);
      flushFrame(0);
      rerender(<CanvasScene items={[item('new'),item('a'),item('b'),item('c'),item('d')]} />);
      flushFrame(16); flushFrame(48);
      const a = document.querySelector<HTMLElement>('[data-scene-card="a"]')!;
      const before = Number(a.dataset.sceneDelay);
      const viewport = screen.getByLabelText('カード領域。縦スクロールで移動');
      viewport.scrollTop = 80; fireEvent.scroll(viewport);
      flushFrame(64);
      expect(Number(a.dataset.sceneDelay)).toBeLessThanOrEqual(before);
      const call = draw.mock.calls.filter(call => call[0] === a).at(-1)!;
      expect(call[1]).toBeCloseTo(Number(a.dataset.sceneX), 1);
      expect(call[2]).toBeCloseTo(Number(a.dataset.sceneY), 1);
    } finally {
      if (original) Object.defineProperty(HTMLCanvasElement.prototype, 'requestPaint', original);
      else Reflect.deleteProperty(HTMLCanvasElement.prototype, 'requestPaint');
    }
  });
  it("描画modeを途中で切り替えても現在座標と待機を保持する", () => {
    const item = (id:string) => ({ id, content:<span>{id}</span> });
    const { rerender } = render(<CanvasScene items={[item('a'),item('b'),item('c')]} />);
    flushFrame(0);
    rerender(<CanvasScene items={[item('new'),item('a'),item('b'),item('c')]} />);
    flushFrame(16); flushFrame(48);
    const card = document.querySelector<HTMLElement>('[data-scene-card="new"]')!;
    const y = card.dataset.sceneY;
    const target = card.dataset.sceneTargetY;
    fireEvent.click(screen.getByRole('button', { name:'DOMに切替' }));
    flushFrame(64);
    expect(card.dataset.sceneY).toBe(y);
    expect(card.dataset.sceneTargetY).toBe(target);
    flushFrame(80);
    expect(Number(card.dataset.sceneY)).toBeGreaterThanOrEqual(Number(y));
  });
  it("移動途中のfocusは実表示位置をholdし、続く新着でも入力を動かさない", () => {
    const a = { id:'a', content:<input aria-label="移動中の入力" /> };
    const { rerender } = render(<CanvasScene items={[a]} />);
    flushFrame(0);
    rerender(<CanvasScene items={[{ id:'new',content:<span>new</span> }, a]} />);
    flushFrame(16); flushFrame(100); flushFrame(164);
    const card = document.querySelector<HTMLElement>('[data-scene-card="a"]')!;
    const y = card.dataset.sceneY;
    act(() => screen.getByRole('textbox', {name:'移動中の入力'}).focus());
    flushFrame(180);
    expect(card.dataset.scenePhase).toBe('held');
    expect(card.dataset.sceneY).toBe(y);
    rerender(<CanvasScene items={[{ id:'newer',content:<span>newer</span> }, { id:'new',content:<span>new</span> }, a]} />);
    flushFrame(196); flushFrame(260);
    expect(card.dataset.sceneY).toBe(y);
  });
  it("reduced motionでは新着と押出しを即座に確定する", () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    const { rerender } = render(<CanvasScene items={[{ id:'a', content:<span>a</span> }]} />);
    flushFrame();
    rerender(<CanvasScene items={[{ id:'new', content:<span>new</span> }, { id:'a', content:<span>a</span> }]} />);
    flushFrame(16);
    for (const card of document.querySelectorAll<HTMLElement>('[data-scene-card]')) expect(card.dataset.sceneY).toBe(card.dataset.sceneTargetY);
    expect(frames.size).toBe(0);
  });

  it("固定サイズ画像のload通知で再描画frameを予約する", () => {
    render(<CanvasScene items={[{ id: "image", content: <span data-testid="loaded-image" /> }]} />);
    flushFrame();
    expect(frames.size).toBe(0);
    act(() => screen.getByTestId("loaded-image").dispatchEvent(new CustomEvent("canvas-image-ready", { bubbles: true })));
    expect(frames.size).toBe(1);
    flushFrame();
  });
  it("SSRと初回hydrationを一致させ、回復可能エラーなしでportalを操作できる", async () => {
    const element = <CanvasScene items={[{ id: "one", content: <InteractiveCard focus /> }]} />;
    const browserDocument = document;
    let html: string;
    try {
      vi.stubGlobal("document", undefined);
      html = renderToString(element);
    } finally {
      vi.stubGlobal("document", browserDocument);
    }
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const onRecoverableError = vi.fn();
    let root: Root | undefined;
    try {
      await act(async () => { root = hydrateRoot(container, element, { onRecoverableError }); });
      flushFrame();
      expect(onRecoverableError).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "下書き" }));
      fireEvent.click(screen.getByRole("button", { name: "クリック 0" }));
      expect(screen.getByRole("button", { name: "クリック 1" })).toBeDefined();
    } finally {
      act(() => root?.unmount());
      container.remove();
    }
  });

  it("アプリ倍率と横位置を固定し、native縦scrollだけを反映する", () => {
    render(<CanvasScene items={[{ id: "one", content: <InteractiveCard /> }]} />);
    flushFrame();
    const card = document.querySelector<HTMLElement>("[data-scene-card]")!;
    const host = screen.getByLabelText('カード領域。縦スクロールで移動');
    expect(screen.queryByRole('button', {name:'拡大'})).toBeNull();
    expect(screen.queryByRole('button', {name:'縮小'})).toBeNull();
    expect(host.style.touchAction).not.toBe('none');
    const wheel = new WheelEvent('wheel', {deltaX:100,deltaY:100,ctrlKey:true,bubbles:true,cancelable:true});
    host.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(card.style.transform).toBe('translate(16px,16px) scale(1)');
    host.scrollTop = 120; host.scrollLeft = 100; fireEvent.scroll(host); flushFrame(16);
    expect(host.scrollLeft).toBe(0);
    expect(card.style.transform).toBe('translate(16px,-104px) scale(1)');
    fireEvent.pointerDown(host, {button:0,clientX:200,clientY:200,pointerId:1});
    fireEvent.pointerMove(host, {clientX:500,clientY:500,pointerId:1}); flushFrame(32);
    expect(card.style.transform).toBe('translate(16px,-104px) scale(1)');
    fireEvent.click(screen.getByRole('button', {name:'先頭に戻る'})); flushFrame(48);
    expect(host.scrollTop).toBe(0);
    expect(card.style.transform).toBe('translate(16px,16px) scale(1)');
  });
  it("縦scroll位置と描画extentをmode切替後も維持する", () => {
    render(<CanvasScene items={Array.from({length:12}, (_,i) => ({id:String(i),content:<span>{i}</span>}))} />);
    flushFrame();
    const host = screen.getByLabelText('カード領域。縦スクロールで移動');
    const extent = host.firstElementChild as HTMLElement;
    expect(Number.parseFloat(extent.style.height)).toBeGreaterThan(600);
    expect((extent.firstElementChild as HTMLElement).style.height).toBe('600px');
    expect(extent.firstElementChild!.classList.contains('overflow-clip')).toBe(true);
    host.scrollTop = 150; fireEvent.scroll(host); flushFrame(16);
    const first = document.querySelector<HTMLElement>('[data-scene-card="0"]')!;
    const before = first.style.transform;
    fireEvent.click(screen.getByRole('button', {name:'DOMに切替'})); flushFrame(32);
    expect(host.scrollTop).toBe(150);
    expect(first.style.transform).toBe(before);
  });
  it("DOM fallback内の実際のボタンがReactハンドラを呼ぶ", () => {
    render(<CanvasScene items={[{ id: "one", content: <InteractiveCard /> }]} />);
    flushFrame();
    expect(screen.getByRole("status").textContent).toContain("DOM fallback");
    fireEvent.click(screen.getByRole("button", { name: "クリック 0" }));
    expect(screen.getByRole("button", { name: "クリック 1" })).toBeDefined();
  });

  it("手動切替の往復でもportalの入力ノード・入力値・選択範囲を維持する", () => {
    render(<CanvasScene items={[{ id: "one", content: <InteractiveCard /> }]} />);
    flushFrame();
    const input = screen.getByRole("textbox", { name: "下書き" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "保存する入力" } });
    act(() => input.focus());
    input.setSelectionRange(1, 4);
    fireEvent.click(screen.getByRole("button", { name: "DOMに切替" }));
    flushFrame();
    expect(screen.getByRole("textbox")).toBe(input);
    expect(input.value).toBe("保存する入力");
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 4]);
    fireEvent.click(screen.getByRole("button", { name: "Nativeを試す" }));
    flushFrame();
    expect(screen.getByRole("textbox")).toBe(input);
    expect(input.value).toBe("保存する入力");
  });

  it("後から追加したカードはfocus effectが実行される前に接続される", () => {
    const { rerender } = render(<CanvasScene items={[]} />);
    flushFrame();
    rerender(<CanvasScene items={[{ id: "draft", content: <InteractiveCard focus /> }]} />);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "下書き" }));
    flushFrame();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "下書き" }));
  });

  it("モックnative APIの描画例外でDOMへ戻し、カードを操作できる", () => {
    // APIを明示的に模倣する単体テスト。実ブラウザのnative描画検証ではない。
    const draw = vi.fn(() => { throw new Error("unsupported draw"); });
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
      resetTransform: vi.fn(), clearRect: vi.fn(), setTransform: vi.fn(), drawElementImage: draw,
    } as unknown as CanvasRenderingContext2D);
    const original = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "requestPaint");
    Object.defineProperty(HTMLCanvasElement.prototype, "requestPaint", {
      configurable: true,
      value(this: HTMLCanvasElement) { this.dispatchEvent(new Event("paint")); },
    });
    try {
      render(<CanvasScene items={[{ id: "one", content: <InteractiveCard /> }]} />);
      flushFrame();
      flushFrame();
      expect(draw).toHaveBeenCalled();
      expect(screen.getByRole("status").textContent).toContain("DOM fallback");
      expect(document.querySelector("canvas")!.hidden).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "クリック 0" }));
      expect(screen.getByRole("button", { name: "クリック 1" })).toBeDefined();
    } finally {
      if (original) Object.defineProperty(HTMLCanvasElement.prototype, "requestPaint", original);
      else Reflect.deleteProperty(HTMLCanvasElement.prototype, "requestPaint");
    }
  });
});
