// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getManualDOMPreference, setManualDOMPreference, subscribeManualDOMPreference, serverManualDOMPreference, MANUAL_DOM_STORAGE_KEY } from '../manualDOMPreference';
afterEach(()=>{vi.restoreAllMocks();setManualDOMPreference(false);localStorage.clear();});
describe('互換表示の共有保存設定',()=>{
  it('保存値を共有しSSRは固定false、未知値はfalse',()=>{
    setManualDOMPreference(true);expect(getManualDOMPreference()).toBe(true);expect(localStorage.getItem(MANUAL_DOM_STORAGE_KEY)).toBe('true');expect(serverManualDOMPreference()).toBe(false);
    localStorage.setItem(MANUAL_DOM_STORAGE_KEY,'unknown');expect(getManualDOMPreference()).toBe(false);
  });
  it('同tab/別tabの変更通知とcleanup',()=>{
    const notify=vi.fn(),stop=subscribeManualDOMPreference(notify);setManualDOMPreference(true);window.dispatchEvent(new StorageEvent('storage',{key:MANUAL_DOM_STORAGE_KEY}));expect(notify).toHaveBeenCalledTimes(2);stop();setManualDOMPreference(false);expect(notify).toHaveBeenCalledTimes(2);
  });
  it('保存不可でも選択を保持する',()=>{
    vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('quota');});setManualDOMPreference(true);expect(getManualDOMPreference()).toBe(true);
  });
});
