/** Fixed diagnostics only: upstream errors can contain credentials or auth URLs.
 * Codes describe observed failures, not an inferred root cause.
 */
export function describeRemoteLoginError(error: unknown): string {
  const message = typeof error === "string"
    ? error
    : error instanceof Error ? error.message : "";
  switch (message) {
    case "All promises were rejected":
      return "接続リレーへの要求送信がすべて失敗しました。リレー側の応答理由は未確認です。（N46-PUBLISH）";
    case "connection timed out":
    case "publish timed out":
    case "auth timed out":
      return "リレー接続または要求送信がタイムアウトしました。（N46-RELAY-TIMEOUT）";
    case "connection failed":
    case "websocket closed":
      return "リレーへの接続が失敗または切断されました。（N46-CONNECTION）";
    case "connection aborted":
      return "署名器への接続が中断されました。（N46-ABORTED）";
    case "Nostr extension took over, please retry the operation":
      return "ブラウザ拡張への切替で接続が中断されました。（N46-EXTENSION）";
    case "subscription closed before connection was established.":
      return "接続の確立前に応答の受信が終了しました。（N46-SUBSCRIPTION）";
    case "署名器から応答がありません。署名器と接続リレーを確認し、ログインをやり直してください。":
      return "署名器から応答がありません。署名器と接続リレーを確認し、ログインをやり直してください。（N46-RESPONSE-TIMEOUT）";
    default:
      return "NIP-46の接続または公開鍵取得に失敗しました。原因はまだ特定できていません。（N46-UNKNOWN）";
  }
}
