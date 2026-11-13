import 'server-only';

/** 診断画面は保護Preview限定。公開queryやブラウザ設定では有効化しない。 */
export function isCanvasDiagnosticsEnabled(): boolean {
  if (process.env.CANVAS_DIAGNOSTICS_ENABLED !== '1' ||
      process.env.CANVAS_DIAGNOSTICS_SCOPE !== 'protected-preview') return false;
  // platform変数が未提供の場合、Preview限定のサーバー設定を信頼境界とする。
  // このscope自体は認証ではなく、deploymentのアクセス保護は別途必要。
  return [process.env.VERCEL_ENV, process.env.VERCEL_TARGET_ENV].every(
    value => !value || value === 'preview' || value === 'development',
  );
}
