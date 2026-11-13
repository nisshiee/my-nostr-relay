import { describe, expect, it } from 'vitest';
import { canvasImageWidth, validateCanvasImageSource } from '../canvasImagePolicy';
import config from '../../../next.config';

describe('Canvasの公開画像許可範囲', () => {
  it.each(['i.gyazo.com', 'images.example.org', 'another.example.net'])('%sをHTTPS/queryなしで受付する（IP検査はserver）', host => {
    expect(validateCanvasImageSource(`https://${host}/avatar.png`)).toEqual({ allowed: true, url: `https://${host}/avatar.png`, local: false });
  });
  it.each([
    'http://i.gyazo.com/avatar.png', 'https://i.gyazo.com:8443/avatar.png',
    'https://user:password@i.gyazo.com/avatar.png', 'https://i.gyazo.com/avatar.png?token=private',
    'https://0.gravatar.com/avatar/hash?s=64', 'https://i.gyazo.com/avatar.png#private',
 'https://127.0.0.1/avatar.png',
    'https://[::1]/avatar.png', 'https://169.254.169.254/avatar.png',
    'https://i.gyazo.com/avatar.SVG', 'https://i.gyazo.com/avatar.svgz',
    '/api/private', '//i.gyazo.com/avatar.png', 'blob:https://example.test/id', 'data:image/svg+xml,<svg/>',
  ])('転送しない: %s', source => { expect(validateCanvasImageSource(source).allowed).toBe(false); });
  it('自前iconだけは同一origin直URLを許可する', () => {
    expect(validateCanvasImageSource('/icon.svg')).toEqual({ allowed: true, url: '/icon.svg', local: true });
  });
  it('optimizerの幅・quality・hostを固定する', () => {
    expect(canvasImageWidth(48)).toBe(64); expect(canvasImageWidth(9000)).toBe(1280);
    expect(config.images!.qualities).toEqual([75]);
    expect(config.images!.remotePatterns).toEqual([]);
    expect(config.images!.localPatterns).toEqual([]);
    expect(config.images!.dangerouslyAllowSVG).toBe(false);
    expect(config.images!.dangerouslyAllowLocalIP).toBe(false);
    expect(config.images!.maximumRedirects).toBe(0);
    expect(config.images!.maximumResponseBody).toBe(5_000_000);
  });
});
