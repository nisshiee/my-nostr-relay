"use client";

import { useState } from 'react';
import Link from 'next/link';
import { CanvasScene } from '../../components/v2/CanvasScene';

function LabCard({ id }: { id: string }) {
  const [count, setCount] = useState(0);
  return <article className="rounded-2xl border border-zinc-300 bg-white p-5 text-zinc-900 shadow-sm">
    <p className="text-xs font-bold uppercase tracking-widest text-violet-600">NLC / Renderer lab</p>
    <h2 className="my-3 text-xl font-bold">{id === '1' ? 'HTMLを、そのままCanvasへ。' : `Live card ${id}`}</h2>
    <p className="mb-4">日本語・リンク・ボタン・入力をブラウザのHTML描画で扱います。リレー接続も投稿も行わない検証画面です。</p>
    <button data-testid={`button-${id}`} className="rounded-lg bg-violet-600 px-4 py-2 text-white" onClick={() => setCount(c => c + 1)}>クリック {count}</button>
    <label className="mt-4 block">下書き {id}<textarea aria-label={`下書き ${id}`} className="mt-2 block w-full rounded border p-2" placeholder="モード切替でも入力を維持" /></label>
    <a className="mt-3 inline-block underline" href="#lab-help">検証メモへ</a>
  </article>;
}
export default function Lab() {
  const [ids, setIds] = useState(['1', '2', '3', '4', '5', '6']);
  return <main className="flex h-dvh flex-col bg-zinc-100">
    <header className="flex flex-wrap items-center gap-4 bg-zinc-900 px-5 py-3 text-white"><strong>Nostr Live Canvas V2</strong><span>オフライン検証</span><button className="rounded border px-2 py-1" onClick={() => setIds(previous => [String(Math.max(...previous.map(Number), 0) + 1), ...previous])}>カード追加</button><button className="rounded border px-2 py-1" onClick={() => setIds(previous => previous.slice(1))}>先頭を削除</button><Link href="/v2">実データ版</Link></header>
    <CanvasScene items={ids.map(id => ({ id, content: <LabCard id={id} /> }))} />
    <p id="lab-help" className="bg-white px-4 py-2 text-xs text-zinc-700">この画面は外部通信なしの固定fixtureです。native表示・クリック・Tab・入力・ズーム・DOM切替・追加削除を検証できます。</p>
  </main>;
}
