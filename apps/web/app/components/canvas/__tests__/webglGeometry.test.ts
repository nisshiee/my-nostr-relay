import { describe, expect, it } from 'vitest';
import { multiply4, projectPoint } from '../webglGeometry';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe('描画とhit判定に共有する同次座標', () => {
  it('単位行列と平行移動はCSS pxのまま保持する', () => {
    const translation = [...identity]; translation[12] = 40; translation[13] = 90;
    expect(multiply4(identity, translation)).toEqual(translation);
    expect(multiply4(translation, identity)).toEqual(translation);
    expect(projectPoint(translation, 23, 45)).toEqual({ x: 63, y: 135, w: 1 });
  });
  it('行列積は右側から適用し、透視除算は最後に一度だけ行う', () => {
    const translation = [...identity]; translation[12] = 40; translation[13] = 90;
    const projection = [...identity]; projection[7] = 0.001;
    const result = projectPoint(multiply4(translation, projection), 20, 100);
    expect(result.w).toBeCloseTo(1.1);
    expect(result.x).toBeCloseTo(20 / 1.1 + 40);
    expect(result.y).toBeCloseTo(100 / 1.1 + 90);
  });
});
