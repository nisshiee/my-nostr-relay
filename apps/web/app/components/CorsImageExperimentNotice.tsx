import Link from 'next/link';

/** 実験中の取得方式と、描画方式の違いをログイン前後に表示する。 */
export function CorsImageExperimentNotice() {
  return <aside aria-label="CORS画像実験" className="shrink-0 border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-950">
    <strong>実験: CORS画像の直接取得</strong>
    <p>画像は配信元へ直接接続します（接続元IPが伝わります）。画像proxy・画像用の本人確認署名は使いません。通常のNostrログインは必要です。</p>
    <p>取得できない画像は▧で表示します。CORS不許可・通信失敗・画像形式の違いは自動判別できません。DOM互換表示でも取得方式は同じです。 <Link href="/" prefetch={false} className="underline">通常モードへ戻る</Link></p>
  </aside>;
}
