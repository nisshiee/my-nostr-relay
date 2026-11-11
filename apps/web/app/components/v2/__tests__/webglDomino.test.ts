// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clipPoint, createHtmlQuad, needsTextureUpload, probeMatrix, projectPoint, summarizeFrames, type GeometryCanvas, type HtmlTextureGL } from '../webglDomino';
afterEach(() => vi.unstubAllGlobals());
describe('WebGL投影とtexture境界', () => {
  it('上辺固定・下辺拡大、CSS行列とclip座標はDPR1/2/3でも一致', () => {
    const m=probeMatrix(60,80,480,1);
    expect(projectPoint(m,60,60).x).toBeCloseTo(120,10);expect(projectPoint(m,60,60).y).toBeCloseTo(140,10);expect(projectPoint(m,60,60).w).toBe(1);
    expect(projectPoint(m,420,60).x).toBeCloseTo(480,10);expect(projectPoint(m,420,60).y).toBeCloseTo(140,10);
    expect(projectPoint(m,420,380).x-projectPoint(m,60,380).x).toBeGreaterThan(360);
    for(const [x,y] of [[60,60],[420,60],[60,380],[420,380]]) {
      const p=projectPoint(m,x,y),c=clipPoint(m,x,y,600,680);
      for(const dpr of [1,2,3]) { expect((c.x+1)*600*dpr/2).toBeCloseTo(p.x*dpr,8); expect((1-c.y)*680*dpr/2).toBeCloseTo(p.y*dpr,8); }
    }
    expect(projectPoint(probeMatrix(40,90,480,0),23,45)).toEqual({x:63,y:135,w:1});
  });
  it('姿勢だけのframeは再uploadせず入力等の変更/未実装通知は更新', () => {
    const root=document.createElement('div'),child=document.createElement('input');root.append(child);
    expect(needsTextureUpload(false,true,[],root)).toBe(false);
    expect(needsTextureUpload(true,true,[],root)).toBe(true);
    expect(needsTextureUpload(false,false,[],root)).toBe(true);
    expect(needsTextureUpload(false,true,[child],root)).toBe(true);
    expect(needsTextureUpload(false,true,undefined,root)).toBe(true);
    expect(needsTextureUpload(false,true,[document.createElement('p')],root)).toBe(false);
  });
  it('統計は固定閾値と分位数のみ', () => {
    expect(summarizeFrames([16,16,20,40,NaN])).toEqual({count:4,p50:16,p95:40,over33:1});
    expect(summarizeFrames([])).toEqual({count:0,p50:0,p95:0,over33:0});
  });
  it('texture確保一回、draw後に同じ行列のgeometry更新、資源解放', () => {
    vi.stubGlobal('DOMMatrix',class {constructor(public values:number[]) {}});
    const calls:string[]=[],gl=fakeGL(calls),root=document.createElement('div');
    const surface={width:1200,height:1360,getElementImageDefaultSize:()=>({width:960,height:880}),updateElementGeometry:vi.fn(()=>calls.push('geometry')),clearElementGeometry:vi.fn()} as unknown as GeometryCanvas;
    const quad=createHtmlQuad(gl,surface);quad.upload(root);quad.upload(root);
    expect(gl.texImage2D).toHaveBeenCalledTimes(1);expect(gl.texElementSubImage2D).toHaveBeenCalledTimes(2);
    const m=probeMatrix(60,80,480,1);quad.draw(root,m,480,440,600,680);
    expect(gl.viewport).toHaveBeenCalledWith(0,0,1200,1360);
    expect(gl.uniformMatrix4fv).toHaveBeenCalledWith('model',false,new Float32Array(m));
    expect((surface.updateElementGeometry as ReturnType<typeof vi.fn>).mock.calls[0][1].canvasTransform.values).toEqual(m);
    expect(calls.slice(-2)).toEqual(['draw','geometry']);quad.dispose();
    expect(gl.deleteTexture).toHaveBeenCalledTimes(1);expect(gl.deleteBuffer).toHaveBeenCalledTimes(1);expect(gl.deleteProgram).toHaveBeenCalledTimes(1);expect(gl.deleteShader).toHaveBeenCalledTimes(2);
  });
  it('大き過ぎるtextureとAPI欠落は拒否', () => {
    const gl=fakeGL([]),surface={getElementImageDefaultSize:()=>({width:10000,height:10000}),updateElementGeometry(){},clearElementGeometry(){}} as unknown as GeometryCanvas;
    const quad=createHtmlQuad(gl,surface);expect(()=>quad.upload(document.createElement('div'))).toThrow('Texture size');quad.dispose();
    expect(()=>createHtmlQuad(gl,{} as GeometryCanvas)).toThrow('API unavailable');
  });
});
function fakeGL(calls:string[]) {
  const gl:Record<string,unknown>={};
  for(const name of ['VERTEX_SHADER','FRAGMENT_SHADER','COMPILE_STATUS','LINK_STATUS','ARRAY_BUFFER','STATIC_DRAW','FLOAT','TEXTURE0','TEXTURE_2D','TEXTURE_MIN_FILTER','TEXTURE_MAG_FILTER','LINEAR','TEXTURE_WRAP_S','TEXTURE_WRAP_T','CLAMP_TO_EDGE','UNPACK_FLIP_Y_WEBGL','UNPACK_PREMULTIPLY_ALPHA_WEBGL','BLEND','ONE','ONE_MINUS_SRC_ALPHA','DEPTH_TEST','MAX_TEXTURE_SIZE','RGBA8','RGBA','UNSIGNED_BYTE','COLOR_BUFFER_BIT','TRIANGLE_STRIP'])gl[name]=Object.keys(gl).length+1;
  for(const name of ['shaderSource','compileShader','attachShader','linkProgram','useProgram','bindBuffer','bufferData','enableVertexAttribArray','vertexAttribPointer','activeTexture','bindTexture','texParameteri','pixelStorei','enable','blendFunc','disable','uniform1i','texImage2D','texElementSubImage2D','viewport','clearColor','clear','uniformMatrix4fv','uniform2f','deleteTexture','deleteBuffer','deleteProgram','deleteShader'])gl[name]=vi.fn();
  for(const name of ['createShader','createProgram','createBuffer','createTexture'])gl[name]=vi.fn(()=>({}));
  gl.getShaderParameter=vi.fn(()=>true);gl.getProgramParameter=vi.fn(()=>true);gl.getAttribLocation=vi.fn(()=>0);gl.getUniformLocation=vi.fn((_p,n)=>n);gl.getParameter=vi.fn(()=>4096);gl.getError=vi.fn(()=>0);gl.NO_ERROR=0;gl.drawArrays=vi.fn(()=>calls.push('draw'));return gl as unknown as HtmlTextureGL;
}
