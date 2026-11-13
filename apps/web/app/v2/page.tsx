import { redirect } from 'next/navigation';

/** 旧ブックマークは標準画面へ統合する。 */
export default function LegacyCanvasRedirect() {
  redirect('/');
}
