import type { SceneBox, SceneInsertionTrace } from './scene';

export interface RippleSource { readonly id: string; readonly x: number; readonly y: number }
export interface RadialRipple { readonly sources: readonly RippleSource[]; readonly ageMs: number; readonly amount: number }
export const RIPPLE_EFFECT_DURATION_MS = 1800;
export const RIPPLE_EFFECT_MAX_TRACES = 4;
export const RIPPLE_EFFECT_MAX_DISPLACEMENT_PX = 6;
export const RIPPLE_EFFECT_SPEED_PX_PER_MS = 1;
export const RIPPLE_EFFECT_RING_SPACING_PX = 200;
export const RIPPLE_EFFECT_RING_WIDTH_PX = 70;
/** 新着時に目標中心を値としてコピーし、後続の配置・scrollに追従させない。 */
export function freezeRippleSources(traces: readonly SceneInsertionTrace[], boxes: ReadonlyMap<string, SceneBox>): readonly RippleSource[] {
  const sources: RippleSource[] = [], seen = new Set<string>();
  for (let i=traces.length-1;i>=0 && sources.length<RIPPLE_EFFECT_MAX_TRACES;i--) {
    const id=traces[i].sourceId, box=boxes.get(id);
    if (seen.has(id)) continue;
    seen.add(id);
    if (!box || ![box.x,box.y,box.width,box.height,box.x+box.width,box.y+box.height].every(Number.isFinite) || box.width<=0 || box.height<=0) continue;
    sources.push(Object.freeze({id,x:box.x+box.width/2,y:box.y+box.height/2}));
  }
  return Object.freeze(sources);
}
/** 実配置の押出し辺だけを採用。根自身・高さ補正・後続reflowから対象を推測しない。 */
export function freezeRippleTargets(traces: readonly SceneInsertionTrace[], sources: readonly RippleSource[]): ReadonlySet<string> {
  const sourceIds = new Set(sources.map(source => source.id));
  const targets = new Set<string>();
  for (const trace of traces) {
    if (!sourceIds.has(trace.sourceId)) continue;
    for (const edge of trace.edges) targets.add(edge.toId);
  }
  return targets;
}
export function rippleEffectAmount(progress: number): number {
  if (!Number.isFinite(progress) || progress<=0 || progress>=1) return 0;
  const edge=Math.min(1,progress/.08,(1-progress)/.18);
  return edge*edge*(3-2*edge);
}
export function createRadialRipple(sources: readonly RippleSource[], ageMs: number, options: {reducedMotion?:boolean} = {}): RadialRipple | undefined {
  if (options.reducedMotion || !Number.isFinite(ageMs) || ageMs<=0 || ageMs>=RIPPLE_EFFECT_DURATION_MS) return;
  const valid=sources.slice(0,RIPPLE_EFFECT_MAX_TRACES).filter(source=>Number.isFinite(source.x)&&Number.isFinite(source.y));
  if (!valid.length) return;
  return {sources:valid,ageMs,amount:rippleEffectAmount(ageMs/RIPPLE_EFFECT_DURATION_MS)};
}
/** shaderと同じworld空間の波。重なる根は最強の一波だけ選び、変位を加算しない。 */
export function sampleRadialRipple(effect: RadialRipple, x: number, y: number): {offsetX:number;offsetY:number;light:number;trough:number} {
  let strength=0,distance=0,weight=0,dx=0,dy=0;
  for (const source of effect.sources.slice(0,RIPPLE_EFFECT_MAX_TRACES)) {
    const vx=x-source.x,vy=y-source.y,length=Math.hypot(vx,vy);
    for(let ring=0;ring<2;ring++) {
      const radius=effect.ageMs*RIPPLE_EFFECT_SPEED_PX_PER_MS-ring*RIPPLE_EFFECT_RING_SPACING_PX;
      const d=length-radius,w=ring===0?1:.65;
      if(radius<0 || Math.abs(d)>3*RIPPLE_EFFECT_RING_WIDTH_PX)continue;
      const candidate=Math.exp(-.5*(d/RIPPLE_EFFECT_RING_WIDTH_PX)**2)*w;
      if(candidate>strength){strength=candidate;distance=d;weight=w;dx=length>0?vx/length:0;dy=length>0?vy/length:0;}
    }
  }
  const amount=Math.max(0,Math.min(1,effect.amount)),wave=Math.sin(distance/32)*strength*amount*RIPPLE_EFFECT_MAX_DISPLACEMENT_PX;
  return {offsetX:dx*wave,offsetY:dy*wave,light:strength*amount*.4,trough:strength>0?Math.exp(-.5*((distance+65)/65)**2)*weight*amount*.18:0};
}
