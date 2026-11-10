export interface PushEffectBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PushEffectTrace {
  readonly sourceId: string;
  readonly edges: readonly { readonly fromId: string; readonly toId: string }[];
}

export interface PushEffectPath {
  readonly sourceId: string;
  readonly fromId: string;
  readonly toId: string;
  readonly startX: number;
  readonly startY: number;
  readonly control1X: number;
  readonly control1Y: number;
  readonly control2X: number;
  readonly control2Y: number;
  readonly endX: number;
  readonly endY: number;
  readonly d: string;
}

export const PUSH_EFFECT_DURATION_MS = 1400;
export const PUSH_EFFECT_FADE_IN_MS = 80;
export const PUSH_EFFECT_MAX_TRACES = 4;
export const PUSH_EFFECT_MAX_EDGES = 96;
export const PUSH_EFFECT_STYLE = Object.freeze({
  color: '#0284c7',
  mainWidth: 2,
  mainAlpha: 0.6,
  haloWidth: 4.5,
  haloAlpha: 0.14,
});

const GUTTER = 6;

function validBox(box: PushEffectBox | undefined): box is PushEffectBox {
  return box !== undefined && Number.isFinite(box.x) && Number.isFinite(box.y) &&
    Number.isFinite(box.width) && Number.isFinite(box.height) && box.width >= 0 && box.height >= 0;
}

/** 制御点の外接矩形でのみ除外し、画面を横切る曲線を端点だけで落とさない。 */
function outsideViewport(path: PushEffectPath, viewport: PushEffectBox): boolean {
  const padding = PUSH_EFFECT_STYLE.haloWidth / 2;
  const xs = [path.startX, path.control1X, path.control2X, path.endX];
  const ys = [path.startY, path.control1Y, path.control2Y, path.endY];
  return Math.max(...xs) + padding < viewport.x ||
    Math.min(...xs) - padding > viewport.x + viewport.width ||
    Math.max(...ys) + padding < viewport.y ||
    Math.min(...ys) - padding > viewport.y + viewport.height;
}

/**
 * 実際の押出親子辺だけを、現在の表示座標へ投影する。移動履歴やchainOrderは使わない。
 * 新しい根を優先して最大4件・96辺だけ調べる。各曲線は独立し、別の根へ接続しない。
 */
export function createPushPaths(
  traces: readonly PushEffectTrace[],
  boxes: ReadonlyMap<string, PushEffectBox>,
  viewport?: PushEffectBox,
): readonly PushEffectPath[] {
  const paths: PushEffectPath[] = [];
  const firstTrace = Math.max(0, traces.length - PUSH_EFFECT_MAX_TRACES);
  let inspected = 0;
  for (let index = traces.length - 1; index >= firstTrace && inspected < PUSH_EFFECT_MAX_EDGES; index--) {
    const trace = traces[index];
    for (const edge of trace.edges) {
      if (inspected >= PUSH_EFFECT_MAX_EDGES) break;
      inspected++;
      if (edge.fromId === edge.toId) continue;
      const from = boxes.get(edge.fromId);
      const to = boxes.get(edge.toId);
      if (!validBox(from) || !validBox(to)) continue;

      const horizontalDistance = to.x - from.x;
      const direction = horizontalDistance >= 0 ? 1 : -1;
      const progress = Math.min(1, Math.abs(horizontalDistance) / Math.max(1, Math.min(from.width, to.width) / 2));
      // 横移動を始めた瞬間に接続先が反対側へ飛ばないよう、余白から側面へ連続的に寄せる。
      const blend = progress * progress * (3 - 2 * progress);
      const interpolate = (column: number, crossColumn: number) => column + (crossColumn - column) * blend;
      const leftStartX = from.x - GUTTER;
      const leftEndX = to.x - GUTTER;
      const crossStartX = direction < 0 ? leftStartX : from.x + from.width + GUTTER;
      const crossEndX = direction > 0 ? leftEndX : to.x + to.width + GUTTER;
      const startX = interpolate(leftStartX, crossStartX);
      const endX = interpolate(leftEndX, crossEndX);
      const startY = from.y + Math.min(from.height / 2, 24);
      const endY = to.y + Math.min(to.height / 2, 24);
      const verticalDistance = endY - startY;
      const gutterX = Math.min(leftStartX, leftEndX);
      // 左端の列でも曲線を画面外へ膨らませず、細いハロー分の余白を残す。
      const bend = Math.min(18, Math.abs(verticalDistance) * 0.08, Math.max(0, gutterX - 2));
      const reach = Math.max(12, Math.min(96, Math.abs(crossEndX - crossStartX) * 0.45));
      const control1X = interpolate(gutterX - bend, crossStartX + direction * reach);
      const control2X = interpolate(gutterX - bend, crossEndX - direction * reach);
      const control1Y = interpolate(startY + verticalDistance * 0.28, startY);
      const control2Y = interpolate(endY - verticalDistance * 0.28, endY);
      const path: PushEffectPath = {
        sourceId: trace.sourceId, fromId: edge.fromId, toId: edge.toId,
        startX, startY, control1X, control1Y, control2X, control2Y, endX, endY,
        d: `M ${startX} ${startY} C ${control1X} ${control1Y} ${control2X} ${control2Y} ${endX} ${endY}`,
      };
      if (!viewport || !validBox(viewport) || !outsideViewport(path, viewport)) paths.push(path);
    }
  }
  return paths;
}

/** 開始時は短く現れ、その後は1400msまで穏やかに消える。時刻は呼び出し元が保持する。 */
export function pushEffectOpacity(ageMs: number): number {
  if (!Number.isFinite(ageMs) || ageMs <= 0 || ageMs >= PUSH_EFFECT_DURATION_MS) return 0;
  if (ageMs < PUSH_EFFECT_FADE_IN_MS) return ageMs / PUSH_EFFECT_FADE_IN_MS;
  return (PUSH_EFFECT_DURATION_MS - ageMs) / (PUSH_EFFECT_DURATION_MS - PUSH_EFFECT_FADE_IN_MS);
}

export type PushEffectContext = Pick<CanvasRenderingContext2D,
  'save' | 'restore' | 'beginPath' | 'moveTo' | 'bezierCurveTo' | 'stroke' |
  'strokeStyle' | 'globalAlpha' | 'lineWidth' | 'lineCap' | 'lineJoin' |
  'shadowBlur' | 'shadowColor' | 'filter'>;

/** カードより先に描く。SVGと同じ2本の線だけを使い、ぼかしやテキストは描かない。 */
export function drawPushPaths(
  ctx: PushEffectContext, paths: readonly PushEffectPath[], opacity: number,
): void {
  if (paths.length === 0 || !Number.isFinite(opacity) || opacity <= 0) return;
  const alpha = Math.min(1, opacity) * ctx.globalAlpha;
  ctx.save();
  try {
    ctx.strokeStyle = PUSH_EFFECT_STYLE.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    ctx.filter = 'none';
    ctx.beginPath();
    for (const path of paths) {
      ctx.moveTo(path.startX, path.startY);
      ctx.bezierCurveTo(path.control1X, path.control1Y, path.control2X, path.control2Y, path.endX, path.endY);
    }
    ctx.lineWidth = PUSH_EFFECT_STYLE.haloWidth;
    ctx.globalAlpha = alpha * PUSH_EFFECT_STYLE.haloAlpha;
    ctx.stroke();
    ctx.lineWidth = PUSH_EFFECT_STYLE.mainWidth;
    ctx.globalAlpha = alpha * PUSH_EFFECT_STYLE.mainAlpha;
    ctx.stroke();
  } finally {
    ctx.restore();
  }
}
