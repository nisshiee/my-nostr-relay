import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import Page from '../page';
import { MediaImage } from '../../../components/CanvasAwareImage';
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not-found'); } }));
vi.mock('../../../components/Home', () => ({ Home: ({ corsExperiment }: { corsExperiment: boolean }) => <div data-experiment={corsExperiment}><MediaImage alt="合成画像" src="https://images.example.test/fixture.png" /></div> }));
afterEach(() => vi.unstubAllEnvs());
it('本番ではHomeを返さず404にする', () => {
  vi.stubEnv('VERCEL_ENV', 'production'); vi.stubEnv('VERCEL_TARGET_ENV', undefined);
  vi.stubEnv('CANVAS_CORS_EXPERIMENT_ENABLED', '1');
  expect(() => Page()).toThrow('not-found');
});
it.each(['preview', undefined])('Preview(system環境=%s)ではSSR時からHome全体にCORS providerを適用する', env => {
  vi.stubEnv('VERCEL_ENV', env); vi.stubEnv('VERCEL_TARGET_ENV', undefined); vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('CANVAS_CORS_EXPERIMENT_ENABLED', '1');
  const html = renderToStaticMarkup(Page());
  expect(html).toContain('data-experiment="true"');
  expect(html).toContain('crossorigin="anonymous"');
  expect(html).toContain('https://images.example.test/fixture.png');
  expect(html).not.toContain('/api/canvas-image');
});

it('system変数も専用変数もない配信環境は404にする', () => {
  vi.stubEnv('VERCEL_ENV', undefined); vi.stubEnv('VERCEL_TARGET_ENV', undefined); vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('CANVAS_CORS_EXPERIMENT_ENABLED', undefined);
  expect(() => Page()).toThrow('not-found');
});
