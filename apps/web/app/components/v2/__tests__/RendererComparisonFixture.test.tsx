// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasSceneItem } from '../CanvasScene';
import { RendererComparisonFixture } from '../RendererComparisonFixture';

let lastItems: CanvasSceneItem[] = [];
vi.mock('../CanvasScene', () => ({ CanvasScene: ({ items, qaMeasurementToken }: { items: CanvasSceneItem[]; qaMeasurementToken?: number }) => {
  lastItems = items;
  return <div data-testid="fixture-scene" data-token={qaMeasurementToken}>{items.map(item => <div key={item.id}>{item.content}</div>)}</div>;
} }));
vi.mock('next/image', () => ({ default: (props: React.ImgHTMLAttributes<HTMLImageElement> & { unoptimized?: boolean }) => {
  const clean = { ...props }; delete clean.unoptimized;
  // ローカルfixture画像の属性だけを確認する。
  // eslint-disable-next-line @next/next/no-img-element
  return <img {...clean} alt={clean.alt} />;
} }));

beforeEach(() => { vi.useFakeTimers(); lastItems = []; });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const state = () => screen.getByLabelText('再現入力の状態');
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe('RendererComparisonFixtureの有限再現入力', () => {
  it('40枚の同じ初期入力と同一origin画像だけを用意する', () => {
    render(<RendererComparisonFixture />);
    expect(lastItems).toHaveLength(40);
    expect(lastItems[0].id).toBe('comparison-1'); expect(lastItems[39].id).toBe('comparison-40');
    expect(lastItems[0].card?.score).toBe(999); expect(lastItems[39].card?.score).toBe(960);
    expect(screen.getByTestId('fixture-scene').dataset.token).toBe('0'); expect(vi.getTimerCount()).toBe(0);
    expect([...document.querySelectorAll('img')].map(image => image.getAttribute('src'))).toEqual(Array(10).fill('/icon.svg'));
  });

  it('再生と計測tokenを同時に起動し、固定追加・高さ更新・削除を一度だけ行う', () => {
    render(<RendererComparisonFixture />);
    fireEvent.click(screen.getByRole('button', { name: '5秒の固定入力を再生' }));
    expect(screen.getByTestId('fixture-scene').dataset.token).toBe('1');
    expect(state().dataset.comparisonPhase).toBe('running'); expect(vi.getTimerCount()).toBe(5);
    advance(1000);
    expect(lastItems.map(item => item.id).slice(0, 2)).toEqual(['comparison-41', 'comparison-1']); expect(lastItems).toHaveLength(41);
    advance(1000); expect(document.querySelectorAll('[data-comparison-expanded]')).toHaveLength(1);
    advance(1000);
    expect(lastItems.map(item => item.id).slice(0, 3)).toEqual(['comparison-43', 'comparison-42', 'comparison-41']); expect(lastItems).toHaveLength(43);
    advance(1000); expect(lastItems).toHaveLength(42); expect(lastItems.some(item => item.id === 'comparison-40')).toBe(false);
    expect(document.querySelector('[data-comparison-expanded]')).toBeNull();
    advance(1000); expect(state().dataset.comparisonPhase).toBe('complete'); expect(vi.getTimerCount()).toBe(0);
    const replay = screen.getByRole('button', { name: '5秒の固定入力を再生' }) as HTMLButtonElement;
    expect(replay.disabled).toBe(true); fireEvent.click(replay); advance(10000);
    expect(lastItems).toHaveLength(42); expect(screen.getByTestId('fixture-scene').dataset.token).toBe('1');
  });

  it('更新中も入力を保ち、初期化だけでカード状態・計測token・配置世代を戻す', () => {
    render(<RendererComparisonFixture />);
    fireEvent.click(screen.getByRole('button', { name: '固定カード1のカウンター' }));
    fireEvent.change(screen.getByRole('textbox', { name: '固定カード1の入力' }), { target: { value: '維持する入力' } });
    const oldScene = screen.getByTestId('fixture-scene');
    fireEvent.click(screen.getByRole('button', { name: '5秒の固定入力を再生' })); advance(2000);
    expect((screen.getByRole('textbox', { name: '固定カード1の入力' }) as HTMLInputElement).value).toBe('維持する入力');
    expect(screen.getByRole('button', { name: '固定カード1のカウンター' }).textContent).toBe('クリック 1');
    fireEvent.click(screen.getByRole('button', { name: '比較を初期化' }));
    expect(screen.getByTestId('fixture-scene')).not.toBe(oldScene); expect(screen.getByTestId('fixture-scene').dataset.token).toBe('0');
    expect((screen.getByRole('textbox', { name: '固定カード1の入力' }) as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: '固定カード1のカウンター' }).textContent).toBe('クリック 0');
    expect(vi.getTimerCount()).toBe(0); advance(10000);
    expect(lastItems).toHaveLength(40); expect(state().dataset.comparisonPhase).toBe('ready');
    fireEvent.click(screen.getByRole('button', { name: '5秒の固定入力を再生' })); advance(1000); expect(lastItems[0].id).toBe('comparison-41');
  });

  it('unmountで予約した更新をすべて解除する', () => {
    const view = render(<RendererComparisonFixture />);
    fireEvent.click(screen.getByRole('button', { name: '5秒の固定入力を再生' })); expect(vi.getTimerCount()).toBe(5);
    view.unmount(); expect(vi.getTimerCount()).toBe(0); advance(10000);
  });
});
