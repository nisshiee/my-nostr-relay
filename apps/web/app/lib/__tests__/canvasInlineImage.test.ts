import { describe, expect, it } from 'vitest';
import { CANVAS_INLINE_MAX_BYTES, isAllowedCanvasInlineImage, normalizeCanvasInlineImage } from '../canvasInlineImage';
import { validateCanvasImageSource } from '../canvasImagePolicy';

describe('inline raster client validation', () => {
  it.each(['jpeg', 'png', 'webp', 'avif'])('accepts canonical %s base64', type => {
    const source = `data:image/${type};base64,aGVsbG8=`;
    expect(isAllowedCanvasInlineImage(source)).toBe(true);
    expect(validateCanvasImageSource(source)).toEqual({ allowed: true, url: source, inline: true, local: false });
  });
  it.each([
    'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/gif;base64,R0lGODlh',
    'data:image/png,abc', 'data:image/png;base64,', 'data:image/png;base64,abc',
    'data:image/png;base64,YQ===', 'data:image/png;base64,Y=Q=',
    'data:image/png;base64,YR==', 'data:image/png;base64,YWJ=',
    'data:image/png;base64,YQ==\u00a0', 'data:image/png;base64,YQ==\u200b',
    'data:image/png;base64,YQ==\v', 'data:image/png;base64,YQ%3D%3D',
    'data:image/png;base64,_w==', 'data:image/png;charset=utf-8;base64,YQ==',
  ])('rejects invalid input %s', source => expect(isAllowedCanvasInlineImage(source)).toBe(false));
  it.each([' ', '\t', '\n', '\f', '\r'])('normalizes only ASCII payload whitespace %j', space => {
    const raw = `data:image/png;base64,${space}aG${space}VsbG8=${space}`;
    const canonical = 'data:image/png;base64,aGVsbG8=';
    expect(normalizeCanvasInlineImage(raw)).toBe(canonical);
    expect(validateCanvasImageSource(raw)).toEqual({ allowed: true, url: canonical, inline: true, local: false });
    expect(normalizeCanvasInlineImage(`data:image/png;${space}base64,aGVsbG8=`)).toBeNull();
  });
  it('applies the raw length cap before whitespace normalization', () => {
    expect(normalizeCanvasInlineImage(`data:image/png;base64,${' '.repeat(Math.ceil(CANVAS_INLINE_MAX_BYTES / 3) * 4 + 32)}YQ==`)).toBeNull();
  });
  it('accepts exactly 2MiB but rejects one byte more', () => {
    expect(isAllowedCanvasInlineImage(`data:image/png;base64,${Buffer.alloc(CANVAS_INLINE_MAX_BYTES).toString('base64')}`)).toBe(true);
    expect(isAllowedCanvasInlineImage(`data:image/png;base64,${Buffer.alloc(CANVAS_INLINE_MAX_BYTES + 1).toString('base64')}`)).toBe(false);
  });
});
