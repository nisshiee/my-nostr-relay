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
  readonly color: string;
  readonly haloRadius: number;
  readonly haloAlpha: number;
  readonly haloColor: string;
  readonly kind: 'star' | 'dot';
  readonly d: string;
  readonly points: readonly { readonly x: number; readonly y: number }[];
}

export const PUSH_EFFECT_DURATION_MS = 2200;
export const PUSH_EFFECT_FADE_IN_MS = 80;
export const PUSH_EFFECT_FADE_OUT_START_MS = 900;
export const PUSH_EFFECT_MAX_TRACES = 4;
export const PUSH_EFFECT_MAX_EDGES = 96;
export const PUSH_EFFECT_MAX_PARTICLES = 240;
export const PUSH_EFFECT_MAX_HALOS = 24;
export const PUSH_EFFECT_STYLE = Object.freeze({
  dustColor: '#dba52c',
  warmDustColor: '#f4ca5b',
  brightDustColor: '#fff0b5',
  whiteColor: '#fffef4',
  starColor: '#f3cf63',
  haloColor: '#f9cb44',
});

function validBox(box: PushEffectBox | undefined): box is PushEffectBox {
  return box !== undefined && Number.isFinite(box.x) && Number.isFinite(box.y) &&
    Number.isFinite(box.width) && Number.isFinite(box.height) && box.width >= 0 && box.height >= 0;
}

