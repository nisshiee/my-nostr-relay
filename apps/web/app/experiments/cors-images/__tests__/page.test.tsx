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
  expect(() => Page()).toThrow('not-found');
});
it('PreviewではSSR時からHome全体にCORS providerを適用する', () => {
  vi.stubEnv('VERCEL_ENV', 'preview'); vi.stubEnv('VERCEL_TARGET_ENV', undefined);
  const html = renderToStaticMarkup(Page());
  expect(html).toContain('data-experiment="true"');
  expect(html).toContain('crossorigin="anonymous"');
  expect(html).toContain('https://images.example.test/fixture.png');
  expect(html).not.toContain('/api/canvas-image');
});
