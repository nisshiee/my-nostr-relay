// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebGLSceneRenderer, particleVertices, sceneCardMatrix, sceneCardVisible, type WebGLSceneCard, type WebGLSceneFrame } from '../webglSceneRenderer';
import { createDominoTransforms } from '../dominoEffect';
import { projectPoint, type GeometryCanvas, type HtmlTextureGL } from '../webglDomino';
import { createPushParticles, createPushPaths } from '../pushEffect';
const camera={x:0 as const,y:0,zoom:1 as const};
function card(id:string,y=0):WebGLSceneCard {return{id,node:document.createElement('div'),box:{x:16,y,width:100,height:100}};}
function setup(limits?:{totalBytes?:number;singleBytes?:number}) {
  const calls:string[]=[],gl=fakeGL(calls);
  const surface={width:1200,height:800,getElementImageDefaultSize:vi.fn(()=>({width:100,height:100})),updateElementGeometry:vi.fn(()=>calls.push('geometry')),clearElementGeometry:vi.fn()} as unknown as GeometryCanvas;
  return{gl,surface,calls,renderer:createWebGLSceneRenderer(gl,surface,limits)};
}
function frame(cards:WebGLSceneCard[],extra:Partial<WebGLSceneFrame>={}):WebGLSceneFrame{return{cards,camera,viewportWidth:600,viewportHeight:400,changedElements:[],...extra};}
beforeEach(()=>vi.stubGlobal('DOMMatrix',class{constructor(public values:number[]) {}}));afterEach(()=>vi.unstubAllGlobals());
describe('feed WebGLの同一射影・有界texture・前面粒子',()=>{
  it('四方向のDOM/CSS投影と同じ点をcamera変換し、DPRを含めない',()=>{
    for(const [x,y] of [[400,0],[-400,0],[0,400],[0,-400]]) {
      const root={x:500,y:500,width:320,height:180},target={...root,x:500+x,y:500+y};
      const boxes=new Map([['r',root],['t',target]]),tip=createDominoTransforms([{sourceId:'r',edges:[{fromId:'r',toId:'t'}]}],boxes,220).get('t')!;
      const m=sceneCardMatrix(target,{x:0,y:-90,zoom:1},tip);
      for(const [i,[px,py]] of [[0,0],[320,0],[320,180],[0,180]].entries()) {
        const p=projectPoint(m,px,py),expected=tip.perspective.corners[i];expect(p.x).toBeCloseTo(expected.x+target.x,8);expect(p.y).toBeCloseTo(expected.y+target.y-90,8);
      }
    }
  });
  it('可視判定は投影boundsと余白を使う',()=>{const box={x:0,y:500,width:100,height:100};expect(sceneCardVisible(sceneCardMatrix(box,camera),box,600,400)).toBe(false);expect(sceneCardVisible(sceneCardMatrix(box,{...camera,y:-100}),box,600,400)).toBe(true);});
  it('textureを再利用しdirty/input/差分通知なしだけ再upload',()=>{
    const {renderer,gl,surface}=setup(),a=card('a'),child=document.createElement('input');a.node.append(child);
    expect(renderer.render(frame([a])).uploads).toBe(1);expect(renderer.render(frame([a],{camera:{...camera,y:-20}})).uploads).toBe(0);
    expect(renderer.render(frame([a],{changedElements:[child]})).uploads).toBe(1);expect(renderer.render(frame([a],{dirtyIds:new Set(['a'])})).uploads).toBe(1);expect(renderer.render(frame([a],{changedElements:undefined})).uploads).toBe(1);
    expect(gl.texImage2D).toHaveBeenCalledTimes(1);expect(surface.updateElementGeometry).toHaveBeenCalledTimes(5);expect(gl.viewport).toHaveBeenLastCalledWith(0,0,1200,800);
    renderer.dispose();renderer.dispose();expect(gl.deleteTexture).toHaveBeenCalledTimes(1);
  });
  it('画面外変更を覚え再表示時だけupload',()=>{const {renderer}=setup(),a=card('a');renderer.render(frame([a]));a.box={...a.box,y:1000};expect(renderer.render(frame([a],{dirtyIds:new Set(['a'])})).uploads).toBe(0);a.box={...a.box,y:0};expect(renderer.render(frame([a])).uploads).toBe(1);});
  it('可視だけtextureを持ち非可視geometryはTab用に更新',()=>{const {renderer,surface}=setup(),a=card('a'),b=card('b',2000);const r=renderer.render(frame([a,b]));expect(r.drawnIds).toEqual(['a']);expect(r.textureCount).toBe(1);expect(r.geometryUpdates).toBe(2);renderer.render(frame([a]));expect(surface.clearElementGeometry).toHaveBeenCalledWith(b.node);});
  it('予算内でoffscreen LRUを解放しpinnedは追い出さない',()=>{
    const {renderer,gl,surface}=setup({totalBytes:40000}),a=card('a');renderer.render(frame([a]));a.box={...a.box,y:2000};const b=card('b');
    expect(renderer.render(frame([a,b])).textureBytes).toBe(40000);expect(gl.deleteTexture).toHaveBeenCalledTimes(1);
    b.box={...b.box,y:2000};a.box={...a.box,y:0};expect(()=>renderer.render(frame([a,b],{pinnedIds:new Set(['b'])}))).toThrow('budget');expect(surface.clearElementGeometry).toHaveBeenCalled();renderer.dispose();
  });
  it('DPR相当サイズ変更は旧textureを先に破棄し上限を守る',()=>{
    const {renderer,surface,gl}=setup({totalBytes:160000}),a=card('a');renderer.render(frame([a]));vi.mocked(surface.getElementImageDefaultSize!).mockReturnValue({width:200,height:200});expect(renderer.render(frame([a])).textureBytes).toBe(160000);expect(gl.deleteTexture).toHaveBeenCalledTimes(1);
    vi.mocked(surface.getElementImageDefaultSize!).mockReturnValue({width:10000,height:10000});expect(()=>renderer.render(frame([a]))).toThrow('size');
  });
  it('同idのDOM置換と削除でgeometry/textureを解放',()=>{const {renderer,surface,gl}=setup(),a=card('a');renderer.render(frame([a]));const replacement=card('a');expect(renderer.render(frame([replacement])).uploads).toBe(1);expect(surface.clearElementGeometry).toHaveBeenCalledWith(a.node);renderer.render(frame([]));expect(gl.deleteTexture).toHaveBeenCalledTimes(2);renderer.dispose();});
  it('前面粒子を最後に描き次frameはquad属性へ戻す',()=>{
    const {renderer,gl,calls}=setup(),a=card('a'),b=card('b',200),paths=createPushPaths([{sourceId:'a',edges:[{fromId:'a',toId:'b'}]}],new Map([['a',a.box],['b',b.box]])),particles=createPushParticles(paths,300);
    expect(renderer.render(frame([a,b],{particles,particleOpacity:1})).draws).toBe(3);expect(calls.slice(-1)).toEqual(['draw']);expect(gl.drawArrays).toHaveBeenLastCalledWith(gl.TRIANGLES,0,expect.any(Number));renderer.render(frame([a]));expect(gl.vertexAttribPointer).toHaveBeenLastCalledWith(0,2,gl.FLOAT,false,0,0);expect(gl.drawArrays).toHaveBeenLastCalledWith(gl.TRIANGLE_STRIP,0,4);
    expect(particleVertices([...particles,...particles,...particles],1,camera).length).toBeLessThanOrEqual(240*3*16*3*6);
  });
  it('GPU陰影を元矩形の後に透視面へ描き、GL上限問合せは一回だけ',()=>{
    const {renderer,gl}=setup(),a=card('a'),b=card('b',200),boxes=new Map([['a',a.box],['b',b.box]]);
    a.tip=createDominoTransforms([{sourceId:'a',edges:[{fromId:'a',toId:'b'}]}],boxes,220).get('a');
    const result=renderer.render(frame([a]));expect(result.draws).toBe(2);
    expect(vi.mocked(gl.uniform1i).mock.calls.filter(c=>c[0]==='footprint').map(c=>c[1])).toEqual([1,0]);
    expect(gl.uniform1f).toHaveBeenCalledWith('amount',1);renderer.render(frame([a]));expect(gl.getParameter).toHaveBeenCalledTimes(1);
  });
  it('context lossでも既存geometryを消して停止',()=>{
    const {renderer,gl,surface}=setup(),a=card('a');renderer.render(frame([a]));vi.mocked(gl.isContextLost).mockReturnValue(true);
    expect(()=>renderer.render(frame([a]))).toThrow('unavailable');expect(surface.clearElementGeometry).toHaveBeenCalledWith(a.node);renderer.dispose();
  });
  it('upload失敗を偽らずgeometry解放しdisposeできる',()=>{const {renderer,gl,surface}=setup(),a=card('a');renderer.render(frame([a]));vi.mocked(gl.getError).mockReturnValue(999);expect(()=>renderer.render(frame([a],{dirtyIds:new Set(['a'])}))).toThrow('upload');expect(surface.clearElementGeometry).toHaveBeenCalledWith(a.node);renderer.dispose();expect(gl.deleteProgram).toHaveBeenCalledTimes(2);expect(gl.deleteBuffer).toHaveBeenCalledTimes(2);expect(()=>renderer.render(frame([a]))).toThrow('unavailable');});
});
function fakeGL(calls:string[]) {
  const gl:Record<string,unknown>={};
  for(const name of ['VERTEX_SHADER','FRAGMENT_SHADER','COMPILE_STATUS','LINK_STATUS','ARRAY_BUFFER','STATIC_DRAW','DYNAMIC_DRAW','FLOAT','TEXTURE0','TEXTURE_2D','TEXTURE_MIN_FILTER','TEXTURE_MAG_FILTER','LINEAR','TEXTURE_WRAP_S','TEXTURE_WRAP_T','CLAMP_TO_EDGE','UNPACK_FLIP_Y_WEBGL','UNPACK_PREMULTIPLY_ALPHA_WEBGL','BLEND','ONE','ONE_MINUS_SRC_ALPHA','DEPTH_TEST','MAX_TEXTURE_SIZE','RGBA8','RGBA','UNSIGNED_BYTE','COLOR_BUFFER_BIT','TRIANGLE_STRIP','TRIANGLES'])gl[name]=Object.keys(gl).length+1;
  for(const name of ['shaderSource','compileShader','attachShader','linkProgram','useProgram','bindBuffer','bufferData','enableVertexAttribArray','disableVertexAttribArray','vertexAttribPointer','activeTexture','bindTexture','texParameteri','pixelStorei','enable','blendFunc','disable','uniform1i','uniform1f','texImage2D','texElementSubImage2D','viewport','clearColor','clear','uniformMatrix4fv','uniform2f','deleteTexture','deleteBuffer','deleteProgram','deleteShader'])gl[name]=vi.fn();
  for(const name of ['createShader','createProgram','createBuffer','createTexture'])gl[name]=vi.fn(()=>({}));gl.getShaderParameter=vi.fn(()=>true);gl.getProgramParameter=vi.fn(()=>true);gl.getAttribLocation=vi.fn((_p,n)=>n==='tint'?1:0);gl.getUniformLocation=vi.fn((_p,n)=>n);gl.getParameter=vi.fn(()=>4096);gl.getError=vi.fn(()=>0);gl.isContextLost=vi.fn(()=>false);gl.NO_ERROR=0;gl.drawArrays=vi.fn(()=>calls.push('draw'));return gl as unknown as HtmlTextureGL;
}
