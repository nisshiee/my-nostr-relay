// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({ pubkey: 'owner' as string | null }));
const capability = vi.hoisted(() => ({ value: true }));
vi.mock('../components/canvas/nativeCanvasCapability', () => ({ useNativeCanvasCapability: () => capability.value }));
const renderer = vi.hoisted(() => ({ props: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../hooks/useNostrRelay', () => ({ useNostrRelay: () => ({}) }));
vi.mock('../hooks/useThreadCards', () => ({ useThreadCards: () => ({ filteredNotes: [], threadCards: [], isProcessing: false }) }));
vi.mock('../hooks/useRecentEmojis', () => ({ useRecentEmojis: () => ({ recentEmojis: [], addEmoji: vi.fn() }) }));
vi.mock('../components/LiveCanvas', () => ({ LiveCanvas: (props: unknown) => { renderer.props(props);return <div>標準キャンバス</div>; } }));
import { Home } from '../components/Home';
afterEach(() => { cleanup();vi.clearAllMocks();auth.pubkey='owner';capability.value=true;localStorage.clear(); });
describe('標準Homeの描画方式', () => {
  it('通常は現行Canvasを使い旧版切替や検証版ナビを表示しない', () => {
    render(<Home />);
    expect(screen.getByText('標準キャンバス')).toBeDefined();
    expect(screen.queryByRole('navigation', { name: 'Canvas version' })).toBeNull();
    expect(renderer.props.mock.calls[0][0]).toMatchObject({ diagnosticsEnabled: false, nativeEnabled: true });
  });
  it('serverで判定したboolのみCanvasへ渡す', () => {
    render(<Home diagnosticsEnabled />);
    expect(renderer.props.mock.calls[0][0]).toMatchObject({ diagnosticsEnabled: true, nativeEnabled: true });
  });
  it('非対応ブラウザと保存済み互換表示はnative画像を使わない', () => {
    capability.value=false;const {unmount}=render(<Home/>);
    expect(renderer.props.mock.calls.at(-1)![0]).toMatchObject({nativeEnabled:false});unmount();
    capability.value=true;localStorage.setItem('nlc-v2-manual-dom','true');render(<Home/>);
    expect(renderer.props.mock.calls.at(-1)![0]).toMatchObject({nativeEnabled:false});
  });
  it('未認証は既存ログイン操作を残し旧版選択は表示しない', () => {
    auth.pubkey=null;render(<Home />);
    expect(screen.getByRole('button', { name: 'リモート署名器でログイン' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'ブラウザ拡張でログイン' })).toBeDefined();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(renderer.props).not.toHaveBeenCalled();
  });
});
