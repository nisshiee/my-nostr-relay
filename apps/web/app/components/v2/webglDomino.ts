/** CSS pxの同次座標。GPUのclip座標変換とDOM hit geometryで同じ行列を使う。 */
export type Matrix4 = readonly number[];
export function multiply4(a: Matrix4, b: Matrix4): number[] {
  return Array.from({ length: 16 }, (_, n) => {
    const row = n % 4, column = Math.floor(n / 4);
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
    return sum;
  });
}
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const translation = (x: number, y: number) => { const m = identity(); m[12] = x; m[13] = y; return m; };
export function probeMatrix(x: number, y: number, width: number, amount: number): number[] {
  const theta = Math.max(0, Math.min(1, amount)) * 52 * Math.PI / 180;
  const rotation = identity(); rotation[5] = Math.cos(theta); rotation[6] = Math.sin(theta); rotation[9] = -Math.sin(theta); rotation[10] = Math.cos(theta);
  const perspective = identity(); perspective[11] = -1 / 1600;
  return multiply4(translation(x + width / 2, y + 60), multiply4(perspective, multiply4(rotation, translation(-width / 2, -60))));
}
export function projectPoint(matrix: Matrix4, x: number, y: number) {
  const w = matrix[3] * x + matrix[7] * y + matrix[15];
  return { x: (matrix[0] * x + matrix[4] * y + matrix[12]) / w, y: (matrix[1] * x + matrix[5] * y + matrix[13]) / w, w };
}
export function clipPoint(matrix: Matrix4, x: number, y: number, width: number, height: number) {
  const p = projectPoint(matrix, x, y);
  return { x: 2 * p.x / width - 1, y: 1 - 2 * p.y / height };
}
export function summarizeFrames(samples: readonly number[]) {
  const sorted = [...samples].filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] : 0;
  return { count: sorted.length, p50: percentile(.5), p95: percentile(.95), over33: sorted.filter(value => value > 33.4).length };
}
export function needsTextureUpload(dirty: boolean, hasTexture: boolean, changed: readonly Element[] | undefined, root: Element) {
  // changedElements未実装時は保守的に再取得し、誤って古い入力やcaretを表示しない。
  return dirty || !hasTexture || !changed || changed.some(element => element === root || root.contains(element));
}
export interface HtmlTextureGL extends WebGL2RenderingContext {
  texElementSubImage2D(target: number, level: number, x: number, y: number, element: Element): void;
}
export interface GeometryCanvas extends HTMLCanvasElement {
  requestPaint?: () => void;
  getElementImageDefaultSize?: (element: Element) => { width: number; height: number };
  updateElementGeometry?: (element: Element, options: { canvasTransform: DOMMatrix }) => void;
  clearElementGeometry?: (element: Element) => void;
}

/** 一枚の平面textureを投影する。CSS3Dは使わず、DOM geometryにも同じ行列を渡す。 */
export function createHtmlQuad(gl: HtmlTextureGL, surface: GeometryCanvas) {
  if (!gl.texElementSubImage2D || !surface.updateElementGeometry || !surface.clearElementGeometry || !surface.getElementImageDefaultSize) throw new Error('API unavailable');
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null, buffer: WebGLBuffer | null = null, texture: WebGLTexture | null = null;
  const dispose = () => { if (texture) gl.deleteTexture(texture); if (buffer) gl.deleteBuffer(buffer); if (program) gl.deleteProgram(program); shaders.forEach(shader => gl.deleteShader(shader)); };
  try {
    const compile = (kind: number, source: string) => {
      const shader = gl.createShader(kind); if (!shader) throw new Error('Shader unavailable'); shaders.push(shader);
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Shader failed');
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, `#version 300 es
      in vec2 position; uniform mat4 model; uniform vec2 viewSize; uniform vec2 cardSize; out vec2 uv;
      void main(){ uv=position; vec4 p=model*vec4(position*cardSize,0.0,1.0);
        gl_Position=vec4(2.0*p.x/viewSize.x-p.w,p.w-2.0*p.y/viewSize.y,0.0,p.w); }`);
    const fragment = compile(gl.FRAGMENT_SHADER, `#version 300 es
      precision mediump float; in vec2 uv; uniform sampler2D image; out vec4 color;
      void main(){ color=texture(image,uv); }`);
    program = gl.createProgram(); if (!program) throw new Error('Program unavailable');
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Program failed');
    buffer = gl.createBuffer(); texture = gl.createTexture(); if (!buffer || !texture) throw new Error('Resource unavailable');
    gl.useProgram(program); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const location = gl.getAttribLocation(program, 'position'); gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.disable(gl.DEPTH_TEST);
    gl.uniform1i(gl.getUniformLocation(program, 'image'), 0);
    const model = gl.getUniformLocation(program, 'model'), viewSize = gl.getUniformLocation(program, 'viewSize'), cardSize = gl.getUniformLocation(program, 'cardSize');
    let allocatedWidth = 0, allocatedHeight = 0;
    return {
      upload(root: Element) {
        const size = surface.getElementImageDefaultSize!(root);
        const width = Math.ceil(size.width), height = Math.ceil(size.height), max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
        if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > max || height > max || width * height > 16_777_216) throw new Error('Texture size unsupported');
        gl.bindTexture(gl.TEXTURE_2D, texture);
        if (width !== allocatedWidth || height !== allocatedHeight) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          allocatedWidth = width; allocatedHeight = height;
        }
        gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, root);
        if (gl.getError() !== gl.NO_ERROR) throw new Error('Texture upload failed');
      },
      draw(root: Element, matrix: Matrix4, width: number, height: number, viewWidth: number, viewHeight: number) {
        gl.viewport(0, 0, surface.width, surface.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(program); gl.uniformMatrix4fv(model, false, new Float32Array(matrix));
        gl.uniform2f(viewSize, viewWidth, viewHeight); gl.uniform2f(cardSize, width, height);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        surface.updateElementGeometry!(root, { canvasTransform: new DOMMatrix(Array.from(matrix)) });
      },
      dispose,
    };
  } catch (error) { dispose(); throw error; }
}
