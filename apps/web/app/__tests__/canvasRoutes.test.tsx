import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => { throw new Error(`redirect:${path}`); },
}));
vi.mock('../components/Home', () => ({ Home: () => null }));
import Page from '../page';
import LegacyCanvasRedirect from '../v2/page';
import { Home } from '../components/Home';
import { isCanvasDiagnosticsEnabled } from '../lib/canvasDiagnostics';

afterEach(() => vi.unstubAllEnvs());
function environment(platform?: string, target?: string) {
  vi.stubEnv('CANVAS_DIAGNOSTICS_ENABLED', '1');
  vi.stubEnv('CANVAS_DIAGNOSTICS_SCOPE', 'protected-preview');
  vi.stubEnv('VERCEL_ENV', platform);
  vi.stubEnv('VERCEL_TARGET_ENV', target);
}
describe('標準画面と診断route', () => {
  it('通常入口はHomeを描画し旧v2入口は同じ標準画面へredirectする', () => {
    environment('production');
    const page = Page();
    expect(React.isValidElement(page)).toBe(true);
    expect(page.type).toBe(Home);
    expect(page.props).toEqual({ diagnosticsEnabled: false, imageAccessMode: 'disabled' });
    expect(() => LegacyCanvasRedirect()).toThrow('redirect:/');
  });
  it('画像gateはserverで判定し本番はDOM、保護Previewだけnative可否を渡す', () => {
    vi.stubEnv('CANVAS_IMAGE_PROXY_ENABLED', '1');
    vi.stubEnv('CANVAS_IMAGE_PROXY_SCOPE', 'protected-preview');
    environment('production');expect(Page().props.imageAccessMode).toBe('disabled');
    environment('preview');expect(Page().props.imageAccessMode).toBe('preview');
    vi.stubEnv('CANVAS_IMAGE_PROXY_ENABLED', '0');expect(Page().props.imageAccessMode).toBe('disabled');
  });
  it('明示された保護Previewだけに診断boolを渡す', () => {
    environment('preview');
    expect(Page().props.diagnosticsEnabled).toBe(true);
  });
  it.each([
    ['production', 'preview'], ['preview', 'production'], ['unknown', 'preview'],
    ['preview', 'unknown'], ['production', undefined], [undefined, 'production'],
  ])('既知の本番/未知platformでは両flagがあっても診断無効 (%s/%s)', (platform, target) => {
    environment(platform, target);
    expect(isCanvasDiagnosticsEnabled()).toBe(false);
  });
  it.each(['CANVAS_DIAGNOSTICS_ENABLED', 'CANVAS_DIAGNOSTICS_SCOPE'])('flag未設定はfail-closed: %s', key => {
    environment('preview');vi.stubEnv(key, undefined);
    expect(isCanvasDiagnosticsEnabled()).toBe(false);
  });
  it('platform変数不在でも明示scopeが必要で、画像proxy flagを代用しない', () => {
    environment();expect(isCanvasDiagnosticsEnabled()).toBe(true);
    vi.stubEnv('CANVAS_DIAGNOSTICS_SCOPE', undefined);
    vi.stubEnv('CANVAS_IMAGE_PROXY_ENABLED', '1');
    vi.stubEnv('CANVAS_IMAGE_PROXY_SCOPE', 'protected-preview');
    expect(isCanvasDiagnosticsEnabled()).toBe(false);
  });
});
