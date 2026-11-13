import type { SceneBox, SceneInsertionTrace } from './scene';

export interface RippleSource { readonly id: string; readonly x: number; readonly y: number }
export interface RippleWave { readonly source: RippleSource; readonly startedAt: number; readonly targets: ReadonlySet<string> }
export interface ActiveRippleSource extends RippleSource { readonly ageMs: number; readonly amount: number }
export interface RadialRipple { readonly sources: readonly ActiveRippleSource[] }
export const RIPPLE_EFFECT_DURATION_MS = 1800;
export const RIPPLE_EFFECT_MAX_ACTIVE_WAVES = 16;
export const RIPPLE_EFFECT_MAX_DISPLACEMENT_PX = 6;
export const RIPPLE_EFFECT_SPEED_PX_PER_MS = 1;
export const RIPPLE_EFFECT_RING_SPACING_PX = 200;
export const RIPPLE_EFFECT_RING_WIDTH_PX = 70;

/** 各波の絶対開始時刻を保ち、寿命が終わった波だけを除く。 */
export function pruneRippleWaves(waves: readonly RippleWave[], now: number): readonly RippleWave[] {
  if (!Number.isFinite(now)) return [];
  return waves.filter(wave => Number.isFinite(wave.startedAt) && now >= wave.startedAt && now-wave.startedAt<RIPPLE_EFFECT_DURATION_MS).slice(0,RIPPLE_EFFECT_MAX_ACTIVE_WAVES);
}
/** 新着ごとに中心とその押出対象を凍結。満杯時は新しい演出を省略し、進行中の波を切らない。 */
export function appendRippleWaves(previous: readonly RippleWave[], traces: readonly SceneInsertionTrace[], boxes: ReadonlyMap<string,SceneBox>, now: number): readonly RippleWave[] {
  const waves=[...pruneRippleWaves(previous,now)];
  if (!Number.isFinite(now)) return waves;
  const seen=new Set<string>();
  for(let i=traces.length-1;i>=0 && waves.length<RIPPLE_EFFECT_MAX_ACTIVE_WAVES;i--) {
    const trace=traces[i],id=trace.sourceId,box=boxes.get(id);
    if(seen.has(id))continue;
    seen.add(id);
    if(!box || ![box.x,box.y,box.width,box.height,box.x+box.width,box.y+box.height].every(Number.isFinite) || box.width<=0 || box.height<=0)continue;
    const targets=new Set(trace.edges.map(edge=>edge.toId));
    if(!targets.size)continue;
    const source=Object.freeze({id,x:box.x+box.width/2,y:box.y+box.height/2});
    waves.push(Object.freeze({source,startedAt:now,targets}));
  }
  return Object.freeze(waves);
}
export function rippleEffectAmount(progress: number): number {
  if (!Number.isFinite(progress) || progress<=0 || progress>=1) return 0;
  const edge=Math.min(1,progress/.08,(1-progress)/.18);
  return edge*edge*(3-2*edge);
}
/** 対象カードには、そのカードを実際に押した波だけを独立した時刻で渡す。 */
export function rippleForCard(waves: readonly RippleWave[], id: string, now: number, options: {reducedMotion?:boolean} = {}): RadialRipple | undefined {
  if(options.reducedMotion)return;
  const sources=pruneRippleWaves(waves,now).flatMap(wave=>{
    if(!wave.targets.has(id))return [];
    const ageMs=now-wave.startedAt,amount=rippleEffectAmount(ageMs/RIPPLE_EFFECT_DURATION_MS);
    return amount>0?[{...wave.source,ageMs,amount}]:[];
  });
  return sources.length?{sources}:undefined;
}
/** shaderと同じworld空間の波。寿命fadeを含む最強の一波を選び、変位を加算しない。 */
export function sampleRadialRipple(effect: RadialRipple, x: number, y: number): {offsetX:number;offsetY:number;light:number;trough:number} {
  let strength=0,distance=0,weight=0,dx=0,dy=0;
  for(const source of effect.sources.slice(0,RIPPLE_EFFECT_MAX_ACTIVE_WAVES)) {
    const vx=x-source.x,vy=y-source.y,length=Math.hypot(vx,vy),amount=Math.max(0,Math.min(1,source.amount));
    for(let ring=0;ring<2;ring++) {
      const radius=source.ageMs*RIPPLE_EFFECT_SPEED_PX_PER_MS-ring*RIPPLE_EFFECT_RING_SPACING_PX;
      const d=length-radius,w=ring===0?1:.65;
      if(radius<0 || Math.abs(d)>3*RIPPLE_EFFECT_RING_WIDTH_PX)continue;
      const candidate=Math.exp(-.5*(d/RIPPLE_EFFECT_RING_WIDTH_PX)**2)*w*amount;
      if(candidate>strength){strength=candidate;distance=d;weight=w*amount;dx=length>0?vx/length:0;dy=length>0?vy/length:0;}
    }
  }
  const wave=Math.sin(distance/32)*strength*RIPPLE_EFFECT_MAX_DISPLACEMENT_PX;
  return {offsetX:dx*wave,offsetY:dy*wave,light:strength*.4,trough:strength>0?Math.exp(-.5*((distance+65)/65)**2)*weight*.18:0};
}
