import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { isCorsImageExperimentEnabled } from '../corsImageExperiment';
afterEach(() => vi.unstubAllEnvs());
describe('CORS実験URLの環境gate', () => {
  it.each([
    ['production', undefined, 'production', '1', false],
    ['preview', 'production', 'production', '1', false],
    ['production', 'preview', 'production', '1', false],
    ['preview', undefined, 'production', '1', true],
    [undefined, 'preview', 'production', '1', true],
    ['preview', 'preview', 'production', '1', true],
    ['preview', undefined, 'production', undefined, false],
    ['development', undefined, 'development', undefined, true],
    [undefined, undefined, 'development', undefined, true],
    [undefined, undefined, 'production', undefined, false],
    [undefined, undefined, 'production', '1', true],
    [undefined, undefined, 'production', '0', false],
    [undefined, undefined, 'production', 'true', false],
    ['custom', undefined, 'development', '1', false],
  ] as const)('%s / %s / %s / flag=%s → %s', (env, target, node, flag, expected) => {
    vi.stubEnv('VERCEL_ENV', env); vi.stubEnv('VERCEL_TARGET_ENV', target); vi.stubEnv('NODE_ENV', node);
    vi.stubEnv('CANVAS_CORS_EXPERIMENT_ENABLED', flag);
    expect(isCorsImageExperimentEnabled()).toBe(expected);
  });
  it('同じモジュールでも実行時設定を読み直す', () => {
    vi.stubEnv('VERCEL_ENV', undefined); vi.stubEnv('VERCEL_TARGET_ENV', undefined); vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CANVAS_CORS_EXPERIMENT_ENABLED', undefined);
    expect(isCorsImageExperimentEnabled()).toBe(false);
    vi.stubEnv('CANVAS_CORS_EXPERIMENT_ENABLED', '1');
    expect(isCorsImageExperimentEnabled()).toBe(true);
    vi.stubEnv('CANVAS_CORS_EXPERIMENT_ENABLED', undefined);
    expect(isCorsImageExperimentEnabled()).toBe(false);
  });
});
