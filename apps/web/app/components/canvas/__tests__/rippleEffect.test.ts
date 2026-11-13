import { describe, expect, it } from 'vitest';
import { appendRippleWaves,pruneRippleWaves,rippleForCard,sampleRadialRipple,rippleEffectAmount,RIPPLE_EFFECT_DURATION_MS,RIPPLE_EFFECT_MAX_ACTIVE_WAVES } from '../rippleEffect';
import type { SceneBox,SceneInsertionTrace } from '../scene';
const box=(x:number,y:number):SceneBox=>({x,y,width:100,height:100});
const trace=(sourceId:string,...targets:string[]):SceneInsertionTrace=>({sourceId,edges:targets.map(toId=>({fromId:sourceId,toId}))});
const single=(age:number,x=0,y=0)=>({sources:[{id:'r',x,y,ageMs:age,amount:rippleEffectAmount(age/RIPPLE_EFFECT_DURATION_MS)}]});
describe('独立した開始時刻と押出し対象を保つ同心波',()=>{
 it('連続挿入でも進行中の開始時刻/中心/対象を上書きせず別々に終了する',()=>{
  const boxes=new Map([['a',box(0,0)],['b',box(500,0)]]);
  const first=appendRippleWaves([], [trace('a','x')],boxes,100);
  const both=appendRippleWaves(first,[trace('b','y')],boxes,400);
  expect(both).toHaveLength(2);expect(both[0]).toBe(first[0]);
  expect(rippleForCard(both,'x',600)?.sources).toEqual([{id:'a',x:50,y:50,ageMs:500,amount:1}]);
  expect(rippleForCard(both,'y',600)?.sources[0]).toMatchObject({id:'b',ageMs:200});
  expect(rippleForCard(both,'x',1900)).toBeUndefined();expect(rippleForCard(both,'y',1900)).toBeDefined();
  expect(pruneRippleWaves(both,2200)).toHaveLength(0);
  boxes.get('a')!.x=999;expect(first[0].source.x).toBe(50);
 });
 it('波ごとのtoIdだけを採用し、根/held迂回/別波の対象へ漏れない',()=>{
  const mutableEdges=[{fromId:'a',toId:'b'},{fromId:'b',toId:'tail'}];
  const traces=[{sourceId:'a',edges:mutableEdges},trace('d','a'),trace('empty')];
  const waves=appendRippleWaves([],traces,new Map(['a','d','empty'].map(id=>[id,box(0,0)])),0);
  expect(rippleForCard(waves,'b',500)?.sources.map(s=>s.id)).toEqual(['a']);
  expect(rippleForCard(waves,'a',500)?.sources.map(s=>s.id)).toEqual(['d']);
  for(const id of ['d','empty','held-redirect','unrelated','later-reflow'])expect(rippleForCard(waves,id,500)).toBeUndefined();
  mutableEdges.push({fromId:'a',toId:'later-reflow'});
  expect(rippleForCard(waves,'later-reflow',500)).toBeUndefined();
  expect(rippleForCard(waves,'tail',500)).toBeDefined();
 });
 it('同じ対象の重複波も独立したageを保持する',()=>{
  const boxes=new Map([['a',box(0,0)],['b',box(500,0)]]);
  const first=appendRippleWaves([], [trace('a','x')],boxes,0);
  const both=appendRippleWaves(first,[trace('b','x')],boxes,500);
  expect(rippleForCard(both,'x',800)?.sources.map(s=>[s.id,s.ageMs])).toEqual([['a',800],['b',300]]);
 });
 it('同時16波の上限では新規演出を省略し、既存の波を退場させない',()=>{
  const boxes=new Map<string,SceneBox>(),traces:SceneInsertionTrace[]=[];
  for(let i=0;i<20;i++){boxes.set(String(i),box(i*100,0));traces.push(trace(String(i),'target'));}
  const first=appendRippleWaves([],traces,boxes,0);
  expect(first).toHaveLength(RIPPLE_EFFECT_MAX_ACTIVE_WAVES);
  const next=appendRippleWaves(first,[trace('0','other')],boxes,100);
  expect(next).toEqual(first);expect(rippleForCard(next,'other',500)).toBeUndefined();
  const after=appendRippleWaves(next,[trace('0','other')],boxes,1800);
  expect(after).toHaveLength(1);expect(after[0].source.id).toBe('0');expect(after[0].startedAt).toBe(1800);
 });
 it('burst内重複根を除き、長い連鎖の対象は途中で切らない',()=>{
  const targets=Array.from({length:120},(_,i)=>String(i));
  const waves=appendRippleWaves([],[trace('r',...targets),trace('r',...targets)],new Map([['r',box(0,0)]]),0);
  expect(waves).toHaveLength(1);expect(waves[0].targets.size).toBe(120);
  expect(rippleForCard(waves,'119',500)).toBeDefined();
 });
 it('不正な中心/時刻・辺なしを採用せず、開始/終了/reducedで表示しない',()=>{
  const waves=appendRippleWaves([],[trace('r','x')],new Map([['r',box(0,0)]]),0);
  for(const time of [NaN,-1,0,1800])expect(rippleForCard(waves,'x',time)).toBeUndefined();
  expect(rippleForCard(waves,'x',500,{reducedMotion:true})).toBeUndefined();
  expect(appendRippleWaves([], [trace('bad','x')],new Map([['bad',box(NaN,0)]]),0)).toHaveLength(0);
  expect(appendRippleWaves([], [trace('r','x')],new Map([['r',box(0,0)]]),NaN)).toHaveLength(0);
  expect(rippleEffectAmount(.5)).toBe(1);
 });
 it('同world点は別カードUVやscrollでも同じで、等距離は同心円になる',()=>{
  const effect=single(500,50,50);
  const a={origin:box(500,0),u:.5,v:.5},b={origin:box(520,-30),u:.3,v:.8};
  const value=(c:typeof a)=>sampleRadialRipple(effect,c.origin.x+c.u*c.origin.width,c.origin.y+c.v*c.origin.height);
  expect(value(a)).toEqual(value(b));expect(value(a).light).toBeGreaterThan(0);
  const right=sampleRadialRipple(effect,550,50),down=sampleRadialRipple(effect,50,550);
  expect(right.light).toBeCloseTo(down.light);expect(right.trough).toBeCloseTo(down.trough);
  const worldY=550,scroll=930;expect(sampleRadialRipple(effect,50,worldY-scroll+scroll)).toEqual(down);
 });
 it('主波と200px遅れの輪を合成しても変位は6px以内',()=>{
  const effect=single(800);
  expect(sampleRadialRipple(effect,800,0).light).toBeCloseTo(.4);expect(sampleRadialRipple(effect,600,0).light).toBeCloseTo(.4*.65);
  const multi={sources:Array.from({length:16},(_,i)=>({id:String(i),x:i*20,y:i*5,ageMs:800-i*10,amount:1}))};
  expect(sampleRadialRipple({...effect,sources:[effect.sources[0],effect.sources[0]]},850,0)).toEqual(sampleRadialRipple(effect,850,0));
  let max=0;for(let x=-1200;x<=1200;x+=31)for(let y=-1200;y<=1200;y+=37){const p=sampleRadialRipple(multi,x,y);max=Math.max(max,Math.hypot(p.offsetX,p.offsetY));expect(p.light).toBeLessThanOrEqual(.4);}
  expect(max).toBeGreaterThan(4);expect(max).toBeLessThanOrEqual(6);
 });
 it('最強波は寿命fade込みで選び、薄い旧波が新しい波を隠さない',()=>{
  const source={id:'a',x:0,y:0,ageMs:800,amount:.01};
  const strong={id:'b',x:50,y:0,ageMs:800,amount:1};
  const mixed=sampleRadialRipple({sources:[source,strong]},800,0);
  expect(mixed).toEqual(sampleRadialRipple({sources:[strong]},800,0));
 });
});
