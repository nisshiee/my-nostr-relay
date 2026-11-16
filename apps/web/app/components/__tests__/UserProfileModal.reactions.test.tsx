// @vitest-environment jsdom
import React, { type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Event } from "nostr-tools/core";
import { UserProfileModal } from "../UserProfileModal";
import type { ReactionLoadState } from "../../hooks/useNostrReactions";
import { reactionKey } from "../../lib/reactions";

vi.mock("../NoteCardContent", () => ({
  NoteCardContent: ({ note }: { note: Event }) => <p>{note.content}</p>,
  resolveProfileDisplayName: () => "テストユーザー",
}));
const author = "a".repeat(64);
const me = "b".repeat(64);
const note: Event = { id: "c".repeat(64), pubkey: author, kind: 1, content: "古い投稿", created_at: 1, tags: [], sig: "" };
function props(): ComponentProps<typeof UserProfileModal> {
  return {
    pubkey: author, isOpen: true, onClose: vi.fn(), fetchProfiles: vi.fn(),
    fetchUserRecentNotes: vi.fn(async () => [note]), cache: {} as ComponentProps<typeof UserProfileModal>["cache"],
    profiles: new Map(), isFollowing: false, follow: vi.fn(), unfollow: vi.fn(),
    reactions: new Map([[note.id, new Map([[reactionKey("👍"), { emoji: "👍", count: 2, pubkeys: new Set(["d".repeat(64)]) }]])]]),
    myPubkey: me, sendReaction: vi.fn(async () => {}),
    recentEmojis: [{ emoji: "❤️" }, { emoji: ":wave:", imageUrl: "https://example.test/wave.png" }],
    emojiSets: [], looseEmojis: [],
    watchReactions: vi.fn((_ids, onState) => { onState("loading"); return vi.fn(); }),
  };
}
afterEach(() => { cleanup(); vi.useRealTimers(); document.body.style.overflow = ""; });

describe("プロフィール内のリアクション", () => {
  it("取得済みバッジを表示し、送信中の連打を防いで失敗後に再試行できる", async () => {
    const p = props();
    let reject!: (error: Error) => void;
    p.sendReaction = vi.fn(() => new Promise<void>((_resolve, r) => { reject = r; }));
    render(<UserProfileModal {...p} />);
    const badge = await screen.findByRole("button", { name: "👍 2件" });
    expect(p.watchReactions).toHaveBeenCalledWith([note.id], expect.any(Function));
    fireEvent.click(badge); fireEvent.click(badge);
    expect(p.sendReaction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "リアクションを追加" }).hasAttribute("disabled")).toBe(true);
    await act(async () => reject(new Error("Mock送信失敗")));
    expect(screen.getByRole("alert").textContent).toBe("Mock送信失敗");
    fireEvent.click(badge);
    expect(p.sendReaction).toHaveBeenCalledTimes(2);
  });

  it.each(["❤️", ":wave:"])("pickerから%sを共通送信ハンドラに渡し、モーダルを維持する", async emoji => {
    const p = props(); render(<UserProfileModal {...p} />);
    await screen.findByText("古い投稿");
    fireEvent.click(screen.getByRole("button", { name: "リアクションを追加" }));
    const picker = screen.getByRole("dialog", { name: "絵文字を選択" });
    expect(Number(picker.style.zIndex)).toBeGreaterThan(9999);
    fireEvent.click(within(picker).getByRole("button", { name: emoji }));
    await act(async () => {});
    expect(p.sendReaction).toHaveBeenCalledWith(note.id, author, emoji, emoji === ":wave:" ? "https://example.test/wave.png" : undefined);
    expect(p.onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "絵文字を選択" })).toBeNull();
  });

  it("Escapeはpickerだけを閉じ、次のEscapeでプロフィールを閉じる", async () => {
    const p = props(); render(<UserProfileModal {...p} />);
    await screen.findByText("古い投稿");
    const trigger = screen.getByRole("button", { name: "リアクションを追加" });
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "絵文字を選択" })).toBeNull();
    expect(p.onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(p.onClose).toHaveBeenCalledOnce();
  });

  it("閉じる・ユーザー切替で購読を解除し、開き直しで新しく購読する", async () => {
    const p = props(); const stops: ReturnType<typeof vi.fn>[] = [];
    p.watchReactions = vi.fn((_ids, onState) => { onState("settled"); const stop = vi.fn(); stops.push(stop); return stop; });
    document.body.style.overflow = "clip";
    const view = render(<UserProfileModal {...p} />);
    await screen.findByText("古い投稿");
    view.rerender(<UserProfileModal {...p} isOpen={false} />);
    expect(stops[0]).toHaveBeenCalledOnce();
    expect(document.body.style.overflow).toBe("clip");
    view.rerender(<UserProfileModal {...p} />);
    await screen.findByText("古い投稿");
    expect(p.watchReactions).toHaveBeenCalledTimes(2);
    view.rerender(<UserProfileModal {...p} pubkey={"e".repeat(64)} />);
    await act(async () => {});
    expect(stops[1]).toHaveBeenCalledOnce();
    expect(p.watchReactions).toHaveBeenCalledTimes(3);
  });

  it("全取得状態で説明文・再試行・専用領域を表示せず、バッジを維持する", async () => {
    const p = props(); let update!: (state: ReactionLoadState) => void;
    p.watchReactions = vi.fn((_ids, onState) => { update = onState; onState("loading"); return vi.fn(); });
    render(<UserProfileModal {...p} />);
    await screen.findByText("古い投稿");
    expect(screen.queryByText(/リアクションを取得中/)).toBeNull();
    expect(screen.getByRole("button", { name: "👍 2件" })).toBeTruthy();
    await waitFor(() => expect(p.watchReactions).toHaveBeenCalledTimes(1));
    act(() => update("error"));
    expect(screen.queryByText(/リアクションを取得できない場合/)).toBeNull();
    expect(screen.queryByText(/表示中の件数は取得できた分/)).toBeNull();
    expect(screen.getByRole("button", { name: "👍 2件" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "再試行" })).toBeNull();
    expect(p.watchReactions).toHaveBeenCalledTimes(1);
    act(() => update("settled"));
    expect(screen.queryByText("取得できたリアクションを表示しています。")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    const heading = screen.getByText("Recent notes").parentElement!;
    expect(heading.nextElementSibling?.textContent).toContain("古い投稿");
    expect(screen.getByRole("button", { name: "👍 2件" })).toBeTruthy();
  });

  it("tooltipはモーダルより上に表示し、Escapeとスクロールで閉じる", async () => {
    const p = props(); render(<UserProfileModal {...p} />);
    const badge = await screen.findByRole("button", { name: "👍 2件" });
    vi.useFakeTimers();
    fireEvent.mouseEnter(badge);
    act(() => vi.advanceTimersByTime(550));
    expect(Number(screen.getByRole("tooltip").style.zIndex)).toBeGreaterThan(9999);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(p.onClose).not.toHaveBeenCalled();
    fireEvent.mouseEnter(badge);
    act(() => vi.advanceTimersByTime(550));
    fireEvent.scroll(screen.getByText("Recent notes").parentElement!.parentElement!);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
