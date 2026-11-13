"use client";

import { useSyncExternalStore } from 'react';
export const MANUAL_DOM_STORAGE_KEY = 'nlc-v2-manual-dom';
const EVENT = 'nlc-v2-manual-dom-change';
let memoryValue = false, memoryOnly = false;
export function getManualDOMPreference(): boolean {
  if (memoryOnly) return memoryValue;
  try { return window.localStorage.getItem(MANUAL_DOM_STORAGE_KEY) === 'true'; } catch { return memoryValue; }
}
export const serverManualDOMPreference = () => false;
export function subscribeManualDOMPreference(notify: () => void): () => void {
  const storage = (event: StorageEvent) => { if (event.key === MANUAL_DOM_STORAGE_KEY || event.key === null) notify(); };
  window.addEventListener(EVENT, notify);window.addEventListener('storage', storage);
  return () => { window.removeEventListener(EVENT, notify);window.removeEventListener('storage', storage); };
}
export function setManualDOMPreference(value: boolean): void {
  memoryValue = value;
  try { window.localStorage.setItem(MANUAL_DOM_STORAGE_KEY, String(value)); memoryOnly = false; } catch { memoryOnly = true; }
  window.dispatchEvent(new Event(EVENT));
}
export function useManualDOMPreference(): boolean { return useSyncExternalStore(subscribeManualDOMPreference, getManualDOMPreference, serverManualDOMPreference); }