/** 制御点の外接矩形でのみ除外し、画面を横切る曲線を端点だけで落とさない。 */
function outsideViewport(path: PushEffectPath, viewport: PushEffectBox): boolean {
  // 軌道から広がる砂と、少数の星の局所的な光も含めて判定する。
  const padding = 80;
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

function noise(seed: number, salt: number): number {
  let hash = seed ^ Math.imul(salt, 0x9e3779b9);
  hash = Math.imul(hash ^ (hash >>> 16), 0x21f0aaad);
  hash = Math.imul(hash ^ (hash >>> 15), 0x735a2d97);
  return ((hash ^ (hash >>> 15)) >>> 0) / 4294967296;
}

function curveNormal(path: PushEffectPath, progress: number): { x: number; y: number } {
  const remaining = 1 - progress;
  const dx = 3 * remaining ** 2 * (path.control1X - path.startX) +
    6 * remaining * progress * (path.control2X - path.control1X) +
    3 * progress ** 2 * (path.endX - path.control2X);
  const dy = 3 * remaining ** 2 * (path.control1Y - path.startY) +
    6 * remaining * progress * (path.control2Y - path.control1Y) +
    3 * progress ** 2 * (path.endY - path.control2Y);
  const distance = Math.hypot(dx, dy);
  return distance === 0 ? { x: 1, y: 0 } : { x: -dy / distance, y: dx / distance };
}

/**
 * 根と辺のID・経過時間だけで光点を決める。フレームごとの乱数・タイマー・履歴は使わない。
 * 曲線自体は描かず、周囲へ不規則に広がる金の砂を配置する。
 * 短い1辺でも密度を保ち、長い連鎖は最大24辺・240粒・24個の小さな光までに制限する。
 */
export function createPushParticles(paths: readonly PushEffectPath[], ageMs: number): readonly PushEffectParticle[] {
  if (!Number.isFinite(ageMs) || ageMs <= 0 || ageMs >= PUSH_EFFECT_DURATION_MS) return [];
  const pathCount = Math.min(paths.length, PUSH_EFFECT_MAX_EDGES);
  const selectedCount = Math.min(pathCount, 24);
  const particleCount = Math.min(PUSH_EFFECT_MAX_PARTICLES, 160 + pathCount * 16);
  const particles: PushEffectParticle[] = [];
  let haloCount = 0;
  for (let index = 0; index < selectedCount; index++) {
    const pathIndex = selectedCount === 1 ? 0 : Math.round(index * (pathCount - 1) / (selectedCount - 1));
    const path = paths[pathIndex];
    const edgeId = JSON.stringify([path.sourceId, path.fromId, path.toId]);
    const edgeParticleCount = Math.floor(particleCount / selectedCount) + (index < particleCount % selectedCount ? 1 : 0);
    for (let slot = 0; slot < edgeParticleCount; slot++) {
      const id = `${edgeId}:${slot}`;
      const seed = hashId(id);
      const cycleMs = 1500 + noise(seed, 1) * 700;
      const phase = noise(seed, 2);
      const progress = (ageMs / cycleMs + phase) % 1;
      const center = curvePoint(path, progress);
      const normal = curveNormal(path, progress);
      const spread = 18 + 40 * Math.sin(Math.PI * progress);
      const lateral = (noise(seed, 3) + noise(seed, 4) - 1) * spread + Math.sin(ageMs / 400 + phase * Math.PI * 2) * 3;
      const x = center.x + normal.x * lateral;
      const y = center.y + normal.y * lateral;
      const kind = seed % 37 === 0 || slot === 13 ? 'star' : 'dot';
      const baseRadius = kind === 'star' ? 4.4 + noise(seed, 5) * 4.6
        : seed % 13 === 0 ? 2 + noise(seed, 5) * 1.3 : 0.55 + noise(seed, 5) * 1.1;
      const radius = baseRadius * (0.9 + 0.1 * Math.sin(ageMs / 190 + phase * Math.PI * 2));
      const rotation = phase * Math.PI * 2 + ageMs / 1500;
      const twinkle = 0.55 + 0.45 * Math.sin(ageMs / 170 + phase * Math.PI * 2) ** 2;
      const alpha = Math.sin(Math.PI * progress) ** 0.4 * twinkle * (kind === 'star' ? 1 : 0.34 + noise(seed, 6) * 0.66);
      const shade = noise(seed, 7);
      const color = kind === 'star' ? shade < 0.3 ? PUSH_EFFECT_STYLE.whiteColor : PUSH_EFFECT_STYLE.starColor
        : shade < 0.12 ? PUSH_EFFECT_STYLE.whiteColor : shade < 0.35 ? PUSH_EFFECT_STYLE.brightDustColor
          : shade < 0.65 ? PUSH_EFFECT_STYLE.warmDustColor : PUSH_EFFECT_STYLE.dustColor;
      const halo = haloCount < PUSH_EFFECT_MAX_HALOS && (kind === 'star' || seed % 47 === 0);
      if (halo) haloCount++;
      const haloRadius = halo ? radius * (kind === 'star' ? 1.8 : 2.6) : 0;
      const haloAlpha = halo ? alpha * (kind === 'star' ? 0.2 : 0.16) : 0;
      const rayCount = seed % 2 === 0 ? 4 : 8;
      const points = kind === 'star' ? Array.from({ length: rayCount * 2 }, (_, pointIndex) => {
        const angle = rotation + pointIndex * Math.PI / rayCount;
        const reach = pointIndex % 2 === 1 ? radius * 0.16
          : rayCount === 8 && pointIndex % 4 !== 0 ? radius * 0.6 : radius;
        return { x: x + Math.cos(angle) * reach, y: y + Math.sin(angle) * reach };
      }) : [];
      const d = kind === 'star'
        ? `${points.map((point, pointIndex) => `${pointIndex === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')} Z`
        : `M ${x + radius} ${y} A ${radius} ${radius} 0 1 0 ${x - radius} ${y} A ${radius} ${radius} 0 1 0 ${x + radius} ${y} Z`;
      particles.push({ id, x, y, radius, rotation, alpha, color, haloRadius, haloAlpha,
        haloColor: PUSH_EFFECT_STYLE.haloColor, kind, d, points });
    }
  }
  return particles;
}

export type PushEffectContext = Pick<CanvasRenderingContext2D,
  'save' | 'restore' | 'beginPath' | 'moveTo' | 'lineTo' | 'closePath' | 'arc' | 'fill' |
  'fillStyle' | 'globalAlpha' |
  'shadowBlur' | 'shadowColor' | 'filter'>;

/** カード前面へ独立した砂と星だけを描く。連続した線・輪郭線・ぼかしは一切描かない。 */
export function drawPushPaths(
  ctx: PushEffectContext, paths: readonly PushEffectPath[], opacity: number, ageMs: number,
): void {
  if (paths.length === 0 || !Number.isFinite(opacity) || opacity <= 0 ||
    !Number.isFinite(ageMs) || ageMs <= 0 || ageMs >= PUSH_EFFECT_DURATION_MS) return;
  const alpha = Math.min(1, opacity) * ctx.globalAlpha;
  ctx.save();
  try {
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    ctx.filter = 'none';
    for (const particle of createPushParticles(paths, ageMs)) {
      if (particle.haloRadius > 0) {
        ctx.globalAlpha = alpha * particle.haloAlpha;
        ctx.fillStyle = particle.haloColor;
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.haloRadius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = alpha * particle.alpha;
      ctx.fillStyle = particle.color;
      ctx.beginPath();
      if (particle.kind === 'dot') {
        ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
      } else {
        ctx.moveTo(particle.points[0].x, particle.points[0].y);
        for (let index = 1; index < particle.points.length; index++) ctx.lineTo(particle.points[index].x, particle.points[index].y);
        ctx.closePath();
      }
      ctx.fill();
    }
  } finally {
    ctx.restore();
  }
}
