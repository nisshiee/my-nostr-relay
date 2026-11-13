// @vitest-environment jsdom

import React, { useEffect, useRef, useState } from "react";
import { act, cleanup, fireEvent, render as actualRender, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { CanvasScene } from "../CanvasScene";
import * as sceneModule from "../scene";
import { buildInitialLayout, insertCard, reflow } from "../../../lib/layoutEngine";
import type { Card } from "../../../lib/types";

const backendMock = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../webglSceneRenderer', async importOriginal => ({ ...await importOriginal<typeof import('../webglSceneRenderer')>(), createWebGLSceneRenderer: backendMock.create }));
// 既存描画回帰では設定を明示的に開いてQA操作を行う。modal自身の回帰はactualRenderを使う。
function renderUI(ui: React.ReactElement, options?: Parameters<typeof actualRender>[1]) {
  const result = actualRender(ui, options);
  const active = document.activeElement as HTMLElement | null;
  const trigger = screen.queryByRole('button', { name: '設定' });
  if (trigger) fireEvent.click(trigger);
  const summary = screen.queryByText('描画比較（開発用）');
  if (summary) fireEvent.click(summary);
  if (active?.isConnected && active !== document.body) act(() => active.focus());
  return result;
}
function render(ui: React.ReactElement, options?: Parameters<typeof renderUI>[1]) {
  const result = renderUI(ui, options);
  const choice = screen.queryByRole('combobox', { name: 'QA描画方式' });
  if (choice) fireEvent.change(choice, { target: { value: 'css' } });
  return result;
}

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let nativeRestores: (() => void)[];

beforeEach(() => {
  localStorage.clear();
  backendMock.create.mockReset().mockImplementation(() => { throw new Error("No GL mock"); });
  nativeRestores = [];
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
  for (const restore of nativeRestores) restore();
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

function mockModernNative() {
  const draw = vi.fn(), fill = vi.fn();
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({globalAlpha:1,arc:vi.fn(),fill,lineTo:vi.fn(),closePath:vi.fn(),save:vi.fn(),restore:vi.fn(),beginPath:vi.fn(),moveTo:vi.fn(),resetTransform:vi.fn(),clearRect:vi.fn(),setTransform:vi.fn(),drawElementImage:draw} as unknown as CanvasRenderingContext2D);
  for (const [key,value] of [['content','drawable'],['requestPaint',function(this:HTMLCanvasElement){this.dispatchEvent(new Event('paint'));}]] as const) {
    const old=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,key);
    Object.defineProperty(HTMLCanvasElement.prototype,key,{configurable:true,value});
    nativeRestores.push(()=>{if(old)Object.defineProperty(HTMLCanvasElement.prototype,key,old);else Reflect.deleteProperty(HTMLCanvasElement.prototype,key);});
  }
  return {draw,fill};
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
  it("受動診断は直近down/up/clickの実対象だけを記録する", () => {
    localStorage.setItem('nlc-v2-effect', 'off');
    render(<CanvasScene diagnosticsEnabled items={[{id:'a',content:<button aria-label="secret label">{React.createElement('img', {src:'https://example.com/secret?token=private',alt:'secret text'})}safe</button>},{id:'b',content:<span>private content</span>}]} />); flushFrame(0);
    const host = screen.getByLabelText('カード領域。縦スクロールで移動');
    const image = screen.getByAltText('secret text'); const other = screen.getByText('private content');
    const rectSpy = vi.spyOn(image, 'getBoundingClientRect'); rectSpy.mockClear();
    const down = new Event('pointerdown', {bubbles:true,cancelable:true});
    Object.assign(down,{pointerId:4,button:0,isPrimary:true,clientX:25,clientY:45});fireEvent(image,down);
    expect(down.defaultPrevented).toBe(false);
    const read = (kind:string) => JSON.parse(host.getAttribute(`data-scene-last-pointer-${kind}`)!);
    expect(read('down')).toMatchObject({seq:1,mode:'dom',paint:0,within:true,targetTag:'IMG',card:'a',button:true,buttonIndex:0,pointerId:4,x:25,y:45,pressed:null,drawn:{tip:0},pending:{tip:0}});
    pointer(other,'pointerup',4);fireEvent.click(other);
    expect(read('up')).toMatchObject({seq:2,card:'b',button:false,targetTag:'SPAN'});
    expect(read('click')).toMatchObject({seq:3,card:'b',button:false});expect(rectSpy).not.toHaveBeenCalled();
    const serialized = ['down','up','click'].map(kind=>host.getAttribute(`data-scene-last-pointer-${kind}`)).join('');
    for(const secret of ['secret','private','example.com','token','safe']) expect(serialized).not.toContain(secret);
    for(let i=0;i<100;i++) pointer(image,'pointerdown',4);
    expect(read('down').seq).toBe(103);expect(host.getAttribute('data-scene-last-pointer-down')!.length).toBeLessThan(700);
    expect([...host.attributes].filter(attr=>attr.name.startsWith('data-scene-last-pointer-'))).toHaveLength(3);
  });

  it("診断は場外gestureを収集せず終了時にlistenerを解除する", () => {
    const {unmount} = render(<CanvasScene diagnosticsEnabled items={[{id:'a',content:<button>対象</button>}]} />); flushFrame(0);
    const host=screen.getByLabelText('カード領域。縦スクロールで移動');const button=screen.getByText('対象');
    const outside=document.createElement('button');document.body.appendChild(outside);
    pointer(button,'pointerdown',7);pointer(window,'pointerup',7);pointer(outside,'click',7);
    expect(JSON.parse(host.getAttribute('data-scene-last-pointer-click')!)).toMatchObject({seq:3,within:false,card:null,button:false});
    const before=host.getAttribute('data-scene-last-pointer-click');
    pointer(button,'pointerdown',7);pointer(window,'pointerup',7);fireEvent.click(outside);
    expect(host.getAttribute('data-scene-last-pointer-click')).toBe(before);
    pointer(outside,'pointerdown',8);pointer(outside,'pointerup',8);fireEvent.click(outside);
    expect(host.getAttribute('data-scene-last-pointer-click')).toBe(before);
    unmount();pointer(button,'pointerdown',7);fireEvent.click(button);
    expect(host.getAttribute('data-scene-last-pointer-click')).toBe(before);outside.remove();
  });

  it("native押下はfocusと遅れたclickの間も実表示の矩形と変形を固定する", () => {
    mockModernNative();
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']}); localStorage.setItem('nlc-v2-effect','domino');
    const original = {id:'a',content:<InteractiveCard />};
    const {rerender} = render(<CanvasScene diagnosticsEnabled items={[original]} />); flushFrame(0);
    rerender(<CanvasScene diagnosticsEnabled items={[{id:'new',content:<span>new</span>},original]} />); flushFrame(16); flushFrame(250);
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
    mockModernNative();
    localStorage.setItem('nlc-v2-effect','domino');
    vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockImplementation(function(this:HTMLElement){return this.closest<HTMLElement>('[data-scene-card]')?.dataset.sceneCard==='a'?1000:120;});
    const original={id:'a',content:<InteractiveCard/>};
    const {rerender}=render(<CanvasScene diagnosticsEnabled items={[original]}/>);flushFrame(0);
    rerender(<CanvasScene diagnosticsEnabled items={[{id:'new',content:<span>new</span>},original]}/>);flushFrame(16);flushFrame(300);
    const host=screen.getByLabelText('カード領域。縦スクロールで移動');
    host.scrollTop=500;fireEvent.scroll(host);flushFrame(300);
    const button=screen.getByRole('button',{name:'クリック 0'});
    Object.defineProperty(button,'offsetTop',{configurable:true,value:100});
    pointer(button,'pointerdown');fireEvent.focus(button);flushFrame(400);
    expect(host.scrollTop).toBe(500);
    pointer(window,'pointercancel');
  });
  it.each(['cancel','blur','fallback','off','reduced','removed'])("押下固定を%sで解除し残さない", reason => {
    mockModernNative();
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']}); localStorage.setItem('nlc-v2-effect','domino');
    let changed:(()=>void)|undefined;
    const media={matches:false,addEventListener(_type:string,cb:()=>void){changed=cb;},removeEventListener(){}};
    vi.stubGlobal('matchMedia',()=>media);
    const original={id:'a',content:<InteractiveCard/>};
    const {rerender,unmount}=render(<CanvasScene diagnosticsEnabled items={[original]}/>); flushFrame(0);
    const incoming={id:'new',content:<span>new</span>};
    rerender(<CanvasScene diagnosticsEnabled items={[incoming,original]}/>); flushFrame(16); flushFrame(250);
    const node=document.querySelector<HTMLElement>('[data-scene-card="a"]')!;
    const button=screen.getByRole('button',{name:'クリック 0'});
    pointer(button,'pointerdown'); fireEvent.focus(button); flushFrame(350);
    expect(Number(node.dataset.sceneTip)).toBeGreaterThan(0);
    if(reason==='cancel') pointer(window,'pointercancel');
    if(reason==='blur') fireEvent(window,new Event('blur'));
    if(reason==='fallback'){pointer(window,'pointerup');act(()=>vi.advanceTimersByTime(701));}
    if(reason==='off') fireEvent.change(screen.getByRole('combobox', {name:'新着エフェクト'}),{target:{value:'off'}});
    if(reason==='reduced') act(()=>{media.matches=true;changed?.();});
    if(reason==='removed') rerender(<CanvasScene diagnosticsEnabled items={[incoming]}/>);
    flushFrame(500);
    if(reason==='removed') expect(document.querySelector('[data-scene-card="a"]')).toBeNull();
    else { expect(node.dataset.sceneTip).toBe('0'); expect(node.style.padding).toBe('0px'); }
    unmount(); frames.clear(); act(()=>vi.runOnlyPendingTimers()); expect(frames.size).toBe(0);
  });
  it("unmountはclick待ちtimerとpointer listenerを解除する", () => {
    mockModernNative();
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']}); localStorage.setItem('nlc-v2-effect','domino');
    const schedule=vi.spyOn(globalThis,'setTimeout'), cancel=vi.spyOn(globalThis,'clearTimeout');
    const original={id:'a',content:<InteractiveCard/>};
    const {rerender,unmount}=render(<CanvasScene diagnosticsEnabled items={[original]}/>);flushFrame(0);
    rerender(<CanvasScene diagnosticsEnabled items={[{id:'new',content:<span>new</span>},original]}/>);flushFrame(16);flushFrame(250);
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
      const {rerender}=render(<CanvasScene diagnosticsEnabled items={[original]}/>); flushFrame(0);
      const surface=document.querySelector('canvas')!;
      fireEvent(surface,new Event('paint'));
      rerender(<CanvasScene diagnosticsEnabled items={[{id:'new',content:<span>new</span>},original]}/>); flushFrame(16); flushFrame(250);
      fireEvent(surface,new Event('paint'));
      const painted=draws.filter(draw=>draw.id==='a').at(-1)!;
      expect(painted.pose).toContain('perspective(');
      expect(painted.padding).toBe('66px');
      expect(painted.width).toBe(492); expect(painted.height).toBe(252);
      flushFrame(450);
      expect(document.querySelector<HTMLElement>('[data-scene-card="a"] [data-scene-face]')!.style.transform).not.toBe(painted.pose);
      const button=screen.getByRole('button',{name:'クリック 0'});
      pointer(button,'pointerdown');
      const host=screen.getByLabelText('カード領域。縦スクロールで移動');
      const diagnostic=JSON.parse(host.getAttribute('data-scene-last-pointer-down')!);
      expect(diagnostic).toMatchObject({mode:'modern',paint:2,card:'a',button:true,buttonIndex:0,pressed:null});
      expect(diagnostic.geometry).toBeGreaterThan(diagnostic.paint);
      expect(diagnostic.drawn.tip).not.toBe(diagnostic.pending.tip);
      fireEvent.focus(button);flushFrame(550);
      fireEvent(surface,new Event('paint'));
      expect(draws.filter(draw=>draw.id==='a').at(-1)).toEqual(painted);
      pointer(window,'pointerup');fireEvent.click(button);act(()=>vi.advanceTimersByTime(0));flushFrame(600);
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
      const {rerender} = render(<CanvasScene diagnosticsEnabled items={[item('a')]} />);
      flushFrame(0);
      fireEvent.change(screen.getByRole('combobox', {name:'新着エフェクト'}),{target:{value:'domino'}});
      rerender(<CanvasScene diagnosticsEnabled items={[item('new'),item('a')]} />);
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
      expect(face.style.transform).toBe('');
      expect(node.style.padding).toBe('0px');
      expect(node.style.transform).toBe(`translate(${nativeDraw[1]+66}px,${nativeDraw[2]+66-90}px) scale(1)`);
      expect(host.dataset.scenePushEffect).toBe('idle');
      fireEvent.click(screen.getByRole('button',{name:'Nativeを試す'})); flushFrame(250);
      draw.mockClear(); flushFrame(2000);
      expect(draw.mock.calls.every(call=>call[1]!==0 || call[2]!==0)).toBe(true);
      expect(face.style.transform).toBe('');
      expect(node.style.padding).toBe('0px');
      expect(document.querySelector('[data-renderer-status]')!.textContent).toContain('native');
    } finally {
      if(contentDescriptor)Object.defineProperty(HTMLCanvasElement.prototype,'content',contentDescriptor);
      else Reflect.deleteProperty(HTMLCanvasElement.prototype,'content');
      if(original) Object.defineProperty(HTMLCanvasElement.prototype,'requestPaint',original);
      else Reflect.deleteProperty(HTMLCanvasElement.prototype,'requestPaint');
    }
  });
  it("描画失敗でDOMへ退避した瞬間に押下姿勢と効果を解除する", () => {
    localStorage.setItem('nlc-v2-effect','domino');
    const {draw}=mockModernNative();
    const original={id:'a',content:<InteractiveCard/>};
    const {rerender}=render(<CanvasScene diagnosticsEnabled items={[original]}/>);flushFrame(0);
    rerender(<CanvasScene diagnosticsEnabled items={[{id:'new',content:<span>new</span>},original]}/>);flushFrame(16);flushFrame(250);
    const node=document.querySelector<HTMLElement>('[data-scene-card="a"]')!;
    const face=node.querySelector<HTMLElement>('[data-scene-face]')!;
    const button=screen.getByRole('button',{name:'クリック 0'});
    pointer(button,'pointerdown');flushFrame(350);expect(node.style.padding).toBe('66px');
    draw.mockImplementationOnce(()=>{throw new Error('draw failed');});flushFrame(450);
    expect(document.querySelector('canvas')!.hidden).toBe(true);
    expect(face.style.transform).toBe('');expect(node.style.padding).toBe('0px');
    expect(node.style.height).toBe('');expect(face.style.height).toBe('');
    flushFrame(500);expect(screen.getByLabelText('カード領域。縦スクロールで移動').dataset.scenePushEffect).toBe('idle');
    pointer(window,'pointerup');fireEvent.click(button);expect(screen.getByRole('button',{name:'クリック 1'})).toBeDefined();
  });
  it.each([true,false])("旧APIは保存済みまたは選択後のドミノをDOMへ切替える (保存=%s)", saved => {
    if(saved)localStorage.setItem('nlc-v2-effect','domino');
    const draw=vi.fn();
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({resetTransform:vi.fn(),clearRect:vi.fn(),setTransform:vi.fn(),drawElementImage:draw} as unknown as CanvasRenderingContext2D);
    const descriptor=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,'requestPaint');
    Object.defineProperty(HTMLCanvasElement.prototype,'requestPaint',{configurable:true,value(this:HTMLCanvasElement){this.dispatchEvent(new Event('paint'));}});
    try {
      const original={id:'a',content:<InteractiveCard/>};
      const {rerender}=render(<CanvasScene diagnosticsEnabled items={[original]}/>);flushFrame(0);
      if(!saved)fireEvent.change(screen.getByRole('combobox', {name:'新着エフェクト'}),{target:{value:'domino'}});
      draw.mockClear();
      rerender(<CanvasScene diagnosticsEnabled items={[{id:'new',content:<span>new</span>},original]}/>);flushFrame(16);flushFrame(250);
      expect(document.querySelector('canvas')!.hidden).toBe(true);
      expect(draw).not.toHaveBeenCalled();
      expect(document.querySelector<HTMLElement>('[data-scene-card="a"] [data-scene-face]')!.style.transform).toBe('');
      fireEvent.click(screen.getByRole('button',{name:'クリック 0'}));
      expect(screen.getByRole('button',{name:'クリック 1'})).toBeDefined();
    } finally {
      if(descriptor)Object.defineProperty(HTMLCanvasElement.prototype,'requestPaint',descriptor);
      else Reflect.deleteProperty(HTMLCanvasElement.prototype,'requestPaint');
    }
  });
  it("keyboard focusの縦revealでは捕捉paddingを座標へ二重加算しない", () => {
    mockModernNative();
    localStorage.setItem('nlc-v2-effect','domino');
    const original={id:'a',content:<InteractiveCard/>};
    const {rerender}=render(<CanvasScene diagnosticsEnabled items={[original]}/>); flushFrame(0);
    rerender(<CanvasScene diagnosticsEnabled items={[{id:'new',content:<span>new</span>},original]}/>); flushFrame(16); flushFrame(250);
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
    mockModernNative();
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
    const {rerender} = render(<CanvasScene diagnosticsEnabled items={[original]}/>); flushFrame(0);
    rerender(<CanvasScene diagnosticsEnabled items={[{id:'new',content:<span>new</span>},original]}/>); flushFrame(16); flushFrame(250);
    const node = document.querySelector<HTMLElement>('[data-scene-card="a"]')!;
    const face = node.querySelector<HTMLElement>('[data-scene-face]')!;
    expect(observed.has(face)).toBe(true); expect(observed.has(node)).toBe(false);
    expect(node.style.padding).toBe('66px');
    const expectedY = Number(node.dataset.sceneTargetY);
    act(()=>refresh?.()); flushFrame(300);
    expect(Number(node.dataset.sceneTargetY)).toBe(expectedY);
    height=220; act(()=>refresh?.()); flushFrame(350);
    expect(Number(node.dataset.sceneTargetY)).toBe(expectedY+40);
    fireEvent.change(screen.getByRole('combobox', {name:'新着エフェクト'}),{target:{value:'off'}}); flushFrame(400);
    expect(node.style.padding).toBe('0px'); expect(face.style.width).toBe('360px');
    expect(Number(node.dataset.sceneTargetY)).toBe(expectedY+40);
    expect(node.querySelector<HTMLElement>('[data-scene-footprint]')!.style.inset).toBe('0px');
  });

  it("保存済みドミノもreduced-motionでは変形せず、解除しても旧新着を再生しない", () => {
    mockModernNative();
    localStorage.setItem('nlc-v2-effect','domino');
    let changed: (()=>void) | undefined;
    const media = {matches:true,addEventListener(_type:string,cb:()=>void){changed=cb;},removeEventListener(){}};
    vi.stubGlobal('matchMedia',()=>media);
    const item = (id:string) => ({id,content:<span>{id}</span>});
    const {rerender} = render(<CanvasScene diagnosticsEnabled items={[item('a')]} />); flushFrame(0);
    rerender(<CanvasScene diagnosticsEnabled items={[item('new'),item('a')]} />); flushFrame(16); flushFrame(250);
    expect([...document.querySelectorAll<HTMLElement>('[data-scene-card]')].every(node=>node.dataset.sceneTip==='0')).toBe(true);
    act(()=>{media.matches=false;changed?.();}); flushFrame(300);
    expect([...document.querySelectorAll<HTMLElement>('[data-scene-card]')].every(node=>node.dataset.sceneTip==='0')).toBe(true);
  });
  it("エフェクトを保存し、OFFでは新着の粒も傾きも表示しない", () => {
    const item = (id:string) => ({id,content:<span>{id}</span>});
    const {rerender,unmount} = render(<CanvasScene diagnosticsEnabled items={[item('a')]} />);
    flushFrame(0);
    fireEvent.change(screen.getByRole('combobox',{name:'新着エフェクト'}),{target:{value:'off'}});
    rerender(<CanvasScene diagnosticsEnabled items={[item('new'),item('a')]} />);
    flushFrame(16); flushFrame(300);
    expect(screen.getByLabelText('カード領域。縦スクロールで移動').dataset.scenePushEffect).toBe('idle');
    expect(document.querySelectorAll('svg path').length).toBe(0);
    expect([...document.querySelectorAll<HTMLElement>('[data-scene-card]')].every(node=>node.dataset.sceneTip==='0')).toBe(true);
    unmount(); render(<CanvasScene diagnosticsEnabled items={[item('a')]} />);
    expect((screen.getByRole('combobox', {name:'新着エフェクト'}) as HTMLSelectElement).value).toBe('off');
  });
  it("ドミノはnativeカードを変形し、focusと選択切替で解除して旧効果を再開しない", () => {
    mockModernNative();
    const original = {id:'a',content:<InteractiveCard />};
    const {rerender} = render(<CanvasScene diagnosticsEnabled items={[original]} />);
    flushFrame(0);
    fireEvent.change(screen.getByRole('combobox', {name:'新着エフェクト'}),{target:{value:'domino'}});
    rerender(<CanvasScene diagnosticsEnabled items={[{id:'new',content:<span>new</span>},original]} />);
    flushFrame(16); flushFrame(250);
    const node = document.querySelector<HTMLElement>('[data-scene-card="a"]')!;
    expect(Number(node.dataset.sceneTip)).toBeGreaterThan(0);
    expect(node.style.transform).toBe('');
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
    fireEvent.change(screen.getByRole('combobox', {name:'新着エフェクト'}),{target:{value:'sparkle'}});
    flushFrame(350);
    expect(document.querySelectorAll('svg path').length).toBe(0);
  });

  it("nativeの星屑はDOM切替で停止し復帰後も旧batchを再生しない", () => {
    const {fill}=mockModernNative();
    const item=(id:string)=>({id,content:<span>{id}</span>});
    const {rerender}=render(<CanvasScene diagnosticsEnabled items={[item('a'),item('b')]} />);flushFrame(0);
    const host=screen.getByLabelText('カード領域。縦スクロールで移動');
    rerender(<CanvasScene diagnosticsEnabled items={[item('new'),item('a'),item('b')]} />);flushFrame(16);flushFrame(100);
    expect(host.dataset.scenePushEffect).toBe('active');expect(fill).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'DOMに切替'}));flushFrame(150);
    expect(host.dataset.scenePushEffect).toBe('idle');expect(host.querySelector('svg')).toBeNull();
    fill.mockClear();fireEvent.click(screen.getByRole('button',{name:'Nativeを試す'}));flushFrame(200);
    expect(host.dataset.scenePushEffect).toBe('idle');expect(fill).not.toHaveBeenCalled();
    for(let time=216;time<4000&&frames.size;time+=16)flushFrame(time);
    expect(frames.size).toBe(0);
  });
  it("nativeでは連続線なしの星屑をカードより後にcanvasへ描き、SVGを重ねない", () => {
    const stroke = vi.fn(), fill = vi.fn(), draw = vi.fn();
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({globalAlpha:1,arc:vi.fn(),fill,lineTo:vi.fn(),closePath:vi.fn(),save:vi.fn(),restore:vi.fn(),beginPath:vi.fn(),moveTo:vi.fn(),bezierCurveTo:vi.fn(),stroke,resetTransform:vi.fn(),clearRect:vi.fn(),setTransform:vi.fn(),drawElementImage:draw} as unknown as CanvasRenderingContext2D);
    const original = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,'requestPaint');
    Object.defineProperty(HTMLCanvasElement.prototype,'requestPaint',{configurable:true,value(this:HTMLCanvasElement){this.dispatchEvent(new Event('paint'));}});
    try {
      const {rerender} = render(<CanvasScene diagnosticsEnabled items={[{id:'a',content:<span>a</span>}]} />);
      flushFrame(0);
      rerender(<CanvasScene diagnosticsEnabled items={[{id:'new',content:<span>new</span>},{id:'a',content:<span>a</span>}]} />);
      flushFrame(16); flushFrame(100);
      expect(stroke).not.toHaveBeenCalled();
      expect(fill).toHaveBeenCalled();
      expect(fill.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(draw.mock.invocationCallOrder.at(-1)!);
      expect(document.querySelectorAll('svg path').length).toBe(0);
      expect(document.querySelector('[data-renderer-status]')!.textContent).toContain('native');
    } finally {
      if(original) Object.defineProperty(HTMLCanvasElement.prototype,'requestPaint',original);
      else Reflect.deleteProperty(HTMLCanvasElement.prototype,'requestPaint');
    }
  });
  it.each(['sparkle','domino','ripple'])("DOMでは保存済み%sも効果なしで入力とクリックを維持する", choice => {
    localStorage.setItem('nlc-v2-effect',choice);
    const original={id:'a',content:<InteractiveCard/>};
    const {rerender}=render(<CanvasScene diagnosticsEnabled items={[original]}/>);flushFrame(0);
    rerender(<CanvasScene diagnosticsEnabled items={[{id:'new',content:<span>new</span>},original]}/>);flushFrame(16);flushFrame(400);
    const host=screen.getByLabelText('カード領域。縦スクロールで移動');
    expect(host.dataset.scenePushEffect).toBe('idle');expect(host.querySelector('svg')).toBeNull();
    for(const node of host.querySelectorAll<HTMLElement>('[data-scene-card]')) {
      expect(node.dataset.sceneTip).toBe('0');expect(node.style.padding).toBe('0px');
      expect(node.querySelector<HTMLElement>('[data-scene-face]')!.style.transform).toBe('');
    }
    expect((screen.getByRole('combobox', {name:'新着エフェクト'}) as HTMLSelectElement).value).toBe(choice);
    fireEvent.click(screen.getByRole('button',{name:'クリック 0'}));
    expect(screen.getByRole('button',{name:'クリック 1'})).toBeDefined();
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'効果なしで入力'}});
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('効果なしで入力');
  });
  it("途中でreduced-motionへ変えると即停止し、解除しても旧効果を再生しない", () => {
    mockModernNative();
    let changed: (() => void) | undefined;
    const media = {matches:false,addEventListener(_type:string,callback:()=>void){changed=callback;},removeEventListener(){}};
    vi.stubGlobal('matchMedia',()=>media);
    const {rerender} = render(<CanvasScene diagnosticsEnabled items={[{id:'a',content:<span>a</span>}]} />);
    flushFrame(0);
    rerender(<CanvasScene diagnosticsEnabled items={[{id:'new',content:<span>new</span>},{id:'a',content:<span>a</span>}]} />);
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
    const {rerender} = render(<CanvasScene diagnosticsEnabled items={[{id:'a',content:<span>a</span>}]} />);
    flushFrame(0);
    rerender(<CanvasScene diagnosticsEnabled items={[{id:'new',content:<span>new</span>},{id:'a',content:<span>a</span>}]} />);
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
    const { rerender } = render(<CanvasScene diagnosticsEnabled items={items([a,b])} />);
    flushFrame(0);
    rerender(<CanvasScene diagnosticsEnabled items={items([added,a,b])} />);
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
    const { rerender } = render(<CanvasScene diagnosticsEnabled items={items(cards)} />);
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
    rerender(<CanvasScene diagnosticsEnabled items={items([added, ...cards])} />);
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
    const { rerender, unmount } = render(<CanvasScene diagnosticsEnabled items={[item('a'), item('b'), item('c'), item('d')]} />);
    flushFrame(0);
    const a = document.querySelector<HTMLElement>('[data-scene-card="a"]')!;
    const oldY = Number(a.dataset.sceneY);
    rerender(<CanvasScene diagnosticsEnabled items={[item('new'), item('a'), item('b'), item('c'), item('d')]} />);
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
      const { rerender } = render(<CanvasScene diagnosticsEnabled items={[item('a'),item('b'),item('c'),item('d')]} />);
      flushFrame(0);
      rerender(<CanvasScene diagnosticsEnabled items={[item('new'),item('a'),item('b'),item('c'),item('d')]} />);
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
    const { rerender } = render(<CanvasScene diagnosticsEnabled items={[item('a'),item('b'),item('c')]} />);
    flushFrame(0);
    rerender(<CanvasScene diagnosticsEnabled items={[item('new'),item('a'),item('b'),item('c')]} />);
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
    const { rerender } = render(<CanvasScene diagnosticsEnabled items={[a]} />);
    flushFrame(0);
    rerender(<CanvasScene diagnosticsEnabled items={[{ id:'new',content:<span>new</span> }, a]} />);
    flushFrame(16); flushFrame(100); flushFrame(164);
    const card = document.querySelector<HTMLElement>('[data-scene-card="a"]')!;
    const y = card.dataset.sceneY;
    act(() => screen.getByRole('textbox', {name:'移動中の入力'}).focus());
    flushFrame(180);
    expect(card.dataset.scenePhase).toBe('held');
    expect(card.dataset.sceneY).toBe(y);
    rerender(<CanvasScene diagnosticsEnabled items={[{ id:'newer',content:<span>newer</span> }, { id:'new',content:<span>new</span> }, a]} />);
    flushFrame(196); flushFrame(260);
    expect(card.dataset.sceneY).toBe(y);
  });
  it("reduced motionでは新着と押出しを即座に確定する", () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    const { rerender } = render(<CanvasScene diagnosticsEnabled items={[{ id:'a', content:<span>a</span> }]} />);
    flushFrame();
    rerender(<CanvasScene diagnosticsEnabled items={[{ id:'new', content:<span>new</span> }, { id:'a', content:<span>a</span> }]} />);
    flushFrame(16);
    for (const card of document.querySelectorAll<HTMLElement>('[data-scene-card]')) expect(card.dataset.sceneY).toBe(card.dataset.sceneTargetY);
    expect(frames.size).toBe(0);
  });

  it("固定サイズ画像のload通知で再描画frameを予約する", () => {
    render(<CanvasScene diagnosticsEnabled items={[{ id: "image", content: <span data-testid="loaded-image" /> }]} />);
    flushFrame();
    expect(frames.size).toBe(0);
    act(() => screen.getByTestId("loaded-image").dispatchEvent(new CustomEvent("canvas-image-ready", { bubbles: true })));
    expect(frames.size).toBe(1);
    flushFrame();
  });
  it("SSRと初回hydrationを一致させ、回復可能エラーなしでportalを操作できる", async () => {
    const element = <CanvasScene diagnosticsEnabled items={[{ id: "one", content: <InteractiveCard focus /> }]} />;
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
    render(<CanvasScene diagnosticsEnabled items={[{ id: "one", content: <InteractiveCard /> }]} />);
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
    render(<CanvasScene diagnosticsEnabled items={Array.from({length:12}, (_,i) => ({id:String(i),content:<span>{i}</span>}))} />);
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
    render(<CanvasScene diagnosticsEnabled items={[{ id: "one", content: <InteractiveCard /> }]} />);
    flushFrame();
    expect(document.querySelector("[data-renderer-status]")!.textContent).toContain("DOM fallback");
    fireEvent.click(screen.getByRole("button", { name: "クリック 0" }));
    expect(screen.getByRole("button", { name: "クリック 1" })).toBeDefined();
  });

  it("手動切替の往復でもportalの入力ノード・入力値・選択範囲を維持する", () => {
    render(<CanvasScene diagnosticsEnabled items={[{ id: "one", content: <InteractiveCard /> }]} />);
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
    const { rerender } = render(<CanvasScene diagnosticsEnabled items={[]} />);
    flushFrame();
    rerender(<CanvasScene diagnosticsEnabled items={[{ id: "draft", content: <InteractiveCard focus /> }]} />);
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
      render(<CanvasScene diagnosticsEnabled items={[{ id: "one", content: <InteractiveCard /> }]} />);
      flushFrame();
      flushFrame();
      expect(draw).toHaveBeenCalled();
      expect(document.querySelector("[data-renderer-status]")!.textContent).toContain("DOM fallback");
      expect(document.querySelector("canvas")!.hidden).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "クリック 0" }));
      expect(screen.getByRole("button", { name: "クリック 1" })).toBeDefined();
    } finally {
      if (original) Object.defineProperty(HTMLCanvasElement.prototype, "requestPaint", original);
      else Reflect.deleteProperty(HTMLCanvasElement.prototype, "requestPaint");
    }
  });
});

