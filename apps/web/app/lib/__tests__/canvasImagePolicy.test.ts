import { describe, expect, it } from 'vitest';
import { validateCanvasImageSource } from '../canvasImagePolicy';
import config from '../../../next.config';

describe('Canvasの公開画像許可範囲', () => {
  it.each(['i.gyazo.com', 'images.example.org', 'another.example.net'])('%sをHTTPS/queryなしで受付する（IP検査はserver）', host => {
    expect(validateCanvasImageSource(`https://${host}/avatar.png`)).toEqual({ allowed: true, url: `https://${host}/avatar.png`, local: false });
  });
  it.each([
    'http://i.gyazo.com/avatar.png', 'https://i.gyazo.com:8443/avatar.png',
    'https://user:password@i.gyazo.com/avatar.png',

 'https://127.0.0.1/avatar.png',
    'https://[::1]/avatar.png', 'https://169.254.169.254/avatar.png',

    '/api/private', '//i.gyazo.com/avatar.png', 'blob:https://example.test/id', 'data:image/svg+xml,<svg/>',
  ])('転送しない: %s', source => { expect(validateCanvasImageSource(source).allowed).toBe(false); });
  it('自前iconだけは同一origin直URLを許可する', () => {
    expect(validateCanvasImageSource('/icon.svg')).toEqual({ allowed: true, url: '/icon.svg', local: true });
  });
  it('サーバーoptimizerは無効、query/SVGも直接CORS取得できる', () => {
    expect(config.images!.unoptimized).toBe(true);
    expect(validateCanvasImageSource('https://images.example.test/image.svg?size=64').allowed).toBe(true);
  });
});
