import { describe, expect, it } from 'vitest';
import { freezeRippleSources,createRadialRipple,sampleRadialRipple,rippleEffectAmount,RIPPLE_EFFECT_DURATION_MS } from '../rippleEffect';
import type { SceneBox,SceneInsertionTrace } from '../scene';
const box=(x:number,y:number):SceneBox=>({x,y,width:100,height:100});
describe('新着中心を固定するworld空間同心波',()=>{
 it('辺のない新着でも最新4根の目標中心を値で凍結し重複を除く',()=>{
  const boxes=new Map<string,SceneBox>(),traces:SceneInsertionTrace[]=[];
  for(let i=0;i<6;i++){boxes.set(String(i),box(i*100,0));traces.push({sourceId:String(i),edges:[]});}
  traces.push({sourceId:'5',edges:[]});const sources=freezeRippleSources(traces,boxes);
  expect(sources.map(s=>s.id)).toEqual(['5','4','3','2']);expect(sources[0]).toEqual({id:'5',x:550,y:50});
  boxes.get('5')!.x=999;expect(sources[0].x).toBe(550);expect(Object.isFrozen(sources)).toBe(true);expect(Object.isFrozen(sources[0])).toBe(true);
 });
 it('寿命/reducedで停止し時刻だけ進め、カメラやカード位置で波源を変えない',()=>{
  const sources=freezeRippleSources([{sourceId:'r',edges:[]}],new Map([['r',box(0,0)]]));
  for(const age of [NaN,-1,0,RIPPLE_EFFECT_DURATION_MS])expect(createRadialRipple(sources,age)).toBeUndefined();
  expect(createRadialRipple(sources,500,{reducedMotion:true})).toBeUndefined();
  expect(createRadialRipple([],500)).toBeUndefined();expect(createRadialRipple([{id:'x',x:NaN,y:0}],500)).toBeUndefined();
  expect(createRadialRipple(sources,500)?.sources).toEqual(sources);expect(rippleEffectAmount(.5)).toBe(1);
 });
 it('同world点は別カードUVやscrollを介しても同じで、等距離は同心円になる',()=>{
  const effect=createRadialRipple([{id:'r',x:50,y:50}],500)!;
  const a={origin:box(500,0),u:.5,v:.5},b={origin:box(520,-30),u:.3,v:.8};
  const value=(c:typeof a)=>sampleRadialRipple(effect,c.origin.x+c.u*c.origin.width,c.origin.y+c.v*c.origin.height);
  expect(value(a)).toEqual(value(b));expect(value(a).light).toBeGreaterThan(0);
  const right=sampleRadialRipple(effect,550,50),down=sampleRadialRipple(effect,50,550);
  expect(right.light).toBeCloseTo(down.light);expect(right.trough).toBeCloseTo(down.trough);
  const worldY=550,scroll=930;expect(sampleRadialRipple(effect,50,worldY-scroll+scroll)).toEqual(down);
  expect(sampleRadialRipple(effect,50,50).light).toBe(0);
 });
 it('主波と200px遅れの輪があり、複数源も加算せず6px以内',()=>{
  const single=createRadialRipple([{id:'r',x:0,y:0}],800)!;
  expect(sampleRadialRipple(single,800,0).light).toBeCloseTo(.4);expect(sampleRadialRipple(single,600,0).light).toBeCloseTo(.4*.65);
  const multi=createRadialRipple([{id:'a',x:0,y:0},{id:'b',x:0,y:0},{id:'c',x:100,y:0},{id:'d',x:0,y:100},{id:'e',x:800,y:0}],800)!;
  expect(multi.sources).toHaveLength(4);
  expect(sampleRadialRipple({...single,sources:[single.sources[0],single.sources[0]]},850,0)).toEqual(sampleRadialRipple(single,850,0));
  let max=0;for(let x=-1200;x<=1200;x+=13)for(let y=-1200;y<=1200;y+=17){const p=sampleRadialRipple(multi,x,y);max=Math.max(max,Math.hypot(p.offsetX,p.offsetY));expect(p.light).toBeLessThanOrEqual(.4);}
  expect(max).toBeGreaterThan(4);expect(max).toBeLessThanOrEqual(6);
  expect(sampleRadialRipple(single,1011,0)).toEqual({offsetX:0,offsetY:0,light:0,trough:0});
 });
});
