import 'server-only';

/** Previewとローカル開発だけに実験URLを公開する。競合する環境指定は拒否する。 */
export function isCorsImageExperimentEnabled(): boolean {
  const environments = [process.env.VERCEL_ENV, process.env.VERCEL_TARGET_ENV].filter(Boolean);
  return environments.length > 0
    ? environments.every(value => value === 'preview' || value === 'development')
    : process.env.NODE_ENV === 'development';
}