// GPU本体は別の回帰で検証し、ここではfeedとrendererの契約を検証する。
describe('CanvasScene WebGL feed接続', () => {
  function gpuBackend() {
    mockModernNative();
    const seen: import('../webglSceneRenderer').WebGLSceneFrame[] = [];
    const dispose = vi.fn();
    const draw = vi.fn((value: import('../webglSceneRenderer').WebGLSceneFrame) => {
      seen.push({...value, cards:value.cards.map(card=>({...card,box:{...card.box}})), dirtyIds:new Set(value.dirtyIds), pinnedIds:new Set(value.pinnedIds)});
      return {draws:value.cards.length, uploads:value.dirtyIds?.size??0, textureBytes:4096, textureCount:value.cards.length, geometryUpdates:value.cards.length, drawnIds:value.cards.map(card=>card.id)};
    });
    backendMock.create.mockReturnValue({render:draw,dispose});
    return {seen,draw,dispose};
  }
  const host = () => screen.getByLabelText('カード領域。縦スクロールで移動');
  const card = (id:string) => document.querySelector<HTMLElement>(`[data-scene-card="${id}"]`)!;
  const original = {id:'a',content:<InteractiveCard/>};
  const incoming = {id:'new',content:<span>new</span>};

  it('設定modalはbody portalに開きEscape・背景・閉じるでtriggerへfocusを戻す', () => {
    gpuBackend();actualRender(<CanvasScene items={[original]}/>);flushFrame(0);
    expect(screen.queryByRole('dialog')).toBeNull();expect(screen.queryByRole('combobox',{name:'新着エフェクト'})).toBeNull();
    const trigger=screen.getByRole('button',{name:'設定'});act(()=>trigger.focus());fireEvent.click(trigger);
    let dialog=screen.getByRole('dialog',{name:'表示設定'});expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.closest('section[aria-label="V2 canvas"]')).toBeNull();expect(document.activeElement).toBe(screen.getByRole('button',{name:'設定を閉じる'}));
    fireEvent.keyDown(document,{key:'Escape'});expect(screen.queryByRole('dialog')).toBeNull();expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);dialog=screen.getByRole('dialog',{name:'表示設定'});fireEvent.click(dialog.parentElement!);
    expect(screen.queryByRole('dialog')).toBeNull();expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);fireEvent.click(screen.getByRole('button',{name:'設定を閉じる'}));
    expect(screen.queryByRole('dialog')).toBeNull();expect(document.activeElement).toBe(trigger);
  });
  it('設定modalのTabは端で循環し閉じるまでカード入力をremountしない', () => {
    gpuBackend();actualRender(<CanvasScene items={[original]}/>);flushFrame(0);
    const input=screen.getByLabelText('下書き');fireEvent.change(input,{target:{value:'keep settings draft'}});
    fireEvent.click(screen.getByRole('button',{name:'クリック 0'}));
    fireEvent.click(screen.getByRole('button',{name:'設定'}));
    const close=screen.getByRole('button',{name:'設定を閉じる'}),last=screen.getByRole('button',{name:'DOMに切替'});
    fireEvent.keyDown(close,{key:'Tab',shiftKey:true});expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last,{key:'Tab'});expect(document.activeElement).toBe(close);
    fireEvent.change(screen.getByRole('combobox',{name:'新着エフェクト'}),{target:{value:'off'}});flushFrame(100);
    expect(localStorage.getItem('nlc-v2-effect')).toBe('off');
    fireEvent.click(close);expect(screen.getByLabelText('下書き')).toBe(input);expect((input as HTMLInputElement).value).toBe('keep settings draft');
    expect(screen.getByRole('button',{name:'クリック 1'})).toBeDefined();
  });
  it('設定modalはDOMで保存選択と認証理由を表示し閉じるだけでもTab循環する', () => {
    localStorage.setItem('nlc-v2-effect','ripple');
    actualRender(<CanvasScene allowNative={false} nativeUnavailableReason="画像表示にはログインが必要です" items={[original]}/>);flushFrame(0);
    fireEvent.click(screen.getByRole('button',{name:'設定'}));
    const dialog=screen.getByRole('dialog',{name:'表示設定'}),select=screen.getByRole('combobox',{name:'新着エフェクト'}) as HTMLSelectElement;
    expect(select.disabled).toBe(true);expect(select.value).toBe('ripple');expect(dialog.textContent).toContain('画像表示にはログインが必要です');
    expect(screen.queryByRole('button',{name:'Nativeを試す'})).toBeNull();expect(screen.queryByRole('combobox',{name:'QA描画方式'})).toBeNull();
    const close=screen.getByRole('button',{name:'設定を閉じる'});fireEvent.keyDown(close,{key:'Tab'});expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close,{key:'Tab',shiftKey:true});expect(document.activeElement).toBe(close);
    fireEvent.click(close);expect(localStorage.getItem('nlc-v2-effect')).toBe('ripple');
  });

  it('allowNative=falseはAPI対応環境でもcontext取得とnative再試行を禁止する', () => {
    gpuBackend();vi.mocked(HTMLCanvasElement.prototype.getContext).mockClear();
    renderUI(<CanvasScene diagnosticsEnabled allowNative={false} items={[original]} qaMeasurementToken={1}/>);flushFrame(0);
    expect(HTMLCanvasElement.prototype.getContext).not.toHaveBeenCalled();expect(backendMock.create).not.toHaveBeenCalled();
    expect(host().dataset.sceneRenderer).toBe('dom');expect(host().dataset.sceneFallbackStage).toBe('image-gate');
    expect(screen.getAllByText('画像配信が無効のため互換表示を使用しています').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button',{name:'Nativeを試す'})).toBeNull();expect(screen.queryByRole('button',{name:'DOMに切替'})).toBeNull();
    expect((screen.getByRole('combobox',{name:'新着エフェクト'}) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole('combobox',{name:'QA描画方式'}) as HTMLSelectElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('combobox',{name:'QA描画方式'}),{target:{value:'css'}});flushFrame(20);
    expect(HTMLCanvasElement.prototype.getContext).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'クリック 0'}));expect(screen.getByRole('button',{name:'クリック 1'})).toBeDefined();
  });
  it('allowNative切替は入力を保ち復帰で過去batchを再生しない', () => {
    const {seen}=gpuBackend();localStorage.setItem('nlc-v2-effect','ripple');
    const {rerender}=renderUI(<CanvasScene diagnosticsEnabled items={[original]}/>);flushFrame(0);
    fireEvent.change(screen.getByLabelText('下書き'),{target:{value:'keep'}});
    rerender(<CanvasScene diagnosticsEnabled allowNative={false} items={[incoming,original]}/>);flushFrame(100);flushFrame(350);
    expect(host().dataset.sceneRenderer).toBe('dom');expect((screen.getByLabelText('下書き') as HTMLInputElement).value).toBe('keep');
    rerender(<CanvasScene diagnosticsEnabled allowNative items={[incoming,original]}/>);flushFrame(400);
    expect(host().dataset.sceneRenderer).toBe('webgl');expect((screen.getByLabelText('下書き') as HTMLInputElement).value).toBe('keep');
    expect(seen.at(-1)!.cards.every(c=>!c.ripple)).toBe(true);expect(host().dataset.scenePushEffect).toBe('idle');
  });
  it('allowNative=falseのSSRも互換表示を説明しnative再試行を出さない', () => {
    const html=renderToString(<CanvasScene allowNative={false} items={[original]}/>);
    expect(html).toContain('画像配信が無効のため互換表示を使用しています');
    expect(html).not.toContain('Nativeを試す');expect(html).not.toContain('DOMに切替');
  });

  it('既定ではQA・受動診断・frame計測を行わず機能用属性と操作は維持する', () => {
    const {seen}=gpuBackend();const listen=vi.spyOn(window,'addEventListener');
    const {rerender}=renderUI(<CanvasScene items={[original]} qaMeasurementToken={1}/>);flushFrame(0);
    expect(frames.size).toBe(0);
    expect(screen.queryByRole('combobox',{name:'QA描画方式'})).toBeNull();
    expect(screen.queryByRole('button',{name:'5秒frame比較'})).toBeNull();
    expect(screen.queryByLabelText('実フィードframe比較結果')).toBeNull();
    expect(screen.getByText('表示設定')).toBeDefined();
    expect(screen.getByRole('button',{name:'DOMに切替'}).closest('[role=dialog]')).not.toBeNull();
    expect(listen.mock.calls.some(([type,,options])=>['pointerdown','pointerup','click'].includes(type) && typeof options==='object' && options?.passive)).toBe(false);
    rerender(<CanvasScene items={[incoming,original]} qaMeasurementToken={2}/>);flushFrame(100);flushFrame(350);
    expect(seen.at(-1)!.cards.length).toBe(2);
    const node=card('a');expect(node.dataset.sceneCard).toBe('a');expect(node.dataset.sceneCapturePadding).toBe('0');
    expect(node.querySelector('[data-scene-face]')).not.toBeNull();
    expect(Object.keys(host().dataset)).toEqual([]);
    expect(Object.keys(node.dataset).sort()).toEqual(['sceneCapturePadding','sceneCard']);
    const button=screen.getByRole('button',{name:'クリック 0'});pointer(button,'pointerdown');pointer(window,'pointerup');fireEvent.click(button);flushFrame(400);
    expect(screen.getByRole('button',{name:'クリック 1'})).toBeDefined();expect(host().dataset.sceneLastPointerDown).toBeUndefined();
    for(let t=500;t<=10000;t+=100) flushFrame(t);expect(frames.size).toBe(0);
  });
  it('診断を無効へ戻すと既存attrsを消しrendererはWebGLへ戻す', () => {
    gpuBackend();const {rerender}=renderUI(<CanvasScene diagnosticsEnabled items={[original]}/>);flushFrame(0);
    expect(host().dataset.sceneRenderer).toBe('webgl');expect(card('a').dataset.sceneX).toBeDefined();
    fireEvent.change(screen.getByRole('combobox',{name:'QA描画方式'}),{target:{value:'css'}});flushFrame(50);
    rerender(<CanvasScene items={[original]}/>);flushFrame(100);
    expect(Object.keys(host().dataset)).toEqual([]);expect(card('a').dataset.sceneX).toBeUndefined();
    expect((screen.getByLabelText('WebGLライブカード') as HTMLCanvasElement).hidden).toBe(false);
  });
  it('通常DOMではエフェクト選択を無効化して保存済み選択とカード操作を保つ', () => {
    localStorage.setItem('nlc-v2-effect','ripple');renderUI(<CanvasScene items={[original]}/>);flushFrame(0);
    const select=screen.getByRole('combobox',{name:'新着エフェクト'}) as HTMLSelectElement;
    expect(select.disabled).toBe(true);expect(select.value).toBe('ripple');
    expect(screen.getByText('エフェクトはHTML-in-Canvas対応表示で利用できます。選択は保存されています。')).toBeDefined();
    expect(localStorage.getItem('nlc-v2-effect')).toBe('ripple');
    fireEvent.click(screen.getByRole('button',{name:'クリック 0'}));expect(screen.getByRole('button',{name:'クリック 1'})).toBeDefined();
  });

  it('波紋の適用先は実edgeだけで固定し通常reflow移動・無関係・単独rootを除外する', () => {
    const {seen}=gpuBackend();localStorage.setItem('nlc-v2-effect','ripple');
    const update=sceneModule.updateSceneLayout;let clearTraces=false;
    // 配置は実engine、因果traceだけ固定fixtureとして渡しUIへの適用契約を検査する。
    vi.spyOn(sceneModule,'updateSceneLayout').mockImplementation((...args)=>{
      const result=update(...args);
      if(args[1].some(item=>item.id==='new')) return {...result,insertion:{revision:1,traces:clearTraces?[]:[
        {sourceId:'new',edges:[{fromId:'new',toId:'a'},{fromId:'a',toId:'second'}]},
        {sourceId:'second',edges:[]},
      ]}};
      return result;
    });
    const unrelated={id:'unrelated',content:<span>unrelated</span>},second={id:'second',content:<span>second</span>};
    const {rerender}=renderUI(<CanvasScene diagnosticsEnabled items={[original,unrelated]}/>);flushFrame(0);
    rerender(<CanvasScene diagnosticsEnabled items={[incoming,second,original,unrelated]}/>);flushFrame(100);flushFrame(350);
    const applied=()=>seen.at(-1)!.cards.filter(c=>c.ripple).map(c=>c.id).sort();
    expect(applied()).toEqual(['a','second']);
    expect(host().dataset.sceneRippleCards).toBe('2');
    expect(JSON.parse(host().dataset.sceneRippleTargets!).sort()).toEqual(['a','second']);
    // 別traceのrootでも実際に押されたtargetなら対象。単独rootや再配置だけのカードは対象外。
    clearTraces=true;
    const positions=seen.at(-1)!.cards.map(c=>({...c.box}));
    fireEvent(window,new Event('resize'));flushFrame(500);
    expect(applied()).toEqual(['a','second']);expect(seen.at(-1)!.cards.map(c=>({...c.box}))).not.toEqual(positions);
    rerender(<CanvasScene diagnosticsEnabled items={[incoming,second,original,unrelated]} heldIds={new Set(['a'])}/>);flushFrame(550);
    expect(applied()).toEqual(['second']);expect(host().dataset.sceneRippleCards).toBe('1');
  });

  it('円形波紋の中心は新着目標で固定され移動・高さreflow・scrollに追従しない', async () => {
    const {seen}=gpuBackend();localStorage.setItem('nlc-v2-effect','ripple');
    let refresh:(()=>void)|undefined;
    vi.stubGlobal('ResizeObserver',class{constructor(fn:()=>void){refresh=fn;}observe(){}unobserve(){}disconnect(){}});
    let height=120;vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockImplementation(function(this:HTMLElement){return this.hasAttribute('data-scene-face')?height:0;});
    const {rerender}=renderUI(<CanvasScene diagnosticsEnabled items={[original]}/>);flushFrame(0);
    rerender(<CanvasScene diagnosticsEnabled items={[incoming,original]}/>);flushFrame(100);flushFrame(300);
    const ripple=()=>seen.at(-1)!.cards.find(c=>c.id==='a')!.ripple!;
    const sources=ripple().sources;
    expect(sources).toHaveLength(1);expect(sources[0]).toMatchObject({id:'new',x:Number(card('new').dataset.sceneTargetX)+180,y:Number(card('new').dataset.sceneTargetY)+60});
    expect(seen.at(-1)!.cards.find(c=>c.id==='new')!.ripple).toBeUndefined();
    expect(host().dataset.sceneRippleCards).toBe('1');
    expect(JSON.parse(host().dataset.sceneRippleSources!)).toEqual(sources.map(({x,y})=>[x,y]));
    expect(Number(host().dataset.sceneRippleRadius)).toBe(200);
    await act(async()=>{await Promise.resolve();});flushFrame(350);expect(seen.at(-1)!.dirtyIds!.size).toBe(0);
    height=240;act(()=>refresh?.());flushFrame(400);expect(ripple().sources).toEqual(sources);expect(ripple().ageMs).toBe(300);
    host().scrollTop=90;fireEvent.scroll(host());flushFrame(450);expect(ripple().sources).toEqual(sources);expect(seen.at(-1)!.camera.y).toBe(-90);
    rerender(<CanvasScene diagnosticsEnabled items={[original]}/>);flushFrame(500);expect(ripple().sources).toEqual(sources);
    const next={id:'second',content:<span>second</span>};rerender(<CanvasScene diagnosticsEnabled items={[next,original]}/>);flushFrame(600);flushFrame(700);
    expect(ripple().sources.map(s=>s.id)).toEqual(['second']);expect(ripple().ageMs).toBe(100);
  });

  it('波紋はGLでだけ屈折しhold・focus・非focus押下を抑制する', () => {
    const {seen}=gpuBackend();localStorage.setItem('nlc-v2-effect','ripple');
    const {rerender}=renderUI(<CanvasScene diagnosticsEnabled items={[original]}/>);flushFrame(0);
    rerender(<CanvasScene diagnosticsEnabled items={[incoming,original]}/>);flushFrame(100);flushFrame(350);
    const latest=()=>seen.at(-1)!.cards.find(c=>c.id==='a')!;
    expect(latest().ripple!.amount).toBeGreaterThan(0);expect(latest().tip).toBeUndefined();
    expect(card('a').querySelector<HTMLElement>('[data-scene-face]')!.style.transform).toBe('');
    expect(card('a').style.padding).toBe('0px');
    pointer(card('a'),'pointerdown');flushFrame(370);expect(latest().ripple).toBeUndefined();
    pointer(window,'pointerup');flushFrame(380);expect(latest().ripple).toBeDefined();
    pointer(card('a'),'pointerdown');flushFrame(385);expect(latest().ripple).toBeUndefined();
    fireEvent(window,new Event('blur'));flushFrame(390);expect(latest().ripple).toBeDefined();
    const input=screen.getByLabelText('下書き');fireEvent.focus(input);flushFrame(410);expect(latest().ripple).toBeUndefined();
    fireEvent.blur(input);flushFrame(430);expect(latest().ripple).toBeDefined();
    rerender(<CanvasScene diagnosticsEnabled items={[incoming,original]} heldIds={new Set(['a'])}/>);flushFrame(450);expect(latest().ripple).toBeUndefined();
    rerender(<CanvasScene diagnosticsEnabled items={[incoming,original]}/>);flushFrame(470);expect(latest().ripple).toBeDefined();
    fireEvent.change(screen.getByRole('combobox',{name:'新着エフェクト'}),{target:{value:'off'}});flushFrame(490);
    expect(seen.at(-1)!.cards.every(c=>!c.ripple)).toBe(true);
  });
  it('波紋はCSS比較とDOMで停止しGL復帰で旧batchを再生しない', () => {
    const {seen}=gpuBackend();localStorage.setItem('nlc-v2-effect','ripple');
    const {rerender}=renderUI(<CanvasScene diagnosticsEnabled items={[original]}/>);flushFrame(0);
    fireEvent.change(screen.getByRole('combobox',{name:'QA描画方式'}),{target:{value:'css'}});flushFrame(30);
    rerender(<CanvasScene diagnosticsEnabled items={[incoming,original]}/>);flushFrame(100);flushFrame(350);
    expect(host().dataset.scenePushEffect).toBe('idle');expect(host().dataset.sceneRippleCards).toBe('0');
    fireEvent.change(screen.getByRole('combobox',{name:'QA描画方式'}),{target:{value:'webgl'}});flushFrame(400);
    expect(seen.at(-1)!.cards.every(c=>!c.ripple)).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'DOMに切替'}));flushFrame(450);
    expect(host().dataset.scenePushEffect).toBe('idle');
  });
  it('波紋reduced-motionは即停止し解除後も旧batchを再生しない', () => {
    const {seen}=gpuBackend();localStorage.setItem('nlc-v2-effect','ripple');
    let changed:(()=>void)|undefined;const media={matches:false,addEventListener(_t:string,fn:()=>void){changed=fn;},removeEventListener(){}};
    vi.stubGlobal('matchMedia',()=>media);
    const {rerender}=renderUI(<CanvasScene diagnosticsEnabled items={[original]}/>);flushFrame(0);
    rerender(<CanvasScene diagnosticsEnabled items={[incoming,original]}/>);flushFrame(100);flushFrame(350);
    expect(seen.at(-1)!.cards.some(c=>c.ripple)).toBe(true);
    act(()=>{media.matches=true;changed!();});flushFrame(400);expect(seen.at(-1)!.cards.every(c=>!c.ripple)).toBe(true);
    act(()=>{media.matches=false;changed!();});flushFrame(450);expect(seen.at(-1)!.cards.every(c=>!c.ripple)).toBe(true);
  });

  it('default GLはCSSを平面に保ちtipとDPR/scrollをbackendへ渡す', () => {
    const {seen}=gpuBackend(); vi.stubGlobal('devicePixelRatio',2);
    localStorage.setItem('nlc-v2-effect','domino');
    const {rerender}=renderUI(<CanvasScene diagnosticsEnabled items={[original]}/>); flushFrame(0);
    fireEvent.change(screen.getByRole('combobox',{name:'新着エフェクト'}),{target:{value:'domino'}});
    rerender(<CanvasScene diagnosticsEnabled items={[incoming,original]}/>);flushFrame(100);flushFrame(250);
    expect(host().dataset.sceneRenderer).toBe('webgl');
    expect(seen.at(-1)!.cards.some(c=>(c.tip?.amount??0)>0)).toBe(true);
    expect(card('a').querySelector<HTMLElement>('[data-scene-face]')!.style.transform).toBe('');
    expect(card('a').style.padding).toBe('0px');
    const canvas=screen.getByLabelText('WebGLライブカード') as HTMLCanvasElement;
    expect(canvas.width).toBe(1600);expect(canvas.height).toBe(1200);
    host().scrollTop=90;fireEvent.scroll(host());flushFrame(300);
    expect(seen.at(-1)!.camera).toEqual({x:0,y:-90,zoom:1});
  });

  it('self診断attrsでDOM idleのrAFを再起動しない', async () => {
    renderUI(<CanvasScene diagnosticsEnabled items={[original]}/>);flushFrame(0);
    await act(async()=>{await Promise.resolve();});
    for(let n=0;n<4;n++){flushFrame(16*(n+1));await act(async()=>{await Promise.resolve();});}
    expect(frames.size).toBe(0);
  });

  it('位置だけのframeはdirtyなし、入力とpaint.changedElementsは伝播する', async () => {
    const {seen}=gpuBackend();
    const {rerender}=renderUI(<CanvasScene diagnosticsEnabled items={[original]}/>);flushFrame(0);
    rerender(<CanvasScene diagnosticsEnabled items={[incoming,original]}/>);flushFrame(100);
    await act(async()=>{await Promise.resolve();});flushFrame(200);
    await act(async()=>{await Promise.resolve();});flushFrame(250);
    expect(seen.at(-1)!.dirtyIds!.size).toBe(0);
    fireEvent.change(screen.getByLabelText('下書き'),{target:{value:'edit'}});flushFrame(300);
    expect(seen.at(-1)!.dirtyIds!.has('a')).toBe(true);
    const changed=[card('a')];const event=new Event('paint');Object.assign(event,{changedElements:changed});
    fireEvent(screen.getByLabelText('WebGLライブカード'),event);
    expect(seen.at(-1)!.changedElements).toEqual(changed);
  });

  it('context lossは平面DOMへ退避し入力とクリックを保つ', () => {
    const {dispose}=gpuBackend();renderUI(<CanvasScene diagnosticsEnabled items={[original]}/>);flushFrame(0);
    fireEvent.change(screen.getByLabelText('下書き'),{target:{value:'keep'}});
    const event=new Event('webglcontextlost',{cancelable:true});fireEvent(screen.getByLabelText('WebGLライブカード'),event);flushFrame(50);
    expect(event.defaultPrevented).toBe(true);expect(dispose).toHaveBeenCalled();
    expect(host().dataset.sceneFallbackStage).toBe('context-loss');expect(host().dataset.sceneFallbackReason).toBe('context-lost');
    expect(host().dataset.sceneRenderer).toBe('dom');expect(card('a').dataset.sceneTip).toBe('0');
    expect((screen.getByLabelText('下書き') as HTMLInputElement).value).toBe('keep');
    fireEvent.click(screen.getByRole('button',{name:'クリック 0'}));expect(screen.getByRole('button',{name:'クリック 1'})).toBeDefined();
  });

  it('resource failureは欠落カードを残さずDOMへ退避する', () => {
    const {draw,dispose}=gpuBackend();draw.mockImplementation(()=>{throw new Error('budget');});
    renderUI(<CanvasScene diagnosticsEnabled items={[original]}/>);flushFrame(0);
    expect(host().dataset.sceneRenderer).toBe('dom');expect(dispose).toHaveBeenCalled();
    expect(card('a').parentElement!.tagName).toBe('DIV');
  });

  it('sparkleは同じGPUへ渡しOFFとDOMで消し、切替で入力scrollを保つ', () => {
    const {seen}=gpuBackend();const {rerender}=renderUI(<CanvasScene diagnosticsEnabled items={[original]}/>);flushFrame(0);
    rerender(<CanvasScene diagnosticsEnabled items={[incoming,original]}/>);flushFrame(100);flushFrame(250);
    expect(seen.at(-1)!.particles!.length).toBeGreaterThan(0);
    fireEvent.change(screen.getByRole('combobox',{name:'新着エフェクト'}),{target:{value:'off'}});flushFrame(300);
    expect(seen.at(-1)!.particles).toEqual([]);
    fireEvent.change(screen.getByLabelText('下書き'),{target:{value:'keep'}});
    host().scrollTop=90;fireEvent.scroll(host());flushFrame(350);
    fireEvent.change(screen.getByRole('combobox',{name:'QA描画方式'}),{target:{value:'css'}});flushFrame(400);
    expect((screen.getByLabelText('下書き') as HTMLInputElement).value).toBe('keep');expect(host().scrollTop).toBe(90);
  });

  it('5秒計測tokenは有限でDOM計測は起動しない', () => {
    gpuBackend();const {rerender}=renderUI(<CanvasScene diagnosticsEnabled items={[original]} qaMeasurementToken={0}/>);flushFrame(0);
    rerender(<CanvasScene diagnosticsEnabled items={[original]} qaMeasurementToken={1}/>);flushFrame(10);flushFrame(5010);
    expect(screen.getByLabelText('実フィードframe比較結果').textContent).toContain('webgl');expect(frames.size).toBe(0);
    fireEvent.click(screen.getByRole('button',{name:'DOMに切替'}));flushFrame(5100);
    fireEvent.click(screen.getByRole('button',{name:'5秒frame比較'}));expect(frames.size).toBe(0);
  });
  it('GPUの最後の描画姿勢とboxをpointerdownからclick完了まで固定する', () => {
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    const {seen}=gpuBackend();localStorage.setItem('nlc-v2-effect','domino');
    const {rerender}=renderUI(<CanvasScene diagnosticsEnabled items={[original]}/>);flushFrame(0);
    rerender(<CanvasScene diagnosticsEnabled items={[incoming,original]}/>);flushFrame(100);flushFrame(250);
    const drawn=seen.at(-1)!.cards.find(c=>c.id==='a')!;
    expect(drawn.tip!.amount).toBeGreaterThan(0);
    expect(card('a').style.height).toBe(`${drawn.box.height}px`);
    const button=screen.getByRole('button',{name:'クリック 0'});
    pointer(button,'pointerdown');fireEvent.focus(button);flushFrame(550);
    const frozen=seen.at(-1)!.cards.find(c=>c.id==='a')!;
    expect(frozen.box).toEqual(drawn.box);expect(frozen.tip).toEqual(drawn.tip);
    expect(seen.at(-1)!.pinnedIds!.has('a')).toBe(true);
    pointer(window,'pointerup');fireEvent.click(button);act(()=>vi.advanceTimersByTime(0));flushFrame(600);
    expect(screen.getByRole('button',{name:'クリック 1'})).toBeDefined();
    expect(seen.at(-1)!.cards.find(c=>c.id==='a')!.tip).toBeUndefined();
  });

  it('GPU reduced-motionでtipと粒を止め旧batchを再生しない', () => {
    const {seen}=gpuBackend();localStorage.setItem('nlc-v2-effect','domino');
    let changed:(()=>void)|undefined;
    const media={matches:false,addEventListener(_type:string,fn:()=>void){changed=fn;},removeEventListener(){}};
    vi.stubGlobal('matchMedia',()=>media);
    const {rerender}=renderUI(<CanvasScene diagnosticsEnabled items={[original]}/>);flushFrame(0);
    rerender(<CanvasScene diagnosticsEnabled items={[incoming,original]}/>);flushFrame(100);flushFrame(250);
    expect(seen.at(-1)!.cards.some(c=>c.tip)).toBe(true);
    act(()=>{media.matches=true;changed!();});flushFrame(300);
    expect(seen.at(-1)!.cards.every(c=>!c.tip)).toBe(true);expect(seen.at(-1)!.particles).toEqual([]);
    act(()=>{media.matches=false;changed!();});flushFrame(350);
    expect(seen.at(-1)!.cards.every(c=>!c.tip)).toBe(true);expect(host().dataset.scenePushEffect).toBe('idle');
  });

  it.each([['Program failed','program-link'],['Fragment shader failed','fragment-compile'],['https://private.example/?token=secret','unknown']])('init分類は固定値のみ: %s', (message,code) => {
    mockModernNative();backendMock.create.mockImplementation(()=>{throw new Error(message);});
    renderUI(<CanvasScene diagnosticsEnabled items={[original]}/>);flushFrame(0);
    expect(host().dataset.sceneFallbackStage).toBe('init');expect(host().dataset.sceneFallbackReason).toBe(code);
    expect(document.querySelector('[data-renderer-status]')!.textContent).toContain(`init/${code}`);
    expect(host().outerHTML).not.toContain(message);
  });
  it('render分類とmanual切替は旧診断を引き継がない', () => {
    const {draw}=gpuBackend();draw.mockImplementation(()=>{throw new Error('Texture budget limit');});
    renderUI(<CanvasScene diagnosticsEnabled items={[original]}/>);flushFrame(0);
    expect(host().dataset.sceneFallbackStage).toBe('render');expect(host().dataset.sceneFallbackReason).toBe('texture-budget');
    fireEvent.click(screen.getByRole('button',{name:'DOMに切替'}));flushFrame(20);
    expect(host().dataset.sceneFallbackStage).toBe('manual');expect(host().dataset.sceneFallbackReason).toBe('requested');
  });
  it('paint未発火をwatchdog分類しcontext lossと分ける', () => {
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});gpuBackend();
    Object.defineProperty(HTMLCanvasElement.prototype,'requestPaint',{configurable:true,value:vi.fn()});
    renderUI(<CanvasScene diagnosticsEnabled items={[original]}/>);flushFrame(0);
    act(()=>vi.advanceTimersByTime(2500));flushFrame(2600);
    expect(host().dataset.sceneFallbackStage).toBe('watchdog');expect(host().dataset.sceneFallbackReason).toBe('paint-timeout');
  });

});
