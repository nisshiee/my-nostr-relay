import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "投稿ポリシー - nisshieeのプライベートリレー",
  description:
    "Nostrリレーサーバー（relay.nostr.nisshiee.org）の投稿ポリシーです。コンテンツガイドラインとモデレーション方針について説明します。",
  openGraph: {
    title: "投稿ポリシー - nisshieeのプライベートリレー",
    description: "Nostrリレーサーバーの投稿ポリシー",
    url: "https://nostr.nisshiee.org/relay/posting-policy",
    siteName: "nisshieeのプライベートリレー",
    locale: "ja_JP",
    type: "website",
  },
  robots: {
    index: true,
    follow: true,
  },
  alternates: {
    canonical: "https://nostr.nisshiee.org/relay/posting-policy",
  },
};

export default function PostingPolicyPage() {
  return (
    <article className="prose prose-zinc dark:prose-invert max-w-none">
      <h1>投稿ポリシー</h1>

      <p className="lead">
        本ページでは、nisshieeのプライベートリレー（relay.nostr.nisshiee.org）における投稿に関するポリシーを定めます。
      </p>

      <section>
        <h2>1. 基本方針</h2>
        <ul>
          <li>本リレーは個人運用のプライベートリレーです。</li>
          <li>
            試験運用中のため、予告なく仕様変更・サービス停止する場合があります。
          </li>
          <li>投稿内容の保存を保証するものではありません。</li>
          <li>
            利用者は、重要なデータについて自己の責任においてバックアップを行ってください。
          </li>
        </ul>
      </section>

      <section>
        <h2>2. 受け入れ対象</h2>

        <h3>2.1 優先的に受け入れるイベント</h3>
        <p>
          運営者（公開鍵:
          npub1wdy32zdcutvqssy88ddp8w5c5hg6cwskey5juyrtruhd5vg493fq4s75d5）のイベントを優先的に受け入れます。
        </p>

        <h3>2.2 他のユーザーのイベント</h3>
        <p>
          他のユーザーのイベントも受け入れますが、以下の点にご注意ください。
        </p>
        <ul>
          <li>保存期間は保証されません。</li>
          <li>ストレージコスト等の理由により、予告なく削除する場合があります。</li>
          <li>運営者のイベントを優先するため、容量不足時には削除される可能性があります。</li>
        </ul>
      </section>

      <section>
        <h2>3. サポートするイベント種別</h2>
        <p>
          本リレーは、NIP-01で定義される基本的なイベント種別をサポートします。
        </p>
        <p>詳細は、NIP-11レスポンスの `supported_nips` フィールドを参照してください。</p>
        <pre className="bg-zinc-100 dark:bg-zinc-900 p-4 rounded-md overflow-x-auto">
          <code className="text-zinc-900 dark:text-zinc-100">
            {`curl -H "Accept: application/nostr+json" https://relay.nostr.nisshiee.org/`}
          </code>
        </pre>
      </section>

      <section>
        <h2>4. 禁止コンテンツ</h2>
        <p>以下のコンテンツの投稿を禁止します。</p>

        <h3>4.1 法令違反コンテンツ</h3>
        <ul>
          <li>日本国法令に違反するコンテンツ</li>
          <li>犯罪行為に関連するコンテンツ</li>
          <li>違法薬物、武器、児童ポルノ等に関するコンテンツ</li>
        </ul>

        <h3>4.2 権利侵害コンテンツ</h3>
        <ul>
          <li>他者の著作権を侵害するコンテンツ</li>
          <li>他者の肖像権を侵害するコンテンツ</li>
          <li>他者のプライバシー権を侵害するコンテンツ</li>
          <li>他者の名誉を毀損するコンテンツ</li>
        </ul>

        <h3>4.3 迷惑行為</h3>
        <ul>
          <li>スパム、過度な連続投稿</li>
          <li>
            宣伝・広告目的の投稿（ただし、運営者が許可した場合を除く）
          </li>
          <li>
            同一または類似の内容を大量に投稿する行為（ボット投稿等）
          </li>
        </ul>

        <h3>4.4 悪意のあるコンテンツ</h3>
        <ul>
          <li>マルウェア、ウイルス等の有害なプログラム</li>
          <li>フィッシングサイトへのリンク</li>
          <li>リレーサーバーへの攻撃を試みるコンテンツ</li>
        </ul>
      </section>

      <section>
        <h2>5. コンテンツモデレーション</h2>
        <p>
          運営者は、本ポリシーに違反すると判断した場合、以下の対応を行う場合があります。
        </p>

        <h3>5.1 対応内容</h3>
        <ul>
          <li>該当イベントの削除</li>
          <li>特定公開鍵からの投稿拒否（ブロック）</li>
          <li>サービスの一時停止</li>
        </ul>

        <h3>5.2 対応の判断基準</h3>
        <p>
          対応の判断は運営者の裁量により行います。対応の理由は原則として開示しません。
        </p>

        <h3>5.3 事前通知</h3>
        <p>
          緊急性が高い場合や、運営者が必要と判断した場合は、事前通知なく対応を行う場合があります。
        </p>
      </section>

      <section>
        <h2>6. 権利侵害への対応</h2>

        <h3>6.1 情報流通プラットフォーム対処法準拠</h3>
        <p>
          本リレーは、情報流通プラットフォーム対処法（特定電気通信による情報の流通によって発生する権利侵害等への対処に関する法律）に基づく送信防止措置手続きに対応します。
        </p>

        <h3>6.2 申出窓口</h3>
        <p>
          権利侵害を受けたと思われる場合は、利用規約に記載の問い合わせ先までご連絡ください。
        </p>
        <p>
          <strong>申出窓口:</strong>{" "}
          <a href="mailto:nostr-relay-admin@nisshiee.org">
            nostr-relay-admin@nisshiee.org
          </a>
        </p>

        <h3>6.3 削除判断</h3>
        <p>
          申出に基づき、運営者が適切と判断した場合、該当イベントを削除します。削除判断は、申出受理後30日以内を目安に行います。
        </p>
      </section>

      <section>
        <h2>7. データ保持</h2>

        <h3>7.1 保存場所</h3>
        <p>イベントデータは AWS DynamoDB に保存されます。</p>

        <h3>7.2 保持期間</h3>
        <p>
          イベントデータの保持期間は保証されません（試験運用中のため）。
        </p>
        <p>以下の理由により、予告なく古いイベントを削除する場合があります。</p>
        <ul>
          <li>ストレージコストの削減</li>
          <li>パフォーマンスの改善</li>
          <li>技術的な制約</li>
          <li>運営方針の変更</li>
        </ul>

        <h3>7.3 削除要求への対応</h3>
        <p>
          利用者は、Nostr DELETE要求（NIP-09）により、自身が投稿したイベントの削除を要求できます。
        </p>
        <p>
          ただし、技術的な理由や他のリレーへの拡散等により、削除要求に応じられない場合があります。
        </p>
      </section>

      <section>
        <h2>8. 制限事項</h2>
        <p>
          本リレーでは、以下の制限を設けています。詳細は NIP-11 レスポンスの `limitation`
          フィールドを参照してください。
        </p>

        <h3>8.1 現在の制限値</h3>
        <ul>
          <li>
            <strong>サブスクリプションID最大長:</strong> 64文字（NIP-01準拠）
          </li>
        </ul>

        <h3>8.2 制限値の確認方法</h3>
        <p>最新の制限値は、NIP-11レスポンスで確認できます。</p>
        <pre className="bg-zinc-100 dark:bg-zinc-900 p-4 rounded-md overflow-x-auto">
          <code className="text-zinc-900 dark:text-zinc-100">
            {`curl -H "Accept: application/nostr+json" https://relay.nostr.nisshiee.org/ | jq .limitation`}
          </code>
        </pre>
      </section>

      <section>
        <h2>9. ポリシーの変更</h2>
        <ol>
          <li>
            本ポリシーは、予告なく変更される場合があります。
          </li>
          <li>
            変更後のポリシーは、本ページへの掲載により効力を生じます。
          </li>
          <li>
            最新版は、常に本ページで確認してください。
          </li>
        </ol>
      </section>

      <section>
        <h2>10. 問い合わせ</h2>
        <p>本ポリシーに関するお問い合わせは、以下までご連絡ください。</p>
        <p>
          <strong>連絡先:</strong>{" "}
          <a href="mailto:nostr-relay-admin@nisshiee.org">
            nostr-relay-admin@nisshiee.org
          </a>
        </p>
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
