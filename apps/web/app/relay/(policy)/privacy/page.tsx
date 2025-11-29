import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "プライバシーポリシー - nisshieeのプライベートリレー",
  description:
    "Nostrリレーサーバー（relay.nostr.nisshiee.org）のプライバシーポリシーです。個人情報の取り扱いについて説明します。",
  openGraph: {
    title: "プライバシーポリシー - nisshieeのプライベートリレー",
    description: "Nostrリレーサーバーのプライバシーポリシー",
    url: "https://nostr.nisshiee.org/relay/privacy",
    siteName: "nisshieeのプライベートリレー",
    locale: "ja_JP",
    type: "website",
  },
  robots: {
    index: true,
    follow: true,
  },
  alternates: {
    canonical: "https://nostr.nisshiee.org/relay/privacy",
  },
};

export default function PrivacyPage() {
  return (
    <article className="prose prose-zinc dark:prose-invert max-w-none">
      <h1>プライバシーポリシー</h1>

      <p className="lead">
        nisshiee（以下「運営者」）は、Nostrリレーサーバー（relay.nostr.nisshiee.org、以下「本サービス」）における利用者情報の取り扱いについて、以下のとおりプライバシーポリシーを定めます。
      </p>

      <section>
        <h2>1. 収集する情報</h2>
        <p>本サービスでは、以下の情報を収集します。</p>

        <h3>1.1 Nostrイベント情報</h3>
        <ul>
          <li>公開鍵（Nostr公開鍵、32バイトhex）</li>
          <li>イベントID</li>
          <li>署名</li>
          <li>タイムスタンプ</li>
          <li>イベント種別</li>
          <li>タグ情報</li>
          <li>コンテンツ（投稿内容）</li>
        </ul>

        <h3>1.2 接続情報</h3>
        <ul>
          <li>WebSocket接続ID</li>
          <li>接続時刻</li>
          <li>切断時刻</li>
        </ul>

        <h3>1.3 サブスクリプション情報</h3>
        <ul>
          <li>サブスクリプションID</li>
          <li>フィルター条件</li>
        </ul>

        <h3>1.4 アクセスログ</h3>
        <ul>
          <li>IPアドレス</li>
          <li>アクセス時刻</li>
          <li>User-Agent</li>
          <li>リクエスト内容</li>
        </ul>
      </section>

      <section>
        <h2>2. 情報の利用目的</h2>
        <p>収集した情報は、以下の目的で利用します。</p>
        <ol>
          <li>Nostrリレーサービスの提供</li>
          <li>サービスの維持・運営・改善</li>
          <li>不正利用の防止・検出</li>
          <li>サーバーの負荷分散・パフォーマンス最適化</li>
          <li>法令に基づく対応</li>
        </ol>
      </section>

      <section>
        <h2>3. 情報の保存期間</h2>

        <h3>3.1 Nostrイベントデータ</h3>
        <p>
          保存期間は無期限です。ただし、運営者の判断により予告なく削除する場合があります。
        </p>
        <ul>
          <li>
            ストレージコストや技術的制約により、古いイベントを削除する可能性があります
          </li>
          <li>試験運用中のため、データの保存を保証するものではありません</li>
        </ul>

        <h3>3.2 接続情報</h3>
        <p>WebSocket接続終了後、直ちに削除されます。</p>

        <h3>3.3 アクセスログ</h3>
        <p>最大90日間保存した後、自動的に削除されます。</p>
      </section>

      <section>
        <h2>4. 情報の第三者提供</h2>
        <p>
          運営者は、原則として収集した情報を第三者に提供しません。ただし、以下の場合を除きます。
        </p>
        <ol>
          <li>法令に基づく場合</li>
          <li>人の生命、身体または財産の保護のために必要がある場合</li>
          <li>権利侵害への対処のために必要な場合</li>
          <li>利用者の同意がある場合</li>
        </ol>
        <p>
          なお、Nostrイベントは、プロトコルの性質上、他のNostrリレーやクライアントと共有されることがあります。これはNostrプロトコルの仕様に基づくものであり、本ポリシーにおける「第三者提供」には該当しません。
        </p>
      </section>

      <section>
        <h2>5. 情報の安全管理</h2>
        <p>運営者は、収集した情報の安全管理のため、以下の措置を講じます。</p>
        <ul>
          <li>AWS環境における適切なアクセス制御</li>
          <li>DynamoDBによる保存時暗号化</li>
          <li>Lambda関数の環境変数による秘匿情報管理</li>
          <li>定期的なセキュリティアップデート</li>
        </ul>
        <p>
          ただし、完全なセキュリティを保証するものではありません。セキュリティ侵害により情報が漏洩した場合でも、運営者は一切の責任を負いません。
        </p>
      </section>

      <section>
        <h2>6. Cookieの使用</h2>
        <p>本サービスでは、Cookieを使用しません。</p>
      </section>

      <section>
        <h2>7. 利用者の権利</h2>

        <h3>7.1 削除要請権</h3>
        <p>
          利用者は、自身が投稿したNostrイベントの削除を要請する権利を有します。削除要請は、Nostr
          DELETE要求（NIP-09）により行うことができます。
        </p>
        <p>
          ただし、以下の理由により削除要請に応じられない場合があります。
        </p>
        <ul>
          <li>技術的な理由により削除が困難な場合</li>
          <li>他のリレーに既に拡散されている場合</li>
          <li>法令により保存が義務付けられている場合</li>
        </ul>

        <h3>7.2 情報開示請求</h3>
        <p>
          Nostrイベントは公開情報であり、誰でも閲覧可能です。アクセスログ等の非公開情報については、法令に基づく場合を除き開示しません。
        </p>
      </section>

      <section>
        <h2>8. 未成年者の利用</h2>
        <p>
          未成年者が本サービスを利用する場合は、保護者の同意を得た上で利用してください。
        </p>
      </section>

      <section>
        <h2>9. 問い合わせ窓口</h2>
        <p>本ポリシーに関するお問い合わせは、以下までご連絡ください。</p>
        <p>
          <strong>連絡先:</strong>{" "}
          <a href="mailto:nostr-relay-admin@nisshiee.org">
            nostr-relay-admin@nisshiee.org
          </a>
        </p>
      </section>

      <section>
        <h2>10. プライバシーポリシーの変更</h2>
        <ol>
          <li>
            運営者は、必要に応じて本ポリシーを変更することがあります。
          </li>
          <li>
            重要な変更を行う場合は、本ウェブサイトで告知します。
          </li>
          <li>
            変更後のポリシーは、本ウェブサイトへの掲載により効力を生じるものとします。
          </li>
        </ol>
      </section>

      <footer className="mt-12 pt-8 border-t border-zinc-200 dark:border-zinc-700 text-sm text-zinc-600 dark:text-zinc-400">
        <p>制定日: 2025年11月29日</p>
        <p>最終更新日: 2025年11月29日</p>
        <p>運営者: nisshiee</p>
        <p>
          連絡先:{" "}
          <a href="mailto:nostr-relay-admin@nisshiee.org">
            nostr-relay-admin@nisshiee.org
          </a>
        </p>
      </footer>
    </article>
  );
}
