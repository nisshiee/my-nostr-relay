import { describe, expect, it } from 'vitest';
import { detectCanvasMode, layoutScene, zoomCamera } from '../scene';
describe('V2 scene', () => {
  it('能力がない環境ではDOMにする', () => {
    expect(detectCanvasMode({} as HTMLCanvasElement, null)).toBe('dom');
    expect(detectCanvasMode({requestPaint() {}} as unknown as HTMLCanvasElement, {} as CanvasRenderingContext2D)).toBe('dom');
  });
  it('API世代を分ける', () => {
    const ctx = {drawElementImage() {}} as unknown as CanvasRenderingContext2D;
    expect(detectCanvasMode({requestPaint() {}} as unknown as HTMLCanvasElement, ctx)).toBe('legacy');
    expect(detectCanvasMode({requestPaint() {}, content: ''} as unknown as HTMLCanvasElement, ctx)).toBe('modern');
  });
  it('カーソル下のワールド座標をズームで維持する', () => {
    const before = {x: 20, y: -80, zoom: 1};
    const next = zoomCamera(before, 1.5, 200, 300);
    expect((200-next.x)/next.zoom).toBe((200-before.x)/before.zoom);
    expect((300-next.y)/next.zoom).toBe((300-before.y)/before.zoom);
    expect(zoomCamera(before, 100, 0, 0).zoom).toBe(2);
  });
  it('既存の順序を守り、削除を反映する', () => {
    const first = layoutScene(['a','b','c'], new Map(), 400, new Map());
    const next = layoutScene(['new','c','a'], new Map(), 400, first);
    expect(next.has('b')).toBe(false);
    expect(next.get('a')!.y).toBeLessThan(next.get('c')!.y);
    expect(next.get('c')!.y).toBeLessThan(next.get('new')!.y);
  });
  it('操作中のカードと新着を重ねない', () => {
    const first = layoutScene(['a','b'], new Map(), 400, new Map());
    const next = layoutScene(['new','a','b'], new Map(), 400, first, new Set(['a']));
    expect(next.get('a')).toEqual(first.get('a'));
    expect(next.get('b')).toEqual(first.get('b'));
    expect(next.get('new')!.y).toBeGreaterThan(next.get('b')!.y);
  });
  it('holdしたカードが成長しても後続は重ならない', () => {
    const first = layoutScene(['a','b'], new Map(), 400, new Map());
    const next = layoutScene(['a','b'], new Map([['a',500]]), 400, first, new Set(['a']));
    expect(next.get('a')!.y).toBe(first.get('a')!.y);
    expect(next.get('b')!.y).toBeGreaterThanOrEqual(next.get('a')!.y + 500 + 16);
  });

});
