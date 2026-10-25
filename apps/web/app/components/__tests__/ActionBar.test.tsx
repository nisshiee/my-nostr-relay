// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionBar } from "../ActionBar";

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        const height = target.hasAttribute("frimousse-viewport") ? 243 : 32;
        this.callback(
          [
            {
              target,
              contentRect: {
                width: 320,
                height,
              },
              borderBoxSize: [{ inlineSize: 320, blockSize: height }],
            } as unknown as ResizeObserverEntry,
          ],
          this as unknown as ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderActionBar() {
  const onEmojiSelect = vi.fn();
  const onPickerOpenChange = vi.fn();
  const onReply = vi.fn();

  const result = render(
    <ActionBar
      isOpen
      onReply={onReply}
      onThumbsUp={vi.fn()}
      isAlreadyReacted={false}
      onRepost={vi.fn()}
      isAlreadyReposted={false}
      onQuote={vi.fn()}
      onEmojiSelect={onEmojiSelect}
      onPickerOpenChange={onPickerOpenChange}
      recentEmojis={[{ emoji: "😀" }]}
    />,
  );

  return { ...result, onEmojiSelect, onPickerOpenChange, onReply };
}

describe("ActionBar", () => {
  it("Lucideアイコンを描画し、各操作を呼び出す", () => {
    const { container, onReply } = renderActionBar();

    expect(container.querySelectorAll("svg.lucide")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "返信" }));
    expect(onReply).toHaveBeenCalledOnce();
  });

  it("最近使った絵文字を選択してピッカーを閉じる", () => {
    const { onEmojiSelect, onPickerOpenChange } = renderActionBar();

    fireEvent.click(
      screen.getByRole("button", { name: "絵文字ピッカーを開く" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "😀" }));

    expect(onEmojiSelect).toHaveBeenCalledWith("😀", undefined);
    expect(onPickerOpenChange.mock.calls).toEqual([[true], [false]]);
    expect(document.querySelector("[data-emoji-picker-popover]")).toBeNull();
  });

  it("Unicodeタブで実Frimousseから絵文字を選択して閉じる", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const data = url.endsWith("/data.json")
          ? [
              {
                emoji: "😀",
                label: "grinning face",
                group: 0,
                subgroup: 0,
                version: 1,
                tags: ["smile"],
              },
            ]
          : {
              groups: [
                { key: "smileys-emotion", message: "smileys", order: 0 },
              ],
              subgroups: [
                { key: "face-smiling", message: "face smiling", order: 0 },
              ],
              skinTones: [
                { key: "light", message: "light" },
                { key: "medium-light", message: "medium light" },
                { key: "medium", message: "medium" },
                { key: "medium-dark", message: "medium dark" },
                { key: "dark", message: "dark" },
              ],
            };

        return {
          headers: new Headers(),
          json: async () => data,
        } as Response;
      }),
    );
    const { onEmojiSelect, onPickerOpenChange } = renderActionBar();

    fireEvent.click(
      screen.getByRole("button", { name: "絵文字ピッカーを開く" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Unicode絵文字" }),
    );

    expect(
      screen.getByPlaceholderText("絵文字を検索...").getAttribute("placeholder"),
    ).toBe("絵文字を検索...");

    await waitFor(() => {
      expect(document.querySelector("[frimousse-root]")?.textContent).toContain(
        "😀",
      );
    });
    fireEvent.click(
      screen.getByRole("gridcell", { name: "Grinning face" }),
    );
    await waitFor(() => {
      expect(onEmojiSelect).toHaveBeenCalledWith("😀", undefined);
    });
    expect(onPickerOpenChange.mock.calls.at(-1)).toEqual([false]);
    expect(document.querySelector("[data-emoji-picker-popover]")).toBeNull();
  });

  it("Escapeで絵文字ピッカーをキャンセルする", () => {
    const { onEmojiSelect, onPickerOpenChange } = renderActionBar();

    fireEvent.click(
      screen.getByRole("button", { name: "絵文字ピッカーを開く" }),
    );
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onEmojiSelect).not.toHaveBeenCalled();
    expect(onPickerOpenChange.mock.calls.at(-1)).toEqual([false]);
    expect(document.querySelector("[data-emoji-picker-popover]")).toBeNull();
  });

  it("ピッカー外のクリックで閉じる", () => {
    const { onPickerOpenChange } = renderActionBar();

    fireEvent.click(
      screen.getByRole("button", { name: "絵文字ピッカーを開く" }),
    );
    fireEvent.mouseDown(document.body);

    expect(onPickerOpenChange.mock.calls.at(-1)).toEqual([false]);
    expect(document.querySelector("[data-emoji-picker-popover]")).toBeNull();
  });
});
