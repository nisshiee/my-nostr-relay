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

export interface PushEffectParticle {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly rotation: number;
  readonly alpha: number;
  readonly kind: 'star' | 'dot';
  readonly d: string;
  readonly points: readonly { readonly x: number; readonly y: number }[];
}

export const PUSH_EFFECT_DURATION_MS = 2200;
export const PUSH_EFFECT_FADE_IN_MS = 80;
export const PUSH_EFFECT_FADE_OUT_START_MS = 900;
export const PUSH_EFFECT_MAX_TRACES = 4;
export const PUSH_EFFECT_MAX_EDGES = 96;
export const PUSH_EFFECT_MAX_PARTICLES = 48;
export const PUSH_EFFECT_STYLE = Object.freeze({
  outerColor: '#7c3aed',
  outerWidth: 18,
  outerAlpha: 0.22,
  haloColor: '#f472b6',
  haloWidth: 10,
  haloAlpha: 0.6,
  color: '#f0abfc',
  mainWidth: 5,
  mainAlpha: 0.95,
  coreColor: '#fff7d6',
  coreWidth: 1.8,
  coreAlpha: 1,
  particleColor: '#fff8c5',
  particleOutlineColor: '#d946ef',
  particleOutlineWidth: 1.1,
});

function validBox(box: PushEffectBox | undefined): box is PushEffectBox {
  return box !== undefined && Number.isFinite(box.x) && Number.isFinite(box.y) &&
    Number.isFinite(box.width) && Number.isFinite(box.height) && box.width >= 0 && box.height >= 0;
}

