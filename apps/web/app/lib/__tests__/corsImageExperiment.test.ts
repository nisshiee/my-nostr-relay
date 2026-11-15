import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { isCorsImageExperimentEnabled } from '../corsImageExperiment';
afterEach(() => vi.unstubAllEnvs());
describe('CORS実験URLの環境gate', () => {
  it.each([
    ['production', undefined, 'production', false],
    ['preview', 'production', 'production', false],
    ['production', 'preview', 'production', false],
    ['preview', undefined, 'production', true],
    [undefined, 'preview', 'production', true],
    ['preview', 'preview', 'production', true],
    ['development', undefined, 'development', true],
    [undefined, undefined, 'development', true],
    [undefined, undefined, 'production', false],
    ['custom', undefined, 'development', false],
  ] as const)('%s / %s / %s → %s', (env, target, node, expected) => {
    vi.stubEnv('VERCEL_ENV', env); vi.stubEnv('VERCEL_TARGET_ENV', target); vi.stubEnv('NODE_ENV', node);
    expect(isCorsImageExperimentEnabled()).toBe(expected);
  });
});
