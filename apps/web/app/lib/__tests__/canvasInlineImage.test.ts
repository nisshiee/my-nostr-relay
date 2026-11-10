import { describe, expect, it } from 'vitest';
import { CANVAS_INLINE_MAX_BYTES, isAllowedCanvasInlineImage } from '../canvasInlineImage';
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
    'data:image/png;base64,YQ==\n', 'data:image/png;charset=utf-8;base64,YQ==',
  ])('rejects invalid input %s', source => expect(isAllowedCanvasInlineImage(source)).toBe(false));
  it('accepts exactly 2MiB but rejects one byte more', () => {
    expect(isAllowedCanvasInlineImage(`data:image/png;base64,${Buffer.alloc(CANVAS_INLINE_MAX_BYTES).toString('base64')}`)).toBe(true);
    expect(isAllowedCanvasInlineImage(`data:image/png;base64,${Buffer.alloc(CANVAS_INLINE_MAX_BYTES + 1).toString('base64')}`)).toBe(false);
  });
});
