// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebGLDominoProbe } from '../WebGLDominoProbe';
import { createHtmlQuad } from '../webglDomino';
vi.mock('../webglDomino', async original => ({ ...await original<typeof import('../webglDomino')>(), createHtmlQuad: vi.fn() }));
let frames:Map<number,FrameRequestCallback>,next:number;
const realMutation=globalThis.MutationObserver;
const originals=new Map(['content','requestPaint','clearElementGeometry'].map(name=>[name,Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,name)]));
beforeEach(()=>{
  frames=new Map();next=0;
  vi.stubGlobal('requestAnimationFrame',(cb:FrameRequestCallback)=>{frames.set(++next,cb);return next;});vi.stubGlobal('cancelAnimationFrame',(id:number)=>frames.delete(id));
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});vi.stubGlobal('MutationObserver',class {observe(){}disconnect(){}});
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({width:600,height:680} as DOMRect);
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(null);
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();for(const [name,d] of originals){if(d)Object.defineProperty(HTMLCanvasElement.prototype,name,d);else Reflect.deleteProperty(HTMLCanvasElement.prototype,name);}});
function tick(time=0){act(()=>{const pending=[...frames.values()];frames.clear();pending.forEach(cb=>cb(time));});}
function native(){
  const quad={upload:vi.fn(),draw:vi.fn(),dispose:vi.fn()};vi.mocked(createHtmlQuad).mockReturnValue(quad);
  const ctx={resetTransform:vi.fn(),clearRect:vi.fn(),setTransform:vi.fn(),drawElementImage:vi.fn()};vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  Object.defineProperty(HTMLCanvasElement.prototype,'content',{configurable:true,value:''});Object.defineProperty(HTMLCanvasElement.prototype,'clearElementGeometry',{configurable:true,value:vi.fn()});
  Object.defineProperty(HTMLCanvasElement.prototype,'requestPaint',{configurable:true,value:function(this:HTMLCanvasElement){const e=new Event('paint');Object.defineProperty(e,'changedElements',{value:[]});this.dispatchEvent(e);}});return {quad,ctx};
}
const root=()=>document.querySelector<HTMLElement>('[data-webgl-probe-root]')!;
const face=()=>document.querySelector<HTMLElement>('[data-webgl-probe-face]')!;
describe('WebGL probe API契約（native画素/hit実証ではない）',()=>{
  it('APIなしは平面DOM、四隅と入力は操作可',()=>{
    render(<WebGLDominoProbe/>);tick();expect(screen.getByRole('status',{name:'描画状態'}).textContent).toContain('API未対応');expect(face().style.transform).toBe('');
    for(const label of ['左上','右上','左下','右下']){fireEvent.click(screen.getByRole('button',{name:`${label} 0`}));expect(screen.getByRole('button',{name:`${label} 1`})).toBeDefined();}
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'日本語'}});expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('日本語');
    fireEvent.click(screen.getByRole('button',{name:'5秒比較計測'}));expect(screen.getByLabelText('frame比較結果').textContent).toContain('開始しません');
  });
  it('DOM idleで実MutationObserverが自己style更新の無限rAFを起こさない',async()=>{
    vi.stubGlobal('MutationObserver',realMutation);render(<WebGLDominoProbe/>);
    for(let i=0;i<5;i++){tick(i*16);await act(async()=>{});}
    expect(frames.size).toBe(0);
  });
  it('GLは初回upload後の姿勢frameでtextureを再利用しinput変更時だけ更新',()=>{
    const {quad}=native();render(<WebGLDominoProbe/>);tick();expect(quad.upload).toHaveBeenCalledTimes(1);expect(face().style.transform).toBe('');
    fireEvent.click(screen.getByRole('button',{name:'一回動かす'}));tick(100);tick(200);tick(300);expect(quad.upload).toHaveBeenCalledTimes(1);expect(quad.draw.mock.calls.length).toBeGreaterThan(1);expect(face().style.transform).toBe('');
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'更新'}});tick(400);expect(quad.upload).toHaveBeenCalledTimes(2);
  });
  it('CSS比較とDOM往復でも同じportalを維持、DOMは無変形',()=>{
    const {ctx,quad}=native();render(<WebGLDominoProbe/>);tick();const original=root();fireEvent.click(screen.getByRole('button',{name:'左上 0'}));
    fireEvent.change(screen.getByRole('combobox'),{target:{value:'css'}});tick();expect(root()).toBe(original);expect(face().style.transform).toContain('rotateX(52deg)');expect(ctx.drawElementImage).toHaveBeenCalled();expect(quad.dispose).toHaveBeenCalled();
    fireEvent.change(screen.getByRole('combobox'),{target:{value:'dom'}});tick();expect(face().style.transform).toBe('');expect(screen.getByRole('button',{name:'左上 1'})).toBeDefined();
  });
  it('5秒でrAF計測が終了、unmount時資源解放',()=>{
    const {quad}=native();const view=render(<WebGLDominoProbe/>);tick();fireEvent.click(screen.getByRole('button',{name:'5秒比較計測'}));tick(100);tick(116);tick(136);tick(180);tick(5100);
    expect(screen.getByLabelText('frame比較結果').textContent).toContain('rAF intervals');expect(frames.size).toBe(0);view.unmount();expect(quad.dispose).toHaveBeenCalled();
  });
  it('context消失でgeometryを消し平面DOMへ戻す',()=>{
    const {quad}=native();render(<WebGLDominoProbe/>);tick();fireEvent(document.querySelector('canvas')!,new Event('webglcontextlost',{cancelable:true}));
    expect(screen.getByRole('status',{name:'描画状態'}).textContent).toContain('context lost');expect(face().style.transform).toBe('');expect(root().hasAttribute('drawable')).toBe(false);expect(quad.dispose).toHaveBeenCalled();
  });
});
