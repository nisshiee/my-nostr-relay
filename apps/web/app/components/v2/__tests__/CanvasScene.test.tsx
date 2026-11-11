// @vitest-environment jsdom

import React, { useEffect, useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { CanvasScene } from "../CanvasScene";
import { PUSH_EFFECT_DURATION_MS } from "../pushEffect";
import { buildInitialLayout, insertCard, reflow } from "../../../lib/layoutEngine";
import type { Card } from "../../../lib/types";

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

beforeEach(() => {
  localStorage.clear();
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
  vi.useRealTimers();
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

function pointer(target: Element | Window, type: string, pointerId = 7, button = 0, isPrimary = true) {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, { pointerId, button, isPrimary });
  fireEvent(target, event);
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
  it("DOM押下はfocusと遅れたclickの間も実表示の矩形と変形を固定する", () => {
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']}); localStorage.setItem('nlc-v2-effect','domino');
    const original = {id:'a',content:<InteractiveCard />};
    const {rerender} = render(<CanvasScene items={[original]} />); flushFrame(0);
    rerender(<CanvasScene items={[{id:'new',content:<span>new</span>},original]} />); flushFrame(16); flushFrame(250);
    const node = document.querySelector<HTMLElement>('[data-scene-card="a"]')!;
    const face=node.querySelector<HTMLElement>('[data-scene-face]')!;
    const snapshot = [face.style.transform,node.dataset.sceneX,node.dataset.sceneY];
    const button = screen.getByRole('button',{name:'クリック 0'});
    pointer(button,'pointerdown'); fireEvent.focus(button); flushFrame(450);
    expect([face.style.transform,node.dataset.sceneX,node.dataset.sceneY]).toEqual(snapshot);
    pointer(window,'pointerup',99); flushFrame(600);
    expect(face.style.transform).toBe(snapshot[0]);
    pointer(window,'pointerup'); act(()=>vi.advanceTimersByTime(300)); flushFrame(800);
    expect(face.style.transform).toBe(snapshot[0]);
    fireEvent.click(button);
    expect(screen.getByRole('button',{name:'クリック 1'})).toBeDefined();
    act(()=>vi.advanceTimersByTime(0)); flushFrame(850);
    expect(node.dataset.sceneTip).toBe('0');
  });
  it("押下由来focusでは非変形座標による自動scrollを起こさない", () => {
    localStorage.setItem('nlc-v2-effect','domino');
    vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockImplementation(function(this:HTMLElement){return this.closest<HTMLElement>('[data-scene-card]')?.dataset.sceneCard==='a'?1000:120;});
    const original={id:'a',content:<InteractiveCard/>};
    const {rerender}=render(<CanvasScene items={[original]}/>);flushFrame(0);
    rerender(<CanvasScene items={[{id:'new',content:<span>new</span>},original]}/>);flushFrame(16);flushFrame(300);
    const host=screen.getByLabelText('カード領域。縦スクロールで移動');
    host.scrollTop=500;fireEvent.scroll(host);flushFrame(300);
    const button=screen.getByRole('button',{name:'クリック 0'});
    Object.defineProperty(button,'offsetTop',{configurable:true,value:100});
    pointer(button,'pointerdown');fireEvent.focus(button);flushFrame(400);
    expect(host.scrollTop).toBe(500);
    pointer(window,'pointercancel');
  });
  it.each(['cancel','blur','fallback','off','reduced','removed'])("押下固定を%sで解除し残さない", reason => {
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']}); localStorage.setItem('nlc-v2-effect','domino');
    let changed:(()=>void)|undefined;
    const media={matches:false,addEventListener(_type:string,cb:()=>void){changed=cb;},removeEventListener(){}};
    vi.stubGlobal('matchMedia',()=>media);
    const original={id:'a',content:<InteractiveCard/>};
    const {rerender,unmount}=render(<CanvasScene items={[original]}/>); flushFrame(0);
    const incoming={id:'new',content:<span>new</span>};
    rerender(<CanvasScene items={[incoming,original]}/>); flushFrame(16); flushFrame(250);
    const node=document.querySelector<HTMLElement>('[data-scene-card="a"]')!;
    const button=screen.getByRole('button',{name:'クリック 0'});
    pointer(button,'pointerdown'); fireEvent.focus(button); flushFrame(350);
    expect(Number(node.dataset.sceneTip)).toBeGreaterThan(0);
    if(reason==='cancel') pointer(window,'pointercancel');
    if(reason==='blur') fireEvent(window,new Event('blur'));
    if(reason==='fallback'){pointer(window,'pointerup');act(()=>vi.advanceTimersByTime(701));}
    if(reason==='off') fireEvent.change(screen.getByRole('combobox'),{target:{value:'off'}});
    if(reason==='reduced') act(()=>{media.matches=true;changed?.();});
    if(reason==='removed') rerender(<CanvasScene items={[incoming]}/>);
    flushFrame(500);
    if(reason==='removed') expect(document.querySelector('[data-scene-card="a"]')).toBeNull();
    else { expect(node.dataset.sceneTip).toBe('0'); expect(node.style.padding).toBe('0px'); }
    unmount(); frames.clear(); act(()=>vi.runOnlyPendingTimers()); expect(frames.size).toBe(0);
  });
  it("unmountはclick待ちtimerとpointer listenerを解除する", () => {
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']}); localStorage.setItem('nlc-v2-effect','domino');
    const schedule=vi.spyOn(globalThis,'setTimeout'), cancel=vi.spyOn(globalThis,'clearTimeout');
    const original={id:'a',content:<InteractiveCard/>};
    const {rerender,unmount}=render(<CanvasScene items={[original]}/>);flushFrame(0);
    rerender(<CanvasScene items={[{id:'new',content:<span>new</span>},original]}/>);flushFrame(16);flushFrame(250);
    pointer(screen.getByRole('button',{name:'クリック 0'}),'pointerdown');pointer(window,'pointerup');
    const index=schedule.mock.calls.findLastIndex(call=>call[1]===700);
    expect(index).toBeGreaterThanOrEqual(0);
    const timer=schedule.mock.results[index].value;
    unmount(); expect(cancel).toHaveBeenCalledWith(timer);
    schedule.mockClear();pointer(window,'pointerup');expect(schedule).not.toHaveBeenCalled();
  });
  it("native押下は未paintの計算値でなく最後に描いた内側CSS姿勢を保持する", () => {
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']}); localStorage.setItem('nlc-v2-effect','domino');
    let matrix:number[]=[];
    const draws:{id:string|null,matrix:number[],x:number,y:number,width:number,height:number,padding:string,pose:string}[]=[];
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({resetTransform:vi.fn(),clearRect:vi.fn(),setTransform:(...values:number[])=>{matrix=values;},drawElementImage:(node:Element,x:number,y:number,width:number,height:number)=>{draws.push({id:node.getAttribute('data-scene-card'),matrix:[...matrix],x,y,width,height,padding:(node as HTMLElement).style.padding,pose:node.querySelector<HTMLElement>('[data-scene-face]')!.style.transform});}} as unknown as CanvasRenderingContext2D);
    const descriptor=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,'requestPaint');
    Object.defineProperty(HTMLCanvasElement.prototype,'requestPaint',{configurable:true,value:vi.fn()});
    const contentDescriptor=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,'content');
    Object.defineProperty(HTMLCanvasElement.prototype,'content',{configurable:true,value:'drawable'});
    try {
      const original={id:'a',content:<InteractiveCard/>};
      const {rerender}=render(<CanvasScene items={[original]}/>); flushFrame(0);
      const surface=document.querySelector('canvas')!;
      fireEvent(surface,new Event('paint'));
      rerender(<CanvasScene items={[{id:'new',content:<span>new</span>},original]}/>); flushFrame(16); flushFrame(250);
      fireEvent(surface,new Event('paint'));
      const painted=draws.filter(draw=>draw.id==='a').at(-1)!;
      expect(painted.pose).toContain('perspective(');
      expect(painted.padding).toBe('66px');
      expect(painted.width).toBe(492); expect(painted.height).toBe(252);
      flushFrame(350);
      expect(document.querySelector<HTMLElement>('[data-scene-card="a"] [data-scene-face]')!.style.transform).not.toBe(painted.pose);
      const button=screen.getByRole('button',{name:'クリック 0'});
      pointer(button,'pointerdown');fireEvent.focus(button);flushFrame(450);
      fireEvent(surface,new Event('paint'));
      expect(draws.filter(draw=>draw.id==='a').at(-1)).toEqual(painted);
      pointer(window,'pointerup');fireEvent.click(button);act(()=>vi.advanceTimersByTime(0));flushFrame(500);
      fireEvent(surface,new Event('paint'));
      expect(draws.filter(draw=>draw.id==='a').at(-1)!.pose).toBe('');
      expect(draws.filter(draw=>draw.id==='a').at(-1)!.padding).toBe('0px');
      expect(draws.filter(draw=>draw.id==='a').at(-1)!.width).toBe(360);
      expect(screen.getByRole('button',{name:'クリック 1'})).toBeDefined();
    } finally {
      if(contentDescriptor)Object.defineProperty(HTMLCanvasElement.prototype,'content',contentDescriptor);
      else Reflect.deleteProperty(HTMLCanvasElement.prototype,'content');
      if(descriptor)Object.defineProperty(HTMLCanvasElement.prototype,'requestPaint',descriptor);
      else Reflect.deleteProperty(HTMLCanvasElement.prototype,'requestPaint');
    }
  });
  it("nativeドミノは内側CSSだけを遠近変形しDPRとscrollを二重適用しない", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const draw = vi.fn(), matrix = vi.fn();
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({globalAlpha:1,resetTransform:vi.fn(),clearRect:vi.fn(),setTransform:matrix,drawElementImage:draw} as unknown as CanvasRenderingContext2D);
    const original = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,'requestPaint');
    Object.defineProperty(HTMLCanvasElement.prototype,'requestPaint',{configurable:true,value(this:HTMLCanvasElement){this.dispatchEvent(new Event('paint'));}});
    const contentDescriptor=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,'content');
    Object.defineProperty(HTMLCanvasElement.prototype,'content',{configurable:true,value:'drawable'});
    try {
      const item = (id:string) => ({id,content:<span>{id}</span>});
      const {rerender} = render(<CanvasScene items={[item('a')]} />);
      flushFrame(0);
      fireEvent.change(screen.getByRole('combobox'),{target:{value:'domino'}});
      rerender(<CanvasScene items={[item('new'),item('a')]} />);
      flushFrame(16);
      const host = screen.getByLabelText('カード領域。縦スクロールで移動');
      host.scrollTop = 90; fireEvent.scroll(host);
      draw.mockClear(); matrix.mockClear(); flushFrame(250);
      expect(matrix.mock.calls.every(call=>call[0]===2 && call[1]===0 && call[2]===0 && call[3]===2 && call[4]===0 && call[5]===-180)).toBe(true);
      expect(draw.mock.calls.every(call=>call[1]!==0 || call[2]!==0)).toBe(true);
      const node = document.querySelector<HTMLElement>('[data-scene-card="new"]')!;
      const face = node.querySelector<HTMLElement>('[data-scene-face]')!;
      const nativePose = face.style.transform;
      expect(nativePose).toContain('perspective(');
      expect(node.style.transform).toBe('');
      expect(face.hasAttribute('drawable')).toBe(false);
      const nativeDraw=draw.mock.calls.findLast(call=>call[0]===node)!;
      expect(node.style.padding).toBe('66px');
      expect(node.style.boxSizing).toBe('content-box');
      expect(node.style.pointerEvents).toBe('none');
      expect(face.style.pointerEvents).toBe('auto');
      expect(nativeDraw.slice(3)).toEqual([492,252]);
      expect(nativeDraw[1]).toBeCloseTo(Number(node.dataset.sceneX)-66,2);
      expect(nativeDraw[2]).toBeCloseTo(Number(node.dataset.sceneY)-66,2);
      fireEvent.click(screen.getByRole('button',{name:'DOMに切替'})); flushFrame(250);
      expect(face.style.transform).toBe(nativePose);
      expect(node.style.transform).toBe(`translate(${nativeDraw[1]}px,${nativeDraw[2]-90}px) scale(1)`);
      fireEvent.click(screen.getByRole('button',{name:'Nativeを試す'})); flushFrame(250);
      draw.mockClear(); flushFrame(2000);
      expect(draw.mock.calls.every(call=>call[1]!==0 || call[2]!==0)).toBe(true);
      expect(face.style.transform).toBe('');
      expect(node.style.padding).toBe('0px');
      expect(screen.getByRole('status').textContent).toContain('native');
    } finally {
      if(contentDescriptor)Object.defineProperty(HTMLCanvasElement.prototype,'content',contentDescriptor);
      else Reflect.deleteProperty(HTMLCanvasElement.prototype,'content');
      if(original) Object.defineProperty(HTMLCanvasElement.prototype,'requestPaint',original);
      else Reflect.deleteProperty(HTMLCanvasElement.prototype,'requestPaint');
    }
  });
  it.each([true,false])("旧APIは保存済みまたは選択後のドミノをDOMへ切替える (保存=%s)", saved => {
    if(saved)localStorage.setItem('nlc-v2-effect','domino');
    const draw=vi.fn();
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({resetTransform:vi.fn(),clearRect:vi.fn(),setTransform:vi.fn(),drawElementImage:draw} as unknown as CanvasRenderingContext2D);
    const descriptor=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,'requestPaint');
    Object.defineProperty(HTMLCanvasElement.prototype,'requestPaint',{configurable:true,value(this:HTMLCanvasElement){this.dispatchEvent(new Event('paint'));}});
    try {
      const original={id:'a',content:<InteractiveCard/>};
      const {rerender}=render(<CanvasScene items={[original]}/>);flushFrame(0);
      if(!saved)fireEvent.change(screen.getByRole('combobox'),{target:{value:'domino'}});
      draw.mockClear();
      rerender(<CanvasScene items={[{id:'new',content:<span>new</span>},original]}/>);flushFrame(16);flushFrame(250);
      expect(document.querySelector('canvas')!.hidden).toBe(true);
      expect(draw).not.toHaveBeenCalled();
      expect(document.querySelector<HTMLElement>('[data-scene-card="a"] [data-scene-face]')!.style.transform).toContain('perspective(');
      fireEvent.click(screen.getByRole('button',{name:'クリック 0'}));
      expect(screen.getByRole('button',{name:'クリック 1'})).toBeDefined();
    } finally {
      if(descriptor)Object.defineProperty(HTMLCanvasElement.prototype,'requestPaint',descriptor);
      else Reflect.deleteProperty(HTMLCanvasElement.prototype,'requestPaint');
    }
  });
  it("keyboard focusの縦revealでは捕捉paddingを座標へ二重加算しない", () => {
    localStorage.setItem('nlc-v2-effect','domino');
    const original={id:'a',content:<InteractiveCard/>};
    const {rerender}=render(<CanvasScene items={[original]}/>); flushFrame(0);
    rerender(<CanvasScene items={[{id:'new',content:<span>new</span>},original]}/>); flushFrame(16); flushFrame(250);
    const node=document.querySelector<HTMLElement>('[data-scene-card="a"]')!;
    const face=node.querySelector<HTMLElement>('[data-scene-face]')!;
    const button=screen.getByRole('button',{name:'クリック 0'});
    const host=screen.getByLabelText('カード領域。縦スクロールで移動');
    expect(node.style.padding).toBe('66px');
    Object.defineProperties(button,{
      offsetTop:{configurable:true,value:570-Number(node.dataset.sceneY)},
      offsetHeight:{configurable:true,value:20},
      offsetParent:{configurable:true,value:face},
    });
    Object.defineProperties(face,{
      offsetTop:{configurable:true,value:66},
      offsetParent:{configurable:true,value:node},
    });
    act(()=>button.focus()); flushFrame(300);
    expect(document.activeElement).toBe(button);
    expect(host.scrollTop).toBe(0);
    expect(node.style.padding).toBe('0px');
  });

  it("捕捉paddingを配置高さに加えず内側の面だけを監視する", () => {
    localStorage.setItem('nlc-v2-effect','domino');
    const observed = new Set<Element>();
    let refresh: (() => void) | undefined;
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { refresh = callback; }
      observe(node: Element) { observed.add(node); }
      unobserve(node: Element) { observed.delete(node); }
      disconnect() {}
    });
    let height = 180;
    vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockImplementation(function(this:HTMLElement){
      if(this.hasAttribute('data-scene-face')) return height;
      if(this.hasAttribute('data-scene-card')) return height+132;
      return 20;
    });
    const original = {id:'a',content:<InteractiveCard/>};
    const {rerender} = render(<CanvasScene items={[original]}/>); flushFrame(0);
    rerender(<CanvasScene items={[{id:'new',content:<span>new</span>},original]}/>); flushFrame(16); flushFrame(250);
    const node = document.querySelector<HTMLElement>('[data-scene-card="a"]')!;
    const face = node.querySelector<HTMLElement>('[data-scene-face]')!;
    expect(observed.has(face)).toBe(true); expect(observed.has(node)).toBe(false);
    expect(node.style.padding).toBe('66px');
    const expectedY = Number(node.dataset.sceneTargetY);
    act(()=>refresh?.()); flushFrame(300);
    expect(Number(node.dataset.sceneTargetY)).toBe(expectedY);
    height=220; act(()=>refresh?.()); flushFrame(350);
    expect(Number(node.dataset.sceneTargetY)).toBe(expectedY+40);
    fireEvent.change(screen.getByRole('combobox'),{target:{value:'off'}}); flushFrame(400);
    expect(node.style.padding).toBe('0px'); expect(face.style.width).toBe('360px');
    expect(Number(node.dataset.sceneTargetY)).toBe(expectedY+40);
    expect(node.querySelector<HTMLElement>('[data-scene-footprint]')!.style.inset).toBe('0px');
  });

  it("保存済みドミノもreduced-motionでは変形せず、解除しても旧新着を再生しない", () => {
    localStorage.setItem('nlc-v2-effect','domino');
    let changed: (()=>void) | undefined;
    const media = {matches:true,addEventListener(_type:string,cb:()=>void){changed=cb;},removeEventListener(){}};
    vi.stubGlobal('matchMedia',()=>media);
    const item = (id:string) => ({id,content:<span>{id}</span>});
    const {rerender} = render(<CanvasScene items={[item('a')]} />); flushFrame(0);
    rerender(<CanvasScene items={[item('new'),item('a')]} />); flushFrame(16); flushFrame(250);
    expect([...document.querySelectorAll<HTMLElement>('[data-scene-card]')].every(node=>node.dataset.sceneTip==='0')).toBe(true);
    act(()=>{media.matches=false;changed?.();}); flushFrame(300);
    expect([...document.querySelectorAll<HTMLElement>('[data-scene-card]')].every(node=>node.dataset.sceneTip==='0')).toBe(true);
  });
  it("エフェクトを保存し、OFFでは新着の粒も傾きも表示しない", () => {
    const item = (id:string) => ({id,content:<span>{id}</span>});
    const {rerender,unmount} = render(<CanvasScene items={[item('a')]} />);
    flushFrame(0);
    fireEvent.change(screen.getByRole('combobox',{name:'新着エフェクト'}),{target:{value:'off'}});
    rerender(<CanvasScene items={[item('new'),item('a')]} />);
    flushFrame(16); flushFrame(300);
    expect(screen.getByLabelText('カード領域。縦スクロールで移動').dataset.scenePushEffect).toBe('idle');
    expect(document.querySelectorAll('svg path').length).toBe(0);
    expect([...document.querySelectorAll<HTMLElement>('[data-scene-card]')].every(node=>node.dataset.sceneTip==='0')).toBe(true);
    unmount(); render(<CanvasScene items={[item('a')]} />);
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('off');
  });
  it("ドミノはDOMカードを変形し、focusと選択切替で解除して旧効果を再開しない", () => {
    const original = {id:'a',content:<InteractiveCard />};
    const {rerender} = render(<CanvasScene items={[original]} />);
    flushFrame(0);
    fireEvent.change(screen.getByRole('combobox'),{target:{value:'domino'}});
    rerender(<CanvasScene items={[{id:'new',content:<span>new</span>},original]} />);
    flushFrame(16); flushFrame(250);
    const node = document.querySelector<HTMLElement>('[data-scene-card="a"]')!;
    expect(Number(node.dataset.sceneTip)).toBeGreaterThan(0);
    expect(node.style.transform).toContain('translate(');
    const face=node.querySelector<HTMLElement>('[data-scene-face]')!;
    expect(face.style.transform).toContain('perspective(');
    for(const decoration of node.querySelectorAll<HTMLElement>('[data-scene-shade], [data-scene-footprint]')){
      expect(decoration.style.pointerEvents).toBe('none');
      expect(decoration.getAttribute('aria-hidden')).toBe('true');
      expect(Number(decoration.style.opacity)).toBeGreaterThan(0);
    }
    expect(document.querySelectorAll('svg path').length).toBe(0);
    fireEvent.focus(screen.getByRole('textbox'));
    flushFrame(300);
    expect(node.dataset.sceneTip).toBe('0');
    expect(face.style.transform).toBe('');
    expect(node.querySelector<HTMLElement>('[data-scene-shade]')!.style.opacity).toBe('0');
    fireEvent.change(screen.getByRole('combobox'),{target:{value:'sparkle'}});
    flushFrame(350);
    expect(document.querySelectorAll('svg path').length).toBe(0);
  });

  it("実新着の因果に沿う星屑だけ短時間表示し、mode切替で再開始せず終了後frameを止める", () => {
    const item = (id:string) => ({id, content:<span>{id}</span>});
    const {rerender} = render(<CanvasScene items={[item('a'),item('b')]} />);
    flushFrame(0);
    const host = screen.getByLabelText('カード領域。縦スクロールで移動');
    expect(host.dataset.scenePushEffect).toBe('idle');
    rerender(<CanvasScene items={[item('new'),item('a'),item('b')]} />);
    flushFrame(16); flushFrame(100);
    expect(host.dataset.scenePushEffect).toBe('active');
    const svg = host.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.classList.contains('pointer-events-none')).toBe(true);
    expect(svg.querySelectorAll('path').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button',{name:'DOMに切替'}));
    flushFrame(900);
    expect(host.dataset.scenePushEffect).toBe('active');
    flushFrame(PUSH_EFFECT_DURATION_MS + 20);
    expect(host.dataset.scenePushEffect).toBe('idle');
    for(let time=PUSH_EFFECT_DURATION_MS + 36; time<4000 && frames.size; time+=16) flushFrame(time);
    expect(host.dataset.scenePushEffect).toBe('idle');
    expect(svg.querySelectorAll('path').length).toBe(0);
    expect(frames.size).toBe(0);
  });
  it("nativeでは連続線なしの星屑をカードより後にcanvasへ描き、SVGを重ねない", () => {
    const stroke = vi.fn(), fill = vi.fn(), draw = vi.fn();
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({globalAlpha:1,arc:vi.fn(),fill,lineTo:vi.fn(),closePath:vi.fn(),save:vi.fn(),restore:vi.fn(),beginPath:vi.fn(),moveTo:vi.fn(),bezierCurveTo:vi.fn(),stroke,resetTransform:vi.fn(),clearRect:vi.fn(),setTransform:vi.fn(),drawElementImage:draw} as unknown as CanvasRenderingContext2D);
    const original = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,'requestPaint');
    Object.defineProperty(HTMLCanvasElement.prototype,'requestPaint',{configurable:true,value(this:HTMLCanvasElement){this.dispatchEvent(new Event('paint'));}});
    try {
      const {rerender} = render(<CanvasScene items={[{id:'a',content:<span>a</span>}]} />);
      flushFrame(0);
      rerender(<CanvasScene items={[{id:'new',content:<span>new</span>},{id:'a',content:<span>a</span>}]} />);
      flushFrame(16); flushFrame(100);
      expect(stroke).not.toHaveBeenCalled();
      expect(fill).toHaveBeenCalled();
      expect(fill.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(draw.mock.invocationCallOrder.at(-1)!);
      expect(document.querySelectorAll('svg path').length).toBe(0);
      expect(screen.getByRole('status').textContent).toContain('native');
    } finally {
      if(original) Object.defineProperty(HTMLCanvasElement.prototype,'requestPaint',original);
      else Reflect.deleteProperty(HTMLCanvasElement.prototype,'requestPaint');
    }
  });
  it("前面のSVGはカードの上に重なるが操作を遮らず、粒数を制限する", () => {
    const original = {id:'a',content:<InteractiveCard />};
    const {rerender} = render(<CanvasScene items={[original]} />);
    flushFrame(0);
    rerender(<CanvasScene items={[{id:'new',content:<span>new</span>},original]} />);
    flushFrame(16); flushFrame(400);
    const host = screen.getByLabelText('カード領域。縦スクロールで移動');
    const svg = host.querySelector('svg')!;
    expect(svg.classList.contains('z-10')).toBe(true);
    expect(svg.classList.contains('pointer-events-none')).toBe(true);
    expect(svg.previousElementSibling?.classList.contains('isolate')).toBe(true);
    const particles = svg.querySelector('g > g:last-child')!;
    expect(particles.children.length).toBeGreaterThan(0);
    expect(particles.querySelectorAll('path').length).toBeLessThanOrEqual(480);
    expect(particles.children.length).toBeLessThanOrEqual(720);
    expect(svg.querySelectorAll('[stroke]').length).toBe(0);
    expect([...svg.querySelectorAll('path')].every(path => !path.getAttribute('d')?.includes(' C '))).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'クリック 0'}));
    expect(screen.getByRole('button',{name:'クリック 1'})).toBeDefined();
    fireEvent.change(screen.getByRole('textbox',{name:'下書き'}),{target:{value:'星の下でも入力'}});
    expect((screen.getByRole('textbox',{name:'下書き'}) as HTMLInputElement).value).toBe('星の下でも入力');
  });
  it("途中でreduced-motionへ変えると即停止し、解除しても旧効果を再生しない", () => {
    let changed: (() => void) | undefined;
    const media = {matches:false,addEventListener(_type:string,callback:()=>void){changed=callback;},removeEventListener(){}};
    vi.stubGlobal('matchMedia',()=>media);
    const {rerender} = render(<CanvasScene items={[{id:'a',content:<span>a</span>}]} />);
    flushFrame(0);
    rerender(<CanvasScene items={[{id:'new',content:<span>new</span>},{id:'a',content:<span>a</span>}]} />);
    flushFrame(16); flushFrame(100);
    const host = screen.getByLabelText('カード領域。縦スクロールで移動');
    expect(host.dataset.scenePushEffect).toBe('active');
    act(()=>{media.matches=true;changed!();}); flushFrame(116);
    expect(host.dataset.scenePushEffect).toBe('reduced');
    expect(host.querySelectorAll('svg path').length).toBe(0);
    expect(frames.size).toBe(0);
    act(()=>{media.matches=false;changed!();}); flushFrame(132);
    expect(host.dataset.scenePushEffect).toBe('idle');
    expect(frames.size).toBe(0);
  });
  it("reduced-motionでは新着の因果線を表示せず余分なframeを続けない", () => {
    vi.stubGlobal('matchMedia', () => ({matches:true,addEventListener(){},removeEventListener(){}}));
    const {rerender} = render(<CanvasScene items={[{id:'a',content:<span>a</span>}]} />);
    flushFrame(0);
    rerender(<CanvasScene items={[{id:'new',content:<span>new</span>},{id:'a',content:<span>a</span>}]} />);
    flushFrame(16);
    const host = screen.getByLabelText('カード領域。縦スクロールで移動');
    expect(host.dataset.scenePushEffect).toBe('reduced');
    expect(host.querySelectorAll('svg path').length).toBe(0);
    expect(frames.size).toBe(0);
  });

  it("新着の最初から詰めた目標へ動き、二段目の再配置をしない", () => {
    // 配置の全frame回帰では粒子描画を分離する。各エフェクトは専用回帰で検査する。
    localStorage.setItem('nlc-v2-effect', 'off');
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ x:0,y:0,top:0,left:0,right:400,bottom:600,width:400,height:600,toJSON() {} });
    const heights: Record<string, number> = { a:200, b:120, new:40 };
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function(this: HTMLElement) { return heights[this.closest<HTMLElement>('[data-scene-card]')?.dataset.sceneCard ?? ''] ?? 120; });
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
    // 配置の全frame回帰では粒子描画を分離する。各エフェクトは専用回帰で検査する。
    localStorage.setItem('nlc-v2-effect', 'off');
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
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({ globalAlpha:1, arc:vi.fn(),fill:vi.fn(), lineTo:vi.fn(), closePath:vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), bezierCurveTo: vi.fn(), stroke: vi.fn(), resetTransform: vi.fn(), clearRect: vi.fn(), setTransform: vi.fn(), drawElementImage: draw } as unknown as CanvasRenderingContext2D);
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
      globalAlpha:1, arc:vi.fn(),fill:vi.fn(), lineTo:vi.fn(), closePath:vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), bezierCurveTo: vi.fn(), stroke: vi.fn(), resetTransform: vi.fn(), clearRect: vi.fn(), setTransform: vi.fn(), drawElementImage: draw,
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
