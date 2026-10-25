// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageLightbox } from "../ImageLightbox";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ImageLightbox", () => {
  it("実Framer Motionで描画し、画像移動とEscapeを処理する", () => {
    const onClose = vi.fn();
    render(
      <ImageLightbox
        images={["https://example.com/first.jpg", "https://example.com/second.jpg"]}
        currentIndex={0}
        onClose={onClose}
      />,
    );

    const image = screen.getByRole("img", { name: "拡大画像" });
    const overlay = image.parentElement;
    expect(overlay?.style.opacity).toBe("0");
    expect(image.getAttribute("src")).toBe("https://example.com/first.jpg");

    fireEvent.click(screen.getByRole("button", { name: "次の画像" }));
    expect(image.getAttribute("src")).toBe("https://example.com/second.jpg");

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(image.getAttribute("src")).toBe("https://example.com/first.jpg");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("閉じるボタンを処理する", () => {
    const onClose = vi.fn();
    render(
      <ImageLightbox
        images={["https://example.com/image.jpg"]}
        currentIndex={0}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
