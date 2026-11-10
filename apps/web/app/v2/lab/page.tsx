"use client";

import { useState } from 'react';
import Link from 'next/link';
import { CanvasImageProvider, MediaImage } from '../../components/CanvasAwareImage';
import { CanvasScene } from '../../components/v2/CanvasScene';

function LabCard({ id, image }: { id: string; image: string }) {
  const [count, setCount] = useState(0);
  return <article className="rounded-2xl border border-zinc-300 bg-white p-5 text-zinc-900 shadow-sm">
    <p className="text-xs font-bold uppercase tracking-widest text-violet-600">NLC / Renderer lab</p>
    {id === '1' && <div className="my-3 flex items-center gap-3">
      <MediaImage src="/icon.svg" alt="同一originアイコン" width={32} height={32} />
      {image && <button aria-label="画像をクリック" onClick={() => setCount(value => value + 1)}>
        <MediaImage src={image} imageSize={64} alt="最適化画像" width={32} height={32} className="h-8 w-8 rounded-full object-cover" />
      </button>}
    </div>}
    <h2 className="my-3 text-xl font-bold">{id === '1' ? 'HTMLを、そのままCanvasへ。' : `Live card ${id}`}</h2>
    <p className="mb-4">日本語・リンク・ボタン・入力をブラウザのHTML描画で扱います。リレー接続も投稿も行わない検証画面です。</p>
    <button data-testid={`button-${id}`} className="rounded-lg bg-violet-600 px-4 py-2 text-white" onClick={() => setCount(c => c + 1)}>クリック {count}</button>
    <label className="mt-4 block">下書き {id}<textarea aria-label={`下書き ${id}`} className="mt-2 block w-full rounded border p-2" placeholder="モード切替でも入力を維持" /></label>
    <a className="mt-3 inline-block underline" href="#lab-help">検証メモへ</a>
  </article>;
}
export default function Lab() {
  const [input, setInput] = useState('');
  const [image, setImage] = useState('');
  const [ids, setIds] = useState(['1', '2', '3', '4', '5', '6']);
  return <main className="flex h-dvh flex-col bg-zinc-100">
    <header className="flex flex-wrap items-center gap-4 bg-zinc-900 px-5 py-3 text-white"><strong>Nostr Live Canvas V2</strong><span>オフライン検証</span><button className="rounded border px-2 py-1" onClick={() => setIds(previous => [String(Math.max(...previous.map(Number), 0) + 1), ...previous])}>カード追加</button><button className="rounded border px-2 py-1" onClick={() => setIds(previous => previous.slice(1))}>先頭を削除</button><Link href="/v2">実データ版</Link></header>
    <form className="flex flex-wrap items-center gap-2 bg-white px-4 py-2 text-xs" onSubmit={event => { event.preventDefault(); setImage(input); }}>
      <label>画像URL <input type="url" value={input} onChange={event => setInput(event.target.value)} className="rounded border p-1" placeholder="https://…" /></label>
      <button type="submit" className="rounded border px-2 py-1">安全画像配信を試す</button>
      <button type="button" className="rounded border px-2 py-1" onClick={() => setImage('')}>画像を外す</button>
      <span>公開HTTPS画像・queryなし。配信routeは既定で無効です。SVGや非対応画像は代替表示。</span>
    </form>
    <CanvasImageProvider><CanvasScene items={ids.map(id => ({ id, content: <LabCard id={id} image={image} /> }))} /></CanvasImageProvider>
    <p id="lab-help" className="bg-white px-4 py-2 text-xs text-zinc-700">初期状態は外部通信なしの固定fixtureです。画像URLを指定した場合だけ有効化された限定環境では安全取得route経由で取得します。native表示・クリック・Tab・入力・ズーム・DOM切替・追加削除を検証できます。</p>
  </main>;
}
