import { describe, expect, it } from 'vitest';
import { hasAllowedPublicImageQuery } from '../publicImageQuery';
import { validateCanvasImageSource } from '../canvasImagePolicy';
import { validatePublicImageUrl } from '../publicImageFetch';
const base = 'https://0.gravatar.com/avatar/' + 'a'.repeat(64);
describe('観測済みGravatarサイズquery', () => {
  it.each(['1', '64', '512', '2048'])('client/serverの両方でsize=%sを許可する', size => {
    const source = `${base}?size=${size}`;
    expect(hasAllowedPublicImageQuery(new URL(source))).toBe(true);
    expect(validateCanvasImageSource(source).allowed).toBe(true);
    expect(validatePublicImageUrl(source).href).toBe(source);
  });
  it('観測済み2.gravatarのbuiltin initialsだけ許可する', () => {
    const source = `https://2.gravatar.com/avatar/${'a'.repeat(64)}?size=512&d=initials`;
    expect(validateCanvasImageSource(source).allowed).toBe(true);
    expect(validatePublicImageUrl(source).href).toBe(source);
  });
  it.each([
    '?d=initials', '?size=512&d=initials&d=initials', '?size=512&d=unknown',
    '?size=0', '?size=2049', '?size=0001', '?size=512&size=64', '?size=512&token=secret',
    '?size=512&signature=secret', '?size=https://example.com', '?size=512x', '?s=512',
    '?size=512&d=https://example.com', '?Size=512', '?size=1.5', '?size=1e3',
  ])('未知・機微・不正queryを送信しない: %s', query => {
    const source = base + query;
    expect(hasAllowedPublicImageQuery(new URL(source))).toBe(false);
    expect(validateCanvasImageSource(source).allowed).toBe(false);
    expect(() => validatePublicImageUrl(source)).toThrow();
  });
  it.each([
    `https://0.gravatar.com.evil.test/avatar/${'a'.repeat(64)}?size=512`,
    `https://1.gravatar.com/avatar/${'a'.repeat(64)}?size=512`,
    'https://0.gravatar.com/private?size=512',
    `https://0.gravatar.com/avatar/${'a'.repeat(33)}?size=512`,
  ])('host/pathを拡張しない: %s', source => {
    expect(hasAllowedPublicImageQuery(new URL(source))).toBe(false);
    expect(() => validatePublicImageUrl(source)).toThrow();
  });
});

describe('観測済みX画像変換query', () => {
  it.each(['media/AbCd_123-xy', 'amplify_video_thumb/2119757919663304704/img/OXS5Y6PpOL8i_7QA'])('既知host/固定format/nameだけをclientとserverで許可する: %s', path => {
    const source = `https://pbs.twimg.com/${path}?format=webp&name=large`;
    expect(validateCanvasImageSource(source).allowed).toBe(true);
    expect(validatePublicImageUrl(source).href).toBe(source);
  });
  it.each([
    'https://pbs.twimg.com/media/AbCd?format=webp&name=large&token=secret',
    'https://pbs.twimg.com/media/AbCd?format=webp&name=large&name=large',
    'https://pbs.twimg.com/media/AbCd?format=svg&name=large',
    'https://pbs.twimg.com/media/AbCd?format=webp&name=https://example.com',
    'https://other.example/media/AbCd?format=webp&name=large',
    'https://pbs.twimg.com/private/AbCd?format=webp&name=large',
    'https://pbs.twimg.com/amplify_video_thumb/abc/img/AbCd?format=webp&name=large',
    'https://pbs.twimg.com/amplify_video_thumb/123/other/AbCd?format=webp&name=large',
    'https://pbs.twimg.com/amplify_video_thumb/123/img/AbCd?format=webp&name=large&signature=secret',
    'https://events.kojira.io/api/events/unknown/image?v=secret',
  ])('未知のqueryを転送しない: %s', source => {
    expect(validateCanvasImageSource(source).allowed).toBe(false);
    expect(() => validatePublicImageUrl(source)).toThrow();
  });
});


describe('BASE観測済み公開resizeのみ', () => {
  const url = 'https://baseec-img-mng.akamaized.net/images/item/origin/' + 'a'.repeat(32) + '.png';
  const query = '?imformat=generic&q=90&im=Resize,width=1200,type=normal';
  it('固定変換だけclient/serverとも許可', () => {
    expect(validateCanvasImageSource(url + query).allowed).toBe(true);
    expect(validatePublicImageUrl(url + query).hostname).toBe('baseec-img-mng.akamaized.net');
  });
  it.each([
    '?imformat=svg&q=90&im=Resize,width=1200,type=normal',
    '?imformat=generic&q=100&im=Resize,width=1200,type=normal',
    '?imformat=generic&q=90&im=Resize,width=99999,type=normal',
    '?imformat=generic&q=90&im=Composite,url=https://example.com',
    '?imformat=generic&q=90&im=Resize,width=1200,type=normal&signature=secret',
    '?imformat=generic&q=90&q=90&im=Resize,width=1200,type=normal',
  ])('任意DSL/機微query/重複を拒否: %s', query => {
    expect(validateCanvasImageSource(url + query).allowed).toBe(false);
    expect(() => validatePublicImageUrl(url + query)).toThrow();
  });
  it('別path/hostに適用しない', () => {
    expect(hasAllowedPublicImageQuery(new URL(url.replace('/item/origin/', '/private/') + query))).toBe(false);
    expect(hasAllowedPublicImageQuery(new URL(url.replace('.akamaized.net', '.evil.test') + query))).toBe(false);
  });
});
