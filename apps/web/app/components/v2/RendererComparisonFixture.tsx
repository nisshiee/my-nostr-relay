"use client";

import Image from 'next/image';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CanvasScene, type CanvasSceneItem } from './CanvasScene';

const BASE_IDS = Array.from({ length: 40 }, (_, index) => index + 1);
const REPLAY_DURATION = 5000;

function ComparisonCard({ id, expanded }: { id: number; expanded: boolean }) {
  const [count, setCount] = useState(0);
  return <article data-comparison-card={id} className="rounded-xl border border-violet-200 bg-white p-4 text-zinc-900" style={{ minHeight: 220 + (id % 4) * 48 }}>
    <div className="flex items-center gap-2">
      {id % 4 === 1 && <Image src="/icon.svg" width={32} height={32} unoptimized alt="同一originの固定画像" />}
      <h2 className="font-bold">固定カード {id}</h2>
    </div>
    <p className="my-3 text-sm">比較専用の固定テキスト。カード数・スコア・高さ・更新順を同じにして描画方式を比較します。</p>
    <button type="button" aria-label={`固定カード${id}のカウンター`} className="rounded bg-violet-700 px-3 py-1 text-white" onClick={() => setCount(value => value + 1)}>クリック {count}</button>
    <label className="mt-3 block text-xs">ローカル入力 {id}<input aria-label={`固定カード${id}の入力`} className="mt-1 block w-full rounded border p-2" placeholder="送信されません" /></label>
    {expanded && <div data-comparison-expanded className="mt-3 rounded bg-violet-100 p-3 text-sm" style={{ height: 160 }}>2秒で高さを増やし、4秒で元に戻す固定更新です。</div>}
  </article>;
}

/** 実フィードと区別した有限の再現入力。リレー・投稿・外部画像取得を使わない。 */
export function RendererComparisonFixture() {
  const [ids, setIds] = useState(BASE_IDS);
  const [expanded, setExpanded] = useState(false);
  const [revision, setRevision] = useState(0);
  const [measurementToken, setMeasurementToken] = useState(0);
  const [phase, setPhase] = useState<'ready' | 'running' | 'complete'>('ready');
  const [step, setStep] = useState('初期40枚');
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const running = useRef(false);
  const cancel = () => { timers.current.forEach(clearTimeout); timers.current = []; running.current = false; };
  useEffect(() => () => { timers.current.forEach(clearTimeout); timers.current = []; running.current = false; }, []);

  const reset = () => {
    cancel(); setIds(BASE_IDS); setExpanded(false); setRevision(value => value + 1);
    setMeasurementToken(0); setPhase('ready'); setStep('初期40枚');
  };
  const replay = () => {
    if (running.current || phase !== 'ready') return;
    running.current = true; setPhase('running'); setStep('0秒: 計測開始');
    setMeasurementToken(value => value + 1);
    const schedule = (delay: number, update: () => void) => timers.current.push(setTimeout(update, delay));
    schedule(1000, () => { setIds([41, ...BASE_IDS]); setStep('1秒: 新着41を追加'); });
    schedule(2000, () => { setExpanded(true); setStep('2秒: カード1の高さを増加'); });
    schedule(3000, () => { setIds([43, 42, 41, ...BASE_IDS]); setStep('3秒: 新着42・43を同時追加'); });
    schedule(4000, () => { setExpanded(false); setIds([43, 42, 41, ...BASE_IDS.slice(0, -1)]); setStep('4秒: 高さを戻しカード40を削除'); });
    schedule(REPLAY_DURATION, () => { timers.current = []; running.current = false; setPhase('complete'); setStep('5秒: 再生終了（再比較は初期化）'); });
  };
  const items = useMemo<CanvasSceneItem[]>(() => ids.map(id => ({
    id: `comparison-${id}`,
    card: {
      type: 'note', slotId: `comparison-${id}`, eventId: `comparison-event-${id}`,
      pubkey: `comparison-author-${id % 8}`, created_at: 0,
      score: id > 40 ? 1000 + id : 1000 - id, content: '', tags: [],
    },
    content: <ComparisonCard id={id} expanded={id === 1 && expanded} />,
  })), [ids, expanded]);

  return <section aria-label="再現フィード比較" className="flex min-h-0 flex-1 flex-col">
    <div className="flex flex-wrap items-center gap-3 border-b bg-violet-50 px-4 py-2 text-xs text-zinc-900">
      <strong>固定40枚 / 5秒の再現入力</strong>
      <button type="button" className="rounded border px-3 py-1" onClick={reset}>比較を初期化</button>
      <button type="button" className="rounded border px-3 py-1 disabled:opacity-40" disabled={phase !== 'ready'} onClick={replay}>5秒の固定入力を再生</button>
      <output aria-label="再現入力の状態" data-comparison-phase={phase} data-comparison-count={ids.length}>{step}</output>
    </div>
    <p className="bg-white px-4 py-2 text-xs text-zinc-700">初期化 → QAで描画方式と同じエフェクトを選択 → 画像と配置が落ち着いてから再生。1秒: 1枚追加、2秒: 高さ変更、3秒: 2枚追加、4秒: 高さ復元と1枚削除。再生操作で5秒計測も開始します（計測の起点は次のrAFで、最大約1frameの差があります）。比較中は同じviewport・scroll位置を使い、入力操作を避けてください。タイマーの実行時刻はブラウザ負荷で遅れることがあります。これは固定fixtureの比較であり、自然新着の実フィードE2Eではありません。</p>
    <CanvasScene key={revision} items={items} qaMeasurementToken={measurementToken} />
  </section>;
}
