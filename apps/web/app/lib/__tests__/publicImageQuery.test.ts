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
  it.each([
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
  it('既知host/media/固定format/nameだけをclientとserverで許可する', () => {
    const source = 'https://pbs.twimg.com/media/AbCd_123-xy?format=webp&name=large';
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
    'https://events.kojira.io/api/events/unknown/image?v=secret',
  ])('未知のqueryを転送しない: %s', source => {
    expect(validateCanvasImageSource(source).allowed).toBe(false);
    expect(() => validatePublicImageUrl(source)).toThrow();
  });
});
