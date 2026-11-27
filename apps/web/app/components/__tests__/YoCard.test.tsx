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

  it("プロフィール未取得でも短縮pubkeyを表示し、Yoを外部画像に依存させない", () => {
    const { container } = render(<YoCard card={card} onOpenProfile={vi.fn()} />);

    expect(screen.getByText("Yo")).toBeTruthy();
    expect(screen.getByRole("button", { name: "12345678…abcdのプロフィールを開く" })).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });
});
