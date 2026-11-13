import 'server-only';

/** サーバー側のみで呼ぶ配信gate。クライアント要求から有効化しない。 */
export function isCanvasImageProxyEnabled(): boolean {
  if (process.env.CANVAS_IMAGE_PROXY_ENABLED !== "1" ||
      process.env.CANVAS_IMAGE_PROXY_SCOPE !== "protected-preview") return false;
  // 本番・未知のplatform値は拒否。未提供時はPreview限定設定を信頼境界とする。
  return [process.env.VERCEL_ENV, process.env.VERCEL_TARGET_ENV].every(
    value => !value || value === "preview" || value === "development",
  );
}
