// @vitest-environment jsdom
import React from 'react';
import { render, cleanup, screen, act } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectNativeCanvasCapability, useNativeCanvasCapability } from '../nativeCanvasCapability';
const keys=['content','requestPaint','updateElementGeometry','clearElementGeometry','getElementImageDefaultSize'];
const restore: (()=>void)[]=[];
afterEach(()=>{cleanup();restore.splice(0).forEach(fn=>fn());vi.restoreAllMocks();});
function support(){
  const loseContext=vi.fn(),draw=vi.fn();
  const gl={texElementSubImage2D:draw,getExtension:vi.fn(()=>({loseContext}))};
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(gl as unknown as WebGL2RenderingContext);
  for(const key of keys){const old=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,key);Object.defineProperty(HTMLCanvasElement.prototype,key,{configurable:true,value:key==='content'?'drawable':vi.fn()});restore.push(()=>{if(old)Object.defineProperty(HTMLCanvasElement.prototype,key,old);else Reflect.deleteProperty(HTMLCanvasElement.prototype,key);});}
  return{gl,loseContext,draw};
}
describe('認証前の独立native能力検査',()=>{
  it('detached APIだけ確認し描画せずcontextを解放する',()=>{
    const {loseContext,draw}=support();const before=document.querySelectorAll('canvas').length;
    expect(detectNativeCanvasCapability()).toBe(true);expect(loseContext).toHaveBeenCalledOnce();expect(draw).not.toHaveBeenCalled();expect(document.querySelectorAll('canvas')).toHaveLength(before);
  });
  it('WebGLがあってもHTML texture/geometry API不足ならfalse',()=>{
    const {gl,loseContext}=support();Reflect.deleteProperty(HTMLCanvasElement.prototype,'updateElementGeometry');
    expect(detectNativeCanvasCapability()).toBe(false);expect(loseContext).toHaveBeenCalledOnce();expect(gl.texElementSubImage2D).not.toHaveBeenCalled();
  });
  it('context作成例外は非対応へ縮退する',()=>{
    vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockImplementation(()=>{throw new Error('unsupported');});expect(detectNativeCanvasCapability()).toBe(false);
  });
  it('SSRはfalseで取得せず、mount後だけ対応判定を公開する',async()=>{
    support();const context=vi.mocked(HTMLCanvasElement.prototype.getContext);function UI(){return <output>{String(useNativeCanvasCapability())}</output>;}
    expect(renderToString(<UI/>)).toContain('false');expect(context).not.toHaveBeenCalled();
    render(<UI/>);await act(async()=>{await Promise.resolve();});expect(screen.getByText('true')).toBeDefined();expect(context).toHaveBeenCalledOnce();
  });
});
