// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({ pubkey: 'owner' as string | null }));
const renderer = vi.hoisted(() => ({ props: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../hooks/useNostrRelay', () => ({ useNostrRelay: () => ({}) }));
vi.mock('../hooks/useThreadCards', () => ({ useThreadCards: () => ({ filteredNotes: [], threadCards: [], isProcessing: false }) }));
vi.mock('../hooks/useRecentEmojis', () => ({ useRecentEmojis: () => ({ recentEmojis: [], addEmoji: vi.fn() }) }));
vi.mock('../components/LiveCanvasV2', () => ({ LiveCanvasV2: (props: unknown) => { renderer.props(props);return <div>標準キャンバス</div>; } }));
import { Home } from '../components/Home';
afterEach(() => { cleanup();vi.clearAllMocks();auth.pubkey='owner'; });
describe('標準Homeの描画方式', () => {
  it('通常はV2を使い旧版切替や検証版ナビを表示しない', () => {
    render(<Home />);
    expect(screen.getByText('標準キャンバス')).toBeDefined();
    expect(screen.queryByRole('navigation', { name: 'Canvas version' })).toBeNull();
    expect(renderer.props.mock.calls[0][0]).toMatchObject({ diagnosticsEnabled: false, nativeImagesEnabled: false });
  });
  it('serverで判定したboolのみV2へ渡す', () => {
    render(<Home diagnosticsEnabled imageAccessMode="preview" />);
    expect(renderer.props.mock.calls[0][0]).toMatchObject({ diagnosticsEnabled: true, nativeImagesEnabled: true });
  });
  it('未認証は既存ログイン操作を残しV1/V2選択は表示しない', () => {
    auth.pubkey=null;render(<Home />);
    expect(screen.getByRole('button', { name: 'リモート署名器でログイン' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'ブラウザ拡張でログイン' })).toBeDefined();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(renderer.props).not.toHaveBeenCalled();
  });
});
