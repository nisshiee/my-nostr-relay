/** V2の座標はCSS px。既存スロットの順序を保持してライブ更新での跳ねを防ぐ。 */
export interface SceneBox { x: number; y: number; width: number; height: number }
export interface Camera { x: number; y: number; zoom: number }
export function layoutScene(ids: string[], heights: ReadonlyMap<string, number>, viewport: number, previous: ReadonlyMap<string, SceneBox>, held: ReadonlySet<string> = new Set()): Map<string, SceneBox> {
  const width = Math.max(160, Math.min(360, viewport - 32));
  const columns = Math.max(1, Math.floor((viewport - 16) / (width + 16)));
  const ends = Array.from({ length: columns }, () => 16);
  const result = new Map<string, SceneBox>();
  // hold中は列と位置を保持し、高さが増えたカードの後続だけを押し下げる。
  if (held.size) {
    const placed: SceneBox[] = [];
    for (const id of ids.filter(id => held.has(id))) {
      const old = previous.get(id);
      if (!old) continue;
      const box = { ...old, height: heights.get(id) ?? old.height };
      result.set(id, box); placed.push(box);
    }
    const rest = ids.filter(id => previous.has(id) && !held.has(id)).sort((a,b) => previous.get(a)!.y - previous.get(b)!.y);
    for (const id of rest) {
      const old = previous.get(id)!;
      const box = { ...old, height: heights.get(id) ?? old.height };
      let overlap: SceneBox | undefined;
      while ((overlap = placed.find(p => box.x < p.x + p.width && box.x + box.width > p.x && box.y < p.y + p.height + 16 && box.y + box.height + 16 > p.y))) box.y = overlap.y + overlap.height + 16;
      result.set(id, box); placed.push(box);
    }
    for (const box of placed) {
      const col = Math.min(columns - 1, Math.max(0, Math.round((box.x - 16) / (width + 16))));
      ends[col] = Math.max(ends[col], box.y + box.height + 16);
    }
  }
  const existing = ids.filter(id => previous.has(id));
  existing.sort((a,b) => previous.get(a)!.y - previous.get(b)!.y || previous.get(a)!.x - previous.get(b)!.x);
  for (const id of [...existing, ...ids.filter(id => !previous.has(id))]) {
    if (result.has(id)) continue;
    const col = ends.indexOf(Math.min(...ends));
    const height = Math.max(1, heights.get(id) ?? 180);
    result.set(id, { x: 16 + col * (width + 16), y: ends[col], width, height });
    ends[col] += height + 16;
  }
  return result;
}
export function zoomCamera(camera: Camera, zoom: number, x: number, y: number): Camera {
  const next = Math.max(0.35, Math.min(2, zoom));
  const ratio = next / camera.zoom;
  return { x: x - (x - camera.x) * ratio, y: y - (y - camera.y) * ratio, zoom: next };
}
export type CanvasMode = 'modern' | 'legacy' | 'dom';
export interface DrawableContext extends CanvasRenderingContext2D {
  drawElementImage(element: Element, x: number, y: number, width: number, height: number): DOMMatrix | undefined;
}
export interface DrawableCanvas extends HTMLCanvasElement { requestPaint?: () => void }
export function detectCanvasMode(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D | null): CanvasMode {
  if (typeof (canvas as DrawableCanvas).requestPaint !== 'function' || typeof (context as DrawableContext | null)?.drawElementImage !== 'function') return 'dom';
  return 'content' in canvas ? 'modern' : 'legacy';
}
