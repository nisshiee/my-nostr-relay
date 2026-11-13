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
export function projectPoint(matrix: Matrix4, x: number, y: number) {
  const w = matrix[3] * x + matrix[7] * y + matrix[15];
  return { x: (matrix[0] * x + matrix[4] * y + matrix[12]) / w, y: (matrix[1] * x + matrix[5] * y + matrix[13]) / w, w };
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
