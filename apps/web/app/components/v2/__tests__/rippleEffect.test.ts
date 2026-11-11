import { describe, expect, it } from 'vitest';
import { createRippleEffects } from '../rippleEffect';
import type { SceneBox, SceneInsertionTrace } from '../scene';
const boxes = new Map<string, SceneBox>([['r',{x:0,y:0,width:100,height:100}],['a',{x:0,y:200,width:100,height:100}],['b',{x:200,y:200,width:100,height:100}],['other',{x:400,y:400,width:100,height:100}]]);
const traces: SceneInsertionTrace[] = [{sourceId:'r',edges:[{fromId:'a',toId:'b'},{fromId:'r',toId:'a'}]}];
describe('波紋の実因果順・方向・有限寿命',()=>{
 it('辺の順番ではなくBFS深さで下から横へ向きを変える',()=>{
  const result=createRippleEffects(traces,boxes,350);
  expect(result.get('r')).toMatchObject({depth:0,delayMs:0,progress:.5,directionX:0,directionY:1});
  expect(result.get('a')).toMatchObject({depth:1,delayMs:100,directionX:0,directionY:1});
  expect(result.get('b')).toMatchObject({depth:2,delayMs:200,directionX:1,directionY:0});
  expect(result.has('other')).toBe(false);expect(createRippleEffects(traces,boxes,350)).toEqual(result);
 });
 it('開始前・終了・reduced・操作中は描かず解除は現在時刻へ合流',()=>{
  for(const age of [NaN,-1,0,1300])expect(createRippleEffects(traces,boxes,age).size).toBe(0);
  expect(createRippleEffects(traces,boxes,350,{reducedMotion:true}).size).toBe(0);
  expect(createRippleEffects(traces,boxes,350,{heldIds:new Set(['a'])}).has('a')).toBe(false);
  expect(createRippleEffects(traces,boxes,450).get('a')?.progress).toBe(.5);
  expect(createRippleEffects(traces,boxes,50).has('a')).toBe(false);
  expect(createRippleEffects(traces,boxes,700).has('r')).toBe(false);
 });
 it('目標方向を維持し、欠損・循環は有限でburstの根を混線しない',()=>{
  const moved=new Map(boxes);moved.set('b',{...boxes.get('b')!,x:-200});
  expect(createRippleEffects(traces,moved,350,{directionBoxes:boxes}).get('b')?.directionX).toBe(1);
  expect(createRippleEffects([{sourceId:'r',edges:[...traces[0].edges,{fromId:'b',toId:'r'},{fromId:'r',toId:'missing'}]}],boxes,350).size).toBe(3);
  expect(createRippleEffects([...traces,{sourceId:'b',edges:[{fromId:'b',toId:'a'}]}],boxes,350).get('a')?.sourceId).toBe('b');
 });
 it('最新4根だけ処理し不正boxや孤立辺を無関係カードへ広げない',()=>{
  const map=new Map<string,SceneBox>(),batch:SceneInsertionTrace[]=[];
  for(let i=0;i<6;i++){map.set(`r${i}`,{x:i*120,y:0,width:100,height:100});map.set(`c${i}`,{x:i*120,y:120,width:100,height:100});batch.push({sourceId:`r${i}`,edges:[{fromId:`r${i}`,toId:`c${i}`}]});}
  const result=createRippleEffects(batch,map,350);expect(result.size).toBe(8);expect(result.has('r0')).toBe(false);expect(result.has('r1')).toBe(false);expect(result.has('r5')).toBe(true);
  const broken=new Map(boxes);broken.set('b',{...boxes.get('b')!,width:NaN});
  expect(createRippleEffects(traces,broken,350).has('b')).toBe(false);
  expect(createRippleEffects([{sourceId:'r',edges:[{fromId:'a',toId:'b'}]}],boxes,350).size).toBe(0);
 });
 it('辺数と遅延を制限し末尾も1300msで必ず終わる',()=>{
  const many=new Map<string,SceneBox>(),edges=[];for(let i=0;i<200;i++){many.set(String(i),{x:0,y:i*120,width:100,height:100});if(i)edges.push({fromId:String(i-1),toId:String(i)});}
  const trace=[{sourceId:'0',edges}],result=createRippleEffects(trace,many,1299);
  expect(result.size).toBeLessThanOrEqual(97);expect(result.get('96')).toMatchObject({delayMs:600});expect(result.has('97')).toBe(false);
  expect(createRippleEffects(trace,many,1300).size).toBe(0);
 });
});
