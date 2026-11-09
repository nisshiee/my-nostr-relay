// @vitest-environment jsdom

import React, { useEffect, useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasScene } from "../CanvasScene";

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

beforeEach(() => {
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600,
    toJSON() { return {}; },
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function flushFrame() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  });
}

function InteractiveCard({ focus = false }: { focus?: boolean }) {
  const [text, setText] = useState("");
  const [count, setCount] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (focus) input.current?.focus(); }, [focus]);
  return <div>
    <input ref={input} aria-label="下書き" value={text} onChange={event => setText(event.target.value)} />
    <button onClick={() => setCount(value => value + 1)}>クリック {count}</button>
  </div>;
}

describe("CanvasScene DOM操作とAPI失敗時の回復", () => {
  it("DOM fallback内の実際のボタンがReactハンドラを呼ぶ", () => {
    render(<CanvasScene items={[{ id: "one", content: <InteractiveCard /> }]} />);
    flushFrame();
    expect(screen.getByRole("status").textContent).toContain("DOM fallback");
    fireEvent.click(screen.getByRole("button", { name: "クリック 0" }));
    expect(screen.getByRole("button", { name: "クリック 1" })).toBeDefined();
  });

  it("手動切替の往復でもportalの入力ノード・入力値・選択範囲を維持する", () => {
    render(<CanvasScene items={[{ id: "one", content: <InteractiveCard /> }]} />);
    flushFrame();
    const input = screen.getByRole("textbox", { name: "下書き" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "保存する入力" } });
    act(() => input.focus());
    input.setSelectionRange(1, 4);
    fireEvent.click(screen.getByRole("button", { name: "DOMに切替" }));
    flushFrame();
    expect(screen.getByRole("textbox")).toBe(input);
    expect(input.value).toBe("保存する入力");
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 4]);
    fireEvent.click(screen.getByRole("button", { name: "Nativeを試す" }));
    flushFrame();
    expect(screen.getByRole("textbox")).toBe(input);
    expect(input.value).toBe("保存する入力");
  });

  it("後から追加したカードはfocus effectが実行される前に接続される", () => {
    const { rerender } = render(<CanvasScene items={[]} />);
    flushFrame();
    rerender(<CanvasScene items={[{ id: "draft", content: <InteractiveCard focus /> }]} />);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "下書き" }));
    flushFrame();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "下書き" }));
  });

  it("モックnative APIの描画例外でDOMへ戻し、カードを操作できる", () => {
    // APIを明示的に模倣する単体テスト。実ブラウザのnative描画検証ではない。
    const draw = vi.fn(() => { throw new Error("unsupported draw"); });
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
      resetTransform: vi.fn(), clearRect: vi.fn(), setTransform: vi.fn(), drawElementImage: draw,
    } as unknown as CanvasRenderingContext2D);
    const original = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "requestPaint");
    Object.defineProperty(HTMLCanvasElement.prototype, "requestPaint", {
      configurable: true,
      value(this: HTMLCanvasElement) { this.dispatchEvent(new Event("paint")); },
    });
    try {
      render(<CanvasScene items={[{ id: "one", content: <InteractiveCard /> }]} />);
      flushFrame();
      flushFrame();
      expect(draw).toHaveBeenCalled();
      expect(screen.getByRole("status").textContent).toContain("DOM fallback");
      expect(document.querySelector("canvas")!.hidden).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "クリック 0" }));
      expect(screen.getByRole("button", { name: "クリック 1" })).toBeDefined();
    } finally {
      if (original) Object.defineProperty(HTMLCanvasElement.prototype, "requestPaint", original);
      else Reflect.deleteProperty(HTMLCanvasElement.prototype, "requestPaint");
    }
  });
});
