// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { YoCard as YoCardType } from "../../lib/types";
import { YoCard } from "../YoCard";

const card: YoCardType = {
  type: "yo",
  direction: "incoming",
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

  it("送信中の連打を防ぎ、成功後はそのカードから再送しない", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const send = vi.fn(() => promise);
    render(<YoCard card={card} profile={{ name: "相手" }} onOpenProfile={vi.fn()} onSendYo={send} />);
    const button = screen.getByRole("button", { name: "相手にYoを返す" }) as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    resolve();
    const sent = await screen.findByRole<HTMLButtonElement>("button", { name: "送信済み" });
    expect(sent.disabled).toBe(true);
    fireEvent.click(sent);
    expect(send).toHaveBeenCalledExactlyOnceWith(card.pubkey);
  });

  it("送信に失敗したらカードに表示し、同じボタンからやり直せる", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("relay unavailable")).mockResolvedValueOnce(undefined);
    render(<YoCard card={card} profile={{ name: "相手" }} onOpenProfile={vi.fn()} onSendYo={send} />);
    fireEvent.click(screen.getByRole("button", { name: "相手にYoを返す" }));
    expect((await screen.findByRole("alert")).textContent).toContain("送信できませんでした");
    fireEvent.click(screen.getByRole("button", { name: "相手にYoを返す" }));
    expect(await screen.findByRole("button", { name: "送信済み" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(send.mock.calls).toEqual([[card.pubkey], [card.pubkey]]);
  });
});