/** 制御点の外接矩形でのみ除外し、画面を横切る曲線を端点だけで落とさない。 */
function outsideViewport(path: PushEffectPath, viewport: PushEffectBox): boolean {
  const padding = Math.max(PUSH_EFFECT_STYLE.outerWidth / 2, 12);
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

      const startX = from.x + from.width / 2;
      const endX = to.x + to.width / 2;
      const startY = from.y + from.height / 2;
      const endY = to.y + to.height / 2;
      const horizontalDistance = endX - startX;
      const verticalDistance = endY - startY;
      const distance = Math.hypot(horizontalDistance, verticalDistance);
      // 中央同士をなめらかなS字で結ぶ。縦横の切替でも制御点を飛ばさない。
      const bend = distance === 0 ? 0 : Math.min(0.22, 88 / distance);
      const control1X = startX + horizontalDistance / 3 - verticalDistance * bend;
      const control2X = endX - horizontalDistance / 3 + verticalDistance * bend;
      const control1Y = startY + verticalDistance / 3 + horizontalDistance * bend;
      const control2Y = endY - verticalDistance / 3 - horizontalDistance * bend;
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

/** 80msで現れ、杖の軌跡が見える間は明るさを保ち、2200msまでに消える。 */
export function pushEffectOpacity(ageMs: number): number {
  if (!Number.isFinite(ageMs) || ageMs <= 0 || ageMs >= PUSH_EFFECT_DURATION_MS) return 0;
  if (ageMs < PUSH_EFFECT_FADE_IN_MS) return ageMs / PUSH_EFFECT_FADE_IN_MS;
  if (ageMs <= PUSH_EFFECT_FADE_OUT_START_MS) return 1;
  const progress = (ageMs - PUSH_EFFECT_FADE_OUT_START_MS) / (PUSH_EFFECT_DURATION_MS - PUSH_EFFECT_FADE_OUT_START_MS);
  return 1 - progress * progress * (3 - 2 * progress);
}

function hashId(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function curvePoint(path: PushEffectPath, progress: number): { x: number; y: number } {
  const remaining = 1 - progress;
  const start = remaining ** 3;
  const first = 3 * remaining ** 2 * progress;
  const second = 3 * remaining * progress ** 2;
  const end = progress ** 3;
  return {
    x: start * path.startX + first * path.control1X + second * path.control2X + end * path.endX,
    y: start * path.startY + first * path.control1Y + second * path.control2Y + end * path.endY,
  };
}

/**
 * 根と辺のID・経過時間だけで光点を決める。フレームごとの乱数・タイマー・履歴は使わない。
 * 長い連鎖も最大16辺を均等に選び、星2個と光点1個ずつの合計48個までに制限する。
 */
export function createPushParticles(paths: readonly PushEffectPath[], ageMs: number): readonly PushEffectParticle[] {
  if (!Number.isFinite(ageMs) || ageMs <= 0 || ageMs >= PUSH_EFFECT_DURATION_MS) return [];
  const pathCount = Math.min(paths.length, PUSH_EFFECT_MAX_EDGES);
  const selectedCount = Math.min(pathCount, PUSH_EFFECT_MAX_PARTICLES / 3);
  const particles: PushEffectParticle[] = [];
  for (let index = 0; index < selectedCount; index++) {
    const pathIndex = selectedCount === 1 ? 0 : Math.round(index * (pathCount - 1) / (selectedCount - 1));
    const path = paths[pathIndex];
    const edgeId = JSON.stringify([path.sourceId, path.fromId, path.toId]);
    const seed = hashId(edgeId);
    const cycleMs = 1100 + seed % 350;
    const phase = (seed >>> 8) % 1000 / 1000;
    for (let slot = 0; slot < 3; slot++) {
      const progress = ((ageMs / cycleMs + phase - slot * 0.12) % 1 + 1) % 1;
      const { x, y } = curvePoint(path, progress);
      const kind = slot === 2 ? 'dot' : 'star';
      const baseRadius = slot === 0 ? 8.5 + seed % 3 : slot === 1 ? 4.5 + seed % 2 : 2.5;
      const radius = baseRadius * (0.9 + 0.1 * Math.sin(ageMs / 160 + seed % 31 + slot));
      const rotation = (seed % 360) * Math.PI / 180 + ageMs / 700 + slot;
      const alpha = Math.sin(Math.PI * progress) * (slot === 0 ? 1 : 0.85);
      const points = kind === 'star' ? Array.from({ length: 8 }, (_, pointIndex) => {
        const angle = rotation + pointIndex * Math.PI / 4;
        const reach = pointIndex % 2 === 0 ? radius : radius * 0.27;
        return { x: x + Math.cos(angle) * reach, y: y + Math.sin(angle) * reach };
      }) : [];
      const d = kind === 'star'
        ? `${points.map((point, pointIndex) => `${pointIndex === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')} Z`
        : `M ${x + radius} ${y} A ${radius} ${radius} 0 1 0 ${x - radius} ${y} A ${radius} ${radius} 0 1 0 ${x + radius} ${y} Z`;
      particles.push({ id: `${edgeId}:${slot}`, x, y, radius, rotation, alpha, kind, d, points });
    }
  }
  return particles;
}

export type PushEffectContext = Pick<CanvasRenderingContext2D,
  'save' | 'restore' | 'beginPath' | 'moveTo' | 'lineTo' | 'closePath' | 'arc' | 'bezierCurveTo' | 'stroke' | 'fill' |
  'strokeStyle' | 'fillStyle' | 'globalAlpha' | 'lineWidth' | 'lineCap' | 'lineJoin' |
  'shadowBlur' | 'shadowColor' | 'filter'>;

/** カードの前面に描く。SVGと同じ重ね線と星だけを使い、ぼかしやテキストは描かない。 */
export function drawPushPaths(
  ctx: PushEffectContext, paths: readonly PushEffectPath[], opacity: number, ageMs: number,
): void {
  if (paths.length === 0 || !Number.isFinite(opacity) || opacity <= 0 ||
    !Number.isFinite(ageMs) || ageMs <= 0 || ageMs >= PUSH_EFFECT_DURATION_MS) return;
  const alpha = Math.min(1, opacity) * ctx.globalAlpha;
  ctx.save();
  try {
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
    const layers = [
      [PUSH_EFFECT_STYLE.outerColor, PUSH_EFFECT_STYLE.outerWidth, PUSH_EFFECT_STYLE.outerAlpha],
      [PUSH_EFFECT_STYLE.haloColor, PUSH_EFFECT_STYLE.haloWidth, PUSH_EFFECT_STYLE.haloAlpha],
      [PUSH_EFFECT_STYLE.color, PUSH_EFFECT_STYLE.mainWidth, PUSH_EFFECT_STYLE.mainAlpha],
      [PUSH_EFFECT_STYLE.coreColor, PUSH_EFFECT_STYLE.coreWidth, PUSH_EFFECT_STYLE.coreAlpha],
    ] as const;
    for (const [color, width, layerAlpha] of layers) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.globalAlpha = alpha * layerAlpha;
      ctx.stroke();
    }
    ctx.fillStyle = PUSH_EFFECT_STYLE.particleColor;
    ctx.strokeStyle = PUSH_EFFECT_STYLE.particleOutlineColor;
    ctx.lineWidth = PUSH_EFFECT_STYLE.particleOutlineWidth;
    for (const particle of createPushParticles(paths, ageMs)) {
      ctx.globalAlpha = alpha * particle.alpha;
      ctx.beginPath();
      if (particle.kind === 'dot') {
        ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
      } else {
        ctx.moveTo(particle.points[0].x, particle.points[0].y);
        for (let index = 1; index < particle.points.length; index++) ctx.lineTo(particle.points[index].x, particle.points[index].y);
        ctx.closePath();
      }
      ctx.fill();
      ctx.stroke();
    }
  } finally {
    ctx.restore();
  }
}
