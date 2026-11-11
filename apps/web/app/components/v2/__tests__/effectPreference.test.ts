// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EFFECT_STORAGE_KEY, getEffectPreference, serverEffectPreference, setEffectPreference, subscribeEffectPreference } from '../effectPreference';

afterEach(() => { vi.restoreAllMocks(); setEffectPreference('sparkle'); localStorage.clear(); });
describe('V2エフェクト選択', () => {
  it('SSRは固定値で、未知の保存値は従来のキラキラへ戻す', () => {
    localStorage.setItem(EFFECT_STORAGE_KEY, 'unknown');
    expect(getEffectPreference()).toBe('sparkle');
    setEffectPreference('domino');
    expect(serverEffectPreference()).toBe('sparkle');
    expect(getEffectPreference()).toBe('domino');
  });
  it('同タブの変更と別タブのstorage変更を購読しcleanupする', () => {
    const notify = vi.fn();
    const cleanup = subscribeEffectPreference(notify);
    setEffectPreference('off');
    expect(notify).toHaveBeenCalledOnce();
    window.dispatchEvent(new StorageEvent('storage',{key:EFFECT_STORAGE_KEY}));
    expect(notify).toHaveBeenCalledTimes(2);
    cleanup(); setEffectPreference('sparkle');
    expect(notify).toHaveBeenCalledTimes(2);
  });
  it('容量超過で保存できなくても現在の選択は操作できる', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(()=>{throw new Error('quota');});
    setEffectPreference('domino'); expect(getEffectPreference()).toBe('domino');
    setEffectPreference('off'); expect(getEffectPreference()).toBe('off');
  });
});
