// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Home } from '../Home';
import { MediaImage } from '../CanvasAwareImage';
import { signEventWithActiveSigner } from '../../lib/nostrSigner';
const state = vi.hoisted(() => ({ capable: true, manual: false, pubkey: 'a'.repeat(64), logout: vi.fn(), props: {} as Record<string, unknown> }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ pubkey: state.pubkey, logout: state.logout }) }));
vi.mock('../../hooks/useNostrRelay', () => ({ useNostrRelay: () => ({ notes: [], profiles: new Map(), reactions: new Map() }) }));
vi.mock('../../hooks/useThreadCards', () => ({ useThreadCards: () => ({ filteredNotes: [], threadCards: [] }) }));
vi.mock('../../hooks/useRecentEmojis', () => ({ useRecentEmojis: () => ({ recentEmojis: [], addEmoji: vi.fn() }) }));
vi.mock('../../lib/nostrSigner', () => ({ signEventWithActiveSigner: vi.fn() }));
vi.mock('../canvas/nativeCanvasCapability', () => ({ useNativeCanvasCapability: () => state.capable }));
vi.mock('../canvas/manualDOMPreference', () => ({ useManualDOMPreference: () => state.manual }));
vi.mock('../LiveCanvas', () => ({ LiveCanvas: (props: { onLogout: () => void }) => {
  state.props = props;
  return <><MediaImage src="https://images.example.test/fixture.png" alt="modal画像" /><button onClick={props.onLogout}>ログアウト</button></>;
} }));
beforeEach(() => { state.capable = true; state.manual = false; state.pubkey = 'a'.repeat(64); state.logout.mockClear(); vi.stubGlobal('fetch', vi.fn()); vi.mocked(signEventWithActiveSigner).mockClear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('通常HomeのCORS画像と描画方式', () => {
  it.each([[true, false, true], [false, false, false], [true, true, false]])('capability=%s manual=%s → native=%s、画像署名不要', async (capable, manual, native) => {
    state.capable = capable; state.manual = manual;
    render(<><Home /></>);
    expect(state.props.nativeEnabled).toBe(native);

    expect(state.props.settingsContent).toBeUndefined();
    expect(screen.getByAltText('modal画像').getAttribute('crossorigin')).toBe('anonymous');

    await Promise.resolve();
    fireEvent.click(screen.getByRole('button', { name: 'ログアウト' }));
    expect(state.logout).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled(); expect(signEventWithActiveSigner).not.toHaveBeenCalled();
  });
  it('未ログイン時に画像署名の予告を出さない', () => {
    state.pubkey = '';
    render(<Home />);

    expect(screen.queryByText(/本人確認署名を署名器へ依頼/)).toBeNull();
    expect(fetch).not.toHaveBeenCalled(); expect(signEventWithActiveSigner).not.toHaveBeenCalled();
  });
  it('対応ブラウザの全ユーザーにnativeを有効化する', () => {
    render(<Home />);
    expect(state.props.nativeEnabled).toBe(true);

    expect(screen.queryByLabelText('CORS画像実験')).toBeNull();
  });
});
