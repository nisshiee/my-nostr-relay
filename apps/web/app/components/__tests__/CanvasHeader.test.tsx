// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasHeader } from "../CanvasHeader";

afterEach(cleanup);

function renderHeader(profile?: { display_name?: string; picture?: string }) {
  const onOpenProfile = vi.fn();
  const view = render(
    <CanvasHeader
      status="connected"
      pubkey="abcdef1234567890"
      profile={profile}
      onOpenProfile={onOpenProfile}
      onAddDraft={vi.fn()}
      onLogout={vi.fn()}
      showSignerControl={false}
      onManageSigner={vi.fn()}
    />,
  );
  return { ...view, onOpenProfile };
}

describe("CanvasHeader の認証ユーザーアイコン", () => {
  it("kind 0 のプロフィール画像を表示し、クリックで投稿一覧を開く", () => {
    const { container, onOpenProfile } = renderHeader({
      display_name: "Alice",
      picture: "https://example.com/alice.png",
    });

    expect(container.querySelector('img[src="https://example.com/alice.png"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Aliceの投稿一覧を開く" }));
    expect(onOpenProfile).toHaveBeenCalledOnce();
  });

  it("プロフィール画像が未取得または未設定ならカードと同じ頭文字を表示する", () => {
    const { rerender } = renderHeader();
    expect(screen.getByText("A")).toBeDefined();

    rerender(
      <CanvasHeader
        status="connected"
        pubkey="abcdef1234567890"
        profile={{ display_name: "Nisshiee" }}
        onOpenProfile={vi.fn()}
        onAddDraft={vi.fn()}
        onLogout={vi.fn()}
        showSignerControl={false}
        onManageSigner={vi.fn()}
      />,
    );
    expect(screen.getByText("N")).toBeDefined();
  });

  it("プロフィール画像の読込失敗時も頭文字へフォールバックする", () => {
    const { container } = renderHeader({
      display_name: "Alice",
      picture: "https://example.com/broken.png",
    });
    const image = container.querySelector('img[src="https://example.com/broken.png"]');
    expect(image).not.toBeNull();

    fireEvent.error(image!);

    expect(container.querySelector('img[src="https://example.com/broken.png"]')).toBeNull();
    expect(screen.getByText("A")).toBeDefined();
  });

  it("表示できないプロフィール画像URLも頭文字へフォールバックする", () => {
    const { container } = renderHeader({
      display_name: "Alice",
      picture: "http://example.com/insecure.png",
    });

    expect(container.querySelector('img[src="http://example.com/insecure.png"]')).toBeNull();
    expect(screen.getByText("A")).toBeDefined();
  });
});
