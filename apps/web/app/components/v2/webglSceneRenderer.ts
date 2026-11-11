import type { SceneBox, Camera } from './scene';
import { RIPPLE_EFFECT_MAX_DISPLACEMENT_PX, type RippleEffect } from './rippleEffect';
import type { DominoTransform } from './dominoEffect';
import type { PushEffectParticle } from './pushEffect';
import { PUSH_EFFECT_MAX_PARTICLES } from './pushEffect';
import { multiply4, projectPoint, type Matrix4, type GeometryCanvas, type HtmlTextureGL } from './webglDomino';

export interface WebGLSceneCard { id: string; node: HTMLElement; box: SceneBox; tip?: DominoTransform; ripple?: RippleEffect }
export interface WebGLSceneFrame {
  cards: readonly WebGLSceneCard[]; camera: Camera; viewportWidth: number; viewportHeight: number;
  changedElements?: readonly Element[]; dirtyIds?: ReadonlySet<string>; pinnedIds?: ReadonlySet<string>;
  particles?: readonly PushEffectParticle[]; particleOpacity?: number;
}
export interface WebGLSceneStats { draws: number; uploads: number; textureBytes: number; textureCount: number; geometryUpdates: number; drawnIds: string[] }
export const WEBGL_TEXTURE_BUDGET = 128 * 1024 * 1024;
export const WEBGL_SINGLE_TEXTURE_LIMIT = 32 * 1024 * 1024;
/** 外部のGLログや任意例外文をDOM診断へ露出させない固定分類。 */
export function classifyWebGLSceneError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  const codes: Record<string, string> = {
    'HTML texture API unavailable': 'api-unavailable',
    'Program unavailable': 'program-allocation', 'Shader unavailable': 'shader-allocation',
    'Vertex shader failed': 'vertex-compile', 'Fragment shader failed': 'fragment-compile',
    'Program failed': 'program-link', 'Buffer unavailable': 'buffer-allocation',
    'Renderer unavailable': 'renderer-unavailable', 'Invalid frame': 'invalid-frame',
    'Texture size limit': 'texture-size', 'Texture budget limit': 'texture-budget',
    'Texture unavailable': 'texture-allocation', 'Texture upload failed': 'texture-upload',
    'Scene draw failed': 'scene-draw',
  };
  return Object.hasOwn(codes, error.message) ? codes[error.message] : 'unknown';
}
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const translate = (x: number, y: number) => { const m = identity(); m[12] = x; m[13] = y; return m; };
/** CSS pxの同じ射影をGPUとDOM hit geometryへ渡す。DPRはここへ混ぜない。 */
export function sceneCardMatrix(box: SceneBox, camera: Camera, tip?: DominoTransform): number[] {
  let local = identity();
  if (tip) {
    const p = tip.perspective, angle = p.angleDeg * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
    const rotate = identity();
    if (p.axis === 'x') { rotate[5] = c; rotate[6] = s; rotate[9] = -s; rotate[10] = c; }
    else { rotate[0] = c; rotate[2] = -s; rotate[8] = s; rotate[10] = c; }
    const perspective = identity(); perspective[11] = -1 / p.perspectivePx;
    local = multiply4(translate(p.pivotX, p.pivotY), multiply4(perspective, multiply4(rotate, translate(-p.pivotX, -p.pivotY))));
  }
  const cameraMatrix = identity(); cameraMatrix[0] = camera.zoom; cameraMatrix[5] = camera.zoom;
  cameraMatrix[12] = camera.x; cameraMatrix[13] = camera.y;
  return multiply4(cameraMatrix, multiply4(translate(box.x, box.y), local));
}
export function sceneCardVisible(matrix: Matrix4, box: SceneBox, width: number, height: number): boolean {
  const points = [[0, 0], [box.width, 0], [0, box.height], [box.width, box.height]].map(([x, y]) => projectPoint(matrix, x, y));
  return points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && p.w > 0) &&
    Math.max(...points.map(p => p.x)) >= -64 && Math.min(...points.map(p => p.x)) <= width + 64 &&
    Math.max(...points.map(p => p.y)) >= -64 && Math.min(...points.map(p => p.y)) <= height + 64;
}
function rgb(hex: string): number[] { return /^#[0-9a-f]{6}$/i.test(hex) ? [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) : [1, 1, 1]; }
/** 粒は独立した三角形へ展開し、連続線や毎frameの画像uploadを使わない。 */
export function particleVertices(particles: readonly PushEffectParticle[], opacity: number, camera: Camera): Float32Array {
  const out: number[] = [], alpha = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 0; let halos = 0;
  const polygon = (points: readonly { x: number; y: number }[], color: string, a: number) => {
    if (a <= 0 || points.length < 3) return;
    const colors = rgb(color), center = points.reduce((p, q) => ({ x: p.x + q.x / points.length, y: p.y + q.y / points.length }), { x: 0, y: 0 });
    for (let i = 0; i < points.length; i++) for (const p of [center, points[i], points[(i + 1) % points.length]]) out.push(p.x * camera.zoom + camera.x, p.y * camera.zoom + camera.y, colors[0] * a, colors[1] * a, colors[2] * a, a);
  };
  const circle = (x: number, y: number, radius: number) => Array.from({ length: 16 }, (_, i) => ({ x: x + Math.cos(i * Math.PI / 8) * radius, y: y + Math.sin(i * Math.PI / 8) * radius }));
  for (const p of particles.slice(0, PUSH_EFFECT_MAX_PARTICLES)) {
    if (p.haloAlpha > 0 && halos++ < 24) polygon(circle(p.x, p.y, p.haloRadius), p.haloColor, alpha * p.haloAlpha);
    polygon(p.kind === 'dot' ? circle(p.x, p.y, p.radius) : p.points, p.color, alpha * p.alpha);
    polygon(p.kind === 'dot' ? circle(p.x, p.y, p.coreRadius) : p.corePoints, p.coreColor, alpha * p.coreAlpha);
  }
  return new Float32Array(out);
}

interface Entry { node: HTMLElement; texture: WebGLTexture; width: number; height: number; bytes: number; used: number; dirty: boolean }
/** 可視textureだけを有界に保持する。renderはpaint callback内で呼ぶ。 */
export function createWebGLSceneRenderer(gl: HtmlTextureGL, surface: GeometryCanvas, limits: { totalBytes?: number; singleBytes?: number } = {}) {
  if (!gl.texElementSubImage2D || !surface.updateElementGeometry || !surface.clearElementGeometry || !surface.getElementImageDefaultSize) throw new Error('HTML texture API unavailable');
  const budget = Math.min(WEBGL_TEXTURE_BUDGET, limits.totalBytes ?? WEBGL_TEXTURE_BUDGET), single = Math.min(WEBGL_SINGLE_TEXTURE_LIMIT, limits.singleBytes ?? WEBGL_SINGLE_TEXTURE_LIMIT);
  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  const entries = new Map<string, Entry>(), geometry = new Map<string, HTMLElement>();
  const shaders: WebGLShader[] = [], programs: WebGLProgram[] = [], buffers: WebGLBuffer[] = [];
  let bytes = 0, tick = 0, disposed = false;
  const drop = (id: string) => { const e = entries.get(id); if (e) { gl.deleteTexture(e.texture); bytes -= e.bytes; entries.delete(id); } };
  const dispose = () => {
    if (disposed) return; disposed = true;
    for (const node of geometry.values()) { try { surface.clearElementGeometry!(node); } catch { /* context消失後も残りを解放する。 */ } }
    geometry.clear(); for (const id of entries.keys()) drop(id);
    buffers.forEach(b => gl.deleteBuffer(b)); programs.forEach(p => gl.deleteProgram(p)); shaders.forEach(s => gl.deleteShader(s));
  };
  try {
    const program = (vertex: string, fragment: string) => {
      const p = gl.createProgram(); if (!p) throw new Error('Program unavailable'); programs.push(p);
      for (const [kind, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
        const s = gl.createShader(kind); if (!s) throw new Error('Shader unavailable'); shaders.push(s); gl.shaderSource(s, source); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(kind === gl.VERTEX_SHADER ? 'Vertex shader failed' : 'Fragment shader failed'); gl.attachShader(p, s);
      }
      gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program failed'); return p;
    };
    const cardProgram = program(`#version 300 es
      precision highp float; precision highp int;
      in vec2 position; uniform mat4 model; uniform vec2 viewSize; uniform vec2 cardSize; out vec2 uv;
      void main(){uv=position;vec4 p=model*vec4(position*cardSize,0.,1.);gl_Position=vec4(2.*p.x/viewSize.x-p.w,p.w-2.*p.y/viewSize.y,0.,p.w);}`,
    `#version 300 es
      precision highp float; precision highp int;in vec2 uv;uniform sampler2D image;uniform float amount;uniform int edge;uniform bool footprint;uniform vec2 cardSize;uniform vec2 rippleDirection;uniform float rippleProgress;uniform float rippleAmount;out vec4 color;
      void main(){float t=edge==0?1.-uv.y:edge==1?uv.x:edge==2?uv.y:1.-uv.x;
      if(footprint){float r=min(12.,min(cardSize.x,cardSize.y)*.5);vec2 q=abs(uv*cardSize-cardSize*.5)-(cardSize*.5-vec2(r));float d=length(max(q,0.))+min(max(q.x,q.y),0.)-r;float a=mix(.08,.7,t)*amount*.22*(1.-smoothstep(-1.,1.,d));color=vec4(vec3(15.,23.,42.)/255.*a,a);}
      else{vec2 sampleUV=uv;float light=0.;
      if(rippleAmount>0.){float span=max(abs(rippleDirection.x)+abs(rippleDirection.y),.001);float along=dot(uv-.5,rippleDirection)/span+.5;
      float distanceToWave=along-mix(-.15,1.15,rippleProgress);float band=exp(-distanceToWave*distanceToWave/0.012);
      float border=smoothstep(0.,.08,uv.x)*smoothstep(0.,.08,uv.y)*smoothstep(0.,.08,1.-uv.x)*smoothstep(0.,.08,1.-uv.y);
      float wave=sin(distanceToWave*32.)*band*border*rippleAmount;
      sampleUV=clamp(uv+rippleDirection*wave*${RIPPLE_EFFECT_MAX_DISPLACEMENT_PX.toFixed(1)}/max(cardSize,vec2(1.)),vec2(0.),vec2(1.));light=band*border*rippleAmount*.12;}
      vec4 c=texture(image,sampleUV);c.rgb=mix(c.rgb,vec3(.72,.91,1.)*c.a,light);float a=mix(.48,.06,t)*amount*.3;color=vec4(c.rgb*(1.-a)+vec3(15.,23.,42.)/255.*a*c.a,c.a);}}`);
    const particleProgram = program(`#version 300 es
      precision highp float; precision highp int;
      in vec2 position;in vec4 tint;uniform vec2 viewSize;out vec4 color;
      void main(){gl_Position=vec4(2.*position.x/viewSize.x-1.,1.-2.*position.y/viewSize.y,0.,1.);color=tint;}`,
    `#version 300 es
      precision highp float; precision highp int;in vec4 color;out vec4 result;void main(){result=color;}`);
    const quad = gl.createBuffer(); if (!quad) throw new Error('Buffer unavailable'); buffers.push(quad);
    const particleBuffer = gl.createBuffer(); if (!particleBuffer) throw new Error('Buffer unavailable'); buffers.push(particleBuffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const cardPosition = gl.getAttribLocation(cardProgram, 'position'), particlePosition = gl.getAttribLocation(particleProgram, 'position'), particleTint = gl.getAttribLocation(particleProgram, 'tint');
    const location = (p: WebGLProgram, name: string) => gl.getUniformLocation(p, name);
    const model = location(cardProgram, 'model'), viewSize = location(cardProgram, 'viewSize'), cardSize = location(cardProgram, 'cardSize'), amount = location(cardProgram, 'amount'), edge = location(cardProgram, 'edge'), footprint = location(cardProgram, 'footprint');
    const rippleDirection = location(cardProgram, 'rippleDirection'), rippleProgress = location(cardProgram, 'rippleProgress'), rippleAmount = location(cardProgram, 'rippleAmount');
    const imageLocation = location(cardProgram, 'image'), particleViewSize = location(particleProgram, 'viewSize');
    const bindCard = (frame: WebGLSceneFrame) => { gl.useProgram(cardProgram); gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.enableVertexAttribArray(cardPosition); gl.vertexAttribPointer(cardPosition, 2, gl.FLOAT, false, 0, 0); gl.uniform2f(viewSize, frame.viewportWidth, frame.viewportHeight); gl.uniform1i(imageLocation, 0); };
    return {
      render(frame: WebGLSceneFrame): WebGLSceneStats {
        try {
        if (disposed || gl.isContextLost()) throw new Error('Renderer unavailable');
        if (![budget, single, frame.viewportWidth, frame.viewportHeight, frame.camera.zoom].every(v => Number.isFinite(v) && v > 0) || ![frame.camera.x, frame.camera.y].every(Number.isFinite)) throw new Error('Invalid frame');
        tick++; let uploads = 0, draws = 0, geometryUpdates = 0; const drawnIds: string[] = [];
        const live = new Map(frame.cards.map(card => [card.id, card.node]));
        for (const [id, node] of geometry) if (live.get(id) !== node) { surface.clearElementGeometry!(node); geometry.delete(id); drop(id); }
        for (const [id, entry] of entries) if (live.get(id) !== entry.node) drop(id);
        const plans = frame.cards.map(card => ({ card, matrix: sceneCardMatrix(card.box, frame.camera, card.tip) }));
        const visible = new Set(plans.filter(p => sceneCardVisible(p.matrix, p.card.box, frame.viewportWidth, frame.viewportHeight)).map(p => p.card.id));
        for (const [id, entry] of entries) if (frame.dirtyIds?.has(id) || !frame.changedElements || frame.changedElements.some(node => node === entry.node || entry.node.contains(node))) entry.dirty = true;
        gl.viewport(0, 0, surface.width, surface.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.disable(gl.DEPTH_TEST);
        gl.activeTexture(gl.TEXTURE0); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true); bindCard(frame);
        for (const { card, matrix } of plans) {
          if (visible.has(card.id)) {
            const size = surface.getElementImageDefaultSize!(card.node), w = Math.ceil(size.width), h = Math.ceil(size.height), cost = w * h * 4;
            if (![w, h, cost].every(Number.isFinite) || w < 1 || h < 1 || w > maxTextureSize || h > maxTextureSize || cost > single || cost > budget) throw new Error('Texture size limit');
            let entry = entries.get(card.id);
            if (entry && (entry.width !== w || entry.height !== h || entry.node !== card.node)) { drop(card.id); entry = undefined; }
            if (!entry) {
              for (const [id] of [...entries].filter(([id]) => !visible.has(id) && !frame.pinnedIds?.has(id)).sort((a, b) => a[1].used - b[1].used)) { if (bytes + cost <= budget) break; drop(id); }
              if (bytes + cost > budget) throw new Error('Texture budget limit');
              const texture = gl.createTexture(); if (!texture) throw new Error('Texture unavailable');
              entry = { node: card.node, texture, width: w, height: h, bytes: cost, used: tick, dirty: true }; entries.set(card.id, entry); bytes += cost;
              gl.bindTexture(gl.TEXTURE_2D, texture); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
              gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            }
            entry.used = tick; gl.bindTexture(gl.TEXTURE_2D, entry.texture);
            if (entry.dirty) { gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, card.node); if (gl.getError() !== gl.NO_ERROR) throw new Error('Texture upload failed'); entry.dirty = false; uploads++; }
            gl.uniform2f(rippleDirection, card.ripple?.directionX ?? 0, card.ripple?.directionY ?? 1);
            gl.uniform1f(rippleProgress, card.ripple?.progress ?? 0); gl.uniform1f(rippleAmount, card.ripple?.amount ?? 0);
            gl.uniform2f(cardSize, card.box.width, card.box.height); gl.uniform1f(amount, card.tip?.amount ?? 0);
            gl.uniform1i(edge, card.tip ? ['top', 'right', 'bottom', 'left'].indexOf(card.tip.perspective.edge) : 0);
            if (card.tip) { gl.uniform1i(footprint, 1); gl.uniformMatrix4fv(model, false, new Float32Array(sceneCardMatrix(card.box, frame.camera))); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); draws++; }
            gl.uniform1i(footprint, 0); gl.uniformMatrix4fv(model, false, new Float32Array(matrix)); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); draws++; drawnIds.push(card.id);
          }
          // 画面外も正しい座標を持たせ、keyboard focusによる再表示を妨げない。
          surface.updateElementGeometry!(card.node, { canvasTransform: new DOMMatrix(matrix) }); geometry.set(card.id, card.node); geometryUpdates++;
        }
        const vertices = particleVertices(frame.particles ?? [], frame.particleOpacity ?? 0, frame.camera);
        if (vertices.length) {
          gl.useProgram(particleProgram); gl.bindBuffer(gl.ARRAY_BUFFER, particleBuffer); gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
          gl.enableVertexAttribArray(particlePosition); gl.vertexAttribPointer(particlePosition, 2, gl.FLOAT, false, 24, 0); gl.enableVertexAttribArray(particleTint); gl.vertexAttribPointer(particleTint, 4, gl.FLOAT, false, 24, 8);
          gl.uniform2f(particleViewSize, frame.viewportWidth, frame.viewportHeight); gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 6); draws++;
          gl.disableVertexAttribArray(particleTint);
        }
        if (gl.getError() !== gl.NO_ERROR) throw new Error('Scene draw failed');
        return { draws, uploads, textureBytes: bytes, textureCount: entries.size, geometryUpdates, drawnIds };
        } catch (error) {
          for (const node of geometry.values()) { try { surface.clearElementGeometry!(node); } catch { /* 退避処理を続ける。 */ } }
          geometry.clear(); throw error;
        }
      }, dispose,
    };
  } catch (error) { dispose(); throw error; }
}
