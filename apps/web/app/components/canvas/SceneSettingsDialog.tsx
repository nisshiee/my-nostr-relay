"use client";

import { useLayoutEffect, useRef, useId, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/** 描画面の外に置き、カード状態を保ったまま設定のfocusだけを管理する。 */
export function SceneSettingsDialog({ children, onClose, trigger }: { children: ReactNode; onClose: () => void; trigger: RefObject<HTMLButtonElement | null> }) {
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    const node = dialog.current!;
    const returnTarget = trigger.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusables = () => Array.from(node.querySelectorAll<HTMLElement>('button,select,input,a[href],summary,[tabindex]')).filter(element => {
      if (element.matches(':disabled') || element.tabIndex < 0 || element.hidden || element.closest('[hidden]')) return false;
      const details = element.closest('details');
      return !details || details.open || element.tagName === 'SUMMARY';
    });
    (focusables()[0] ?? node).focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
      if (event.key !== 'Tab') return;
      const elements = focusables(), first = elements[0], last = elements.at(-1);
      if (!first) { event.preventDefault(); node.focus(); return; }
      if (!node.contains(document.activeElement) || event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
        event.preventDefault(); (event.shiftKey ? last! : first).focus();
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      document.body.style.overflow = previousOverflow;
      if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true });
    };
  }, [onClose, trigger]);
  return createPortal(<div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4" data-settings-backdrop onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-xl border border-zinc-200 bg-white p-5 text-sm text-zinc-800 shadow-xl dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100">
      <div className="mb-5 flex items-center justify-between"><h2 id={titleId} className="text-lg font-semibold">表示設定</h2><button type="button" onClick={onClose} aria-label="設定を閉じる" className="rounded border px-3 py-1">閉じる</button></div>
      {children}
    </div>
  </div>, document.body);
}
