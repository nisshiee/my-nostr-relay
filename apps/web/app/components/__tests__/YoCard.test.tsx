// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { YoCard as YoCardType } from "../../lib/types";
import { YoCard } from "../YoCard";

const card: YoCardType = {
  type: "yo",
  eventId: "b".repeat(64),
  pubkey: "12345678" + "0".repeat(52) + "abcd",
  slotId: "yo-slot",
  score: 0,
  created_at: 1700000000,
};

afterEach(cleanup);

describe("YoCard", () => {
  it("Yoと送信者と時刻を表示し、送信者のプロフィールを開く", () => {
    const onOpenProfile = vi.fn();
    const { container } = render(
      <YoCard card={card} profile={{ display_name: "送信者" }} onOpenProfile={onOpenProfile} />,
    );

    expect(screen.getByText("Yo")).toBeTruthy();
    expect(container.querySelector("time")?.dateTime).toBe("2023-11-14T22:13:20.000Z");
    fireEvent.click(screen.getByRole("button", { name: "送信者のプロフィールを開く" }));
    expect(onOpenProfile).toHaveBeenCalledExactlyOnceWith(card.pubkey);
  });

  it("画像URLがなければ固定Yoを表示し、プロフィール未取得でも短縮pubkeyを表示する", () => {
    const { container } = render(<YoCard card={card} onOpenProfile={vi.fn()} />);

    expect(screen.getByText("Yo")).toBeTruthy();
    expect(screen.getByRole("button", { name: "12345678…abcdのプロフィールを開く" })).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });

  it("読み込めた絵文字を固定Yoの代わりに表示する", () => {
    const { container } = render(<YoCard card={{ ...card, emojiUrl: "https://example.test/yo.png" }} onOpenProfile={vi.fn()} />);
    const image = container.querySelector("img")!;
    expect(image.getAttribute("crossorigin")).toBe("anonymous");
    expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(screen.getByText("Yo")).toBeTruthy();
    fireEvent.load(image);
    expect(screen.queryByText("Yo")).toBeNull();
    expect(screen.getByRole("img", { name: "Yo" })).toBe(image);
  });

  it("読み込み失敗や利用できないURLなら固定Yoを表示する", () => {
    const onOpenProfile = vi.fn();
    const { container, rerender } = render(<YoCard card={{ ...card, emojiUrl: "https://example.test/missing.png" }} onOpenProfile={onOpenProfile} />);
    fireEvent.error(container.querySelector("img")!);
    expect(screen.getByText("Yo")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    rerender(<YoCard card={{ ...card, emojiUrl: "https://localhost/yo.png" }} onOpenProfile={onOpenProfile} />);
    expect(screen.getByText("Yo")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });
});
