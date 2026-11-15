import 'server-only';

/** Vercelでは実験ブランチのPreviewだけに専用変数を設定する。既定は無効。 */
export function isCorsImageExperimentEnabled(): boolean {
  const environments = [process.env.VERCEL_ENV, process.env.VERCEL_TARGET_ENV].filter(Boolean);
  // System Environment Variablesが提供される環境では本番・未知の環境指定を優先して拒否する。
  if (environments.some(value => value !== 'preview' && value !== 'development')) return false;
  // Vercelのsystem変数はproject設定で非公開にできるため、Preview判定の必須条件にしない。
  // next.config.envへ埋め込まず、動的routeの実行時にPreview限定の設定を読む。
  return process.env.CANVAS_CORS_EXPERIMENT_ENABLED === '1' || process.env.NODE_ENV === 'development';
}
