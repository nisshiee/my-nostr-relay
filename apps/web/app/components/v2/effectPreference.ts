export type SceneEffectChoice = 'off' | 'sparkle' | 'domino';
export const EFFECT_STORAGE_KEY = 'nlc-v2-effect';
const EVENT = 'nlc-v2-effect-change';
let memoryChoice: SceneEffectChoice = 'sparkle';
let memoryOnly = false;
const valid = (value: unknown): value is SceneEffectChoice => value === 'off' || value === 'sparkle' || value === 'domino';

/** 保存不可の環境でも同じタブ内では選択を維持する。SSRは固定値でhydrationを揃える。 */
export function getEffectPreference(): SceneEffectChoice {
  if (memoryOnly) return memoryChoice;
  try {
    const value = window.localStorage.getItem(EFFECT_STORAGE_KEY);
    return valid(value) ? value : 'sparkle';
  } catch { return memoryChoice; }
}
export const serverEffectPreference = (): SceneEffectChoice => 'sparkle';
export function subscribeEffectPreference(notify: () => void): () => void {
  const storage = (event: StorageEvent) => { if (event.key === EFFECT_STORAGE_KEY || event.key === null) notify(); };
  window.addEventListener(EVENT, notify);
  window.addEventListener('storage', storage);
  return () => { window.removeEventListener(EVENT, notify); window.removeEventListener('storage', storage); };
}
export function setEffectPreference(value: SceneEffectChoice): void {
  memoryChoice = value;
  try { window.localStorage.setItem(EFFECT_STORAGE_KEY, value); memoryOnly = false; } catch { memoryOnly = true; }
  window.dispatchEvent(new Event(EVENT));
}
